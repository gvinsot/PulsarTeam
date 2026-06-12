import express from 'express';
import { storeOAuthToken } from '../services/database.js';
import type { OAuthProvider } from '../services/database.js';
import { resolveScope } from './oauthHelper.js';

/**
 * Shared OAuth authorization-code exchange engine for the Google and
 * Microsoft callback dispatchers (routes/googleOAuth.ts, routes/microsoftOAuth.ts).
 *
 * Both providers follow the same flow: provider-error guard → code/state
 * guard → consume state → config guard → form-urlencoded code exchange with a
 * 15s timeout → profile-email fetch → resolveScope → storeOAuthToken
 * (throwOnPersistError) → result page. What differs (token endpoint, profile
 * endpoint, meta payload, postMessage strategy) lives in the hooks.
 *
 * The postMessage payloads are wire format for the frontend connect widgets —
 * which is why sendSuccess/sendError stay fully provider-owned.
 *
 * github.ts and slack.ts share the skeleton but NOT the semantics (different
 * guard order, JSON body + retry for GitHub, data.ok keying for Slack) — they
 * are intentionally not consumers of this engine.
 */

/**
 * Which guard failed. Early stages (provider_error, missing_params, bad_state)
 * happen before the state is consumed, so `consumed` is null there; Microsoft
 * uses the stage to decide when its unverified peek may tag the error popup
 * with a service (deliberately NOT on bad_state).
 */
export type OAuthCallbackErrorStage =
  | 'provider_error'
  | 'missing_params'
  | 'bad_state'
  | 'not_configured'
  | 'exchange_failed'
  | 'internal';

export interface OAuthCallbackHooks<
  S extends { service: OAuthProvider; username: string; agentId: string | null; boardId: string | null },
  C extends { clientId: string; clientSecret: string },
> {
  consumeState(state: string): S | null;
  getConfig(): C | null;
  /** Exact error message sent when getConfig() returns null — wire format. */
  notConfiguredError: string;
  tokenUrl(state: S, config: C): string;
  /** GOOGLE_/MICROSOFT_PLUGIN_REDIRECT_PATH — redirect_uri is re-derived from the request. */
  redirectPath: string;
  /** Log prefix: Google logs the service ('gmail'/'gdrive'), Microsoft its provider label. */
  logLabel(state: S): string;
  fetchProfileEmail(accessToken: string, state: S): Promise<string | null>;
  buildMeta(state: S, email: string | null): Record<string, unknown>;
  /** Each provider keeps its exact postMessage type/field strategy here. */
  sendSuccess(res: express.Response, state: S, email: string | null): void;
  sendError(
    res: express.Response,
    stage: OAuthCallbackErrorStage,
    consumed: S | null,
    rawState: string | undefined,
    error: string,
  ): void;
}

export async function runOAuthCodeExchange<
  S extends { service: OAuthProvider; username: string; agentId: string | null; boardId: string | null },
  C extends { clientId: string; clientSecret: string },
>(req: express.Request, res: express.Response, hooks: OAuthCallbackHooks<S, C>): Promise<void> {
  const err = req.query.error as string | undefined;
  const state = req.query.state as string | undefined;
  if (err) {
    const desc = (req.query.error_description as string | undefined) || err;
    return hooks.sendError(res, 'provider_error', null, state, String(desc));
  }

  const code = req.query.code as string | undefined;
  if (!code || !state) {
    return hooks.sendError(res, 'missing_params', null, state, 'Missing code or state parameter');
  }

  const stateData = hooks.consumeState(state);
  if (!stateData) {
    return hooks.sendError(res, 'bad_state', null, state, 'Invalid or expired state. Please try again.');
  }

  const config = hooks.getConfig();
  if (!config) {
    return hooks.sendError(res, 'not_configured', stateData, state, hooks.notConfiguredError);
  }

  try {
    // Must match the redirect_uri sent in the auth URL — derive the same way.
    const redirectUri = `${req.protocol}://${req.get('host')}${hooks.redirectPath}`;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch(hooks.tokenUrl(stateData, config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error(`[${hooks.logLabel(stateData)}] Token exchange failed:`, data);
      return hooks.sendError(
        res,
        'exchange_failed',
        stateData,
        state,
        'Token exchange failed: ' + (data.error_description || data.error || 'unknown'),
      );
    }

    const email = await hooks.fetchProfileEmail(data.access_token, stateData);
    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: stateData.service,
      scopeType,
      scopeId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      meta: hooks.buildMeta(stateData, email),
    }, { throwOnPersistError: true });

    console.log(`✅ [${hooks.logLabel(stateData)}] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'}) via redirect`);
    return hooks.sendSuccess(res, stateData, email);
  } catch (e) {
    console.error(`[${hooks.logLabel(stateData)}] OAuth redirect error:`, e);
    return hooks.sendError(res, 'internal', stateData, state, 'Internal error during token exchange');
  }
}
