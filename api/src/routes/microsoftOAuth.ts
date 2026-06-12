import express from 'express';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import type { MicrosoftOAuthConfig } from '../services/microsoftOAuthConfig.js';
import { sendOAuthResult } from './oauthHelper.js';
import { runOAuthCodeExchange } from './oauthCallback.js';
import { createOAuthStateStore } from './oauthState.js';

/**
 * Unified Microsoft OAuth callback handler.
 *
 * OneDrive, Outlook, and any future Microsoft Graph plugin share one OAuth
 * client (one Azure App registration) and one registered redirect URI. The
 * originating service is encoded in the `state` parameter so the callback
 * dispatcher can route the resulting tokens to the right provider in the
 * oauth_tokens table.
 *
 * Mirrors the Google OAuth pattern (api/src/routes/googleOAuth.ts).
 *
 * Mounted at /api/microsoft/oauth-redirect.
 */

export type MicrosoftService = 'onedrive' | 'outlook';

interface StateEntry {
  service: MicrosoftService;
  username: string;
  agentId: string | null;
  boardId: string | null;
  consumerFlow: boolean;
  expiresAt: number;
}

// HKDF domain 'microsoft' must stay byte-identical across deploys — see oauthState.ts.
const oauthStates = createOAuthStateStore<Omit<StateEntry, 'expiresAt'>>('microsoft');

export function generateMicrosoftOAuthState(
  service: MicrosoftService,
  username: string,
  agentId: string | null = null,
  boardId: string | null = null,
  consumerFlow: boolean = false,
): string {
  return oauthStates.generate({ service, username, agentId, boardId, consumerFlow });
}

export function consumeMicrosoftOAuthState(state: string): Omit<StateEntry, 'expiresAt'> | null {
  const entry = oauthStates.consume(state);
  if (!entry) return null;
  return {
    service: entry.service,
    username: entry.username,
    agentId: entry.agentId || null,
    boardId: entry.boardId || null,
    consumerFlow: !!entry.consumerFlow,
  };
}

async function fetchUserEmail(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const profile = await res.json();
      return profile.mail || profile.userPrincipalName || null;
    }
  } catch (err) {
    console.warn('[Microsoft] Could not fetch profile email:', (err as Error).message);
  }
  return null;
}

const PROVIDER_LABEL: Record<MicrosoftService, string> = {
  onedrive: 'OneDrive',
  outlook: 'Outlook',
};

const OAUTH_CALLBACK_MESSAGE_TYPE = 'microsoft-oauth-callback';

// Best-effort service recovery for errors that arrive before state
// verification, so the opener can route the message to the right widget.
// Reads the (signed) state payload without requiring a valid flow.
function peekServiceFromState(state: string | undefined): { service: MicrosoftService } | undefined {
  const entry = oauthStates.peek(state);
  if (entry?.service === 'onedrive' || entry?.service === 'outlook') return { service: entry.service };
  // untaggable — the popup itself still displays the error
  return undefined;
}

export async function handleMicrosoftOAuthCallback(req: express.Request, res: express.Response) {
  return runOAuthCodeExchange<Omit<StateEntry, 'expiresAt'>, MicrosoftOAuthConfig>(req, res, {
    consumeState: consumeMicrosoftOAuthState,
    getConfig: getMicrosoftOAuthConfig,
    notConfiguredError: 'Microsoft OAuth not configured on server',
    // Le token exchange DOIT se faire sur le même endpoint que l'auth: si la
    // popup d'autorisation a utilisé /consumers/, l'échange de code aussi —
    // sinon Microsoft renvoie AADSTS70000121 ("grant from personal account").
    tokenUrl: (state, config) =>
      `https://login.microsoftonline.com/${state.consumerFlow ? 'consumers' : config.tenantId}/oauth2/v2.0/token`,
    redirectPath: MICROSOFT_PLUGIN_REDIRECT_PATH,
    logLabel: (state) => PROVIDER_LABEL[state.service] || 'Microsoft',
    fetchProfileEmail: (accessToken) => fetchUserEmail(accessToken),
    buildMeta: (state, email) => ({ email, consumerFlow: state.consumerFlow || undefined }),
    sendSuccess: (res2, state, email) =>
      sendOAuthResult(res2, PROVIDER_LABEL[state.service] || 'Microsoft', OAUTH_CALLBACK_MESSAGE_TYPE, true, null, { service: state.service, email }),
    sendError: (res2, stage, consumed, rawState, error) => {
      if (consumed) {
        const providerLabel = PROVIDER_LABEL[consumed.service] || 'Microsoft';
        return sendOAuthResult(res2, providerLabel, OAUTH_CALLBACK_MESSAGE_TYPE, false, error, { service: consumed.service });
      }
      // Early errors: best-effort service recovery via the unverified peek so
      // the opener can route the popup message — EXCEPT on bad_state, which is
      // deliberately untagged so no widget claims it (the popup itself still
      // displays the error).
      const extra = stage === 'bad_state' ? undefined : peekServiceFromState(rawState);
      return sendOAuthResult(res2, 'Microsoft', OAUTH_CALLBACK_MESSAGE_TYPE, false, error, extra);
    },
  });
}

export function microsoftOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleMicrosoftOAuthCallback);
  return router;
}
