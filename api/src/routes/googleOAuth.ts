import express from 'express';
import crypto from 'crypto';
import { storeOAuthToken } from '../services/database.js';
import type { ScopeType } from '../services/database.js';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../services/googleOAuthConfig.js';

/**
 * Unified Google OAuth callback handler.
 *
 * Gmail, Drive, and any future Google API share one OAuth client and one
 * registered redirect URI. The originating service is encoded in the `state`
 * parameter so the callback handler can route the resulting tokens to the
 * right provider in the oauth_tokens table.
 *
 * The handler is mounted at:
 *   - /api/google/oauth-redirect   (preferred)
 *   - /api/gmail/oauth-redirect    (backward compat, same handler)
 *   - /api/gdrive/oauth-redirect   (backward compat, same handler)
 *   - /gmail-callback.html         (legacy Traefik route, same handler)
 *
 * Only one URI needs to be registered in the Google Cloud Console — the URL
 * path is irrelevant to the dispatch logic, only state.service is.
 */

export type GoogleService = 'gmail' | 'gdrive';

interface StateEntry {
  service: GoogleService;
  username: string;
  agentId: string | null;
  boardId: string | null;
  expiresAt: number;
}

const stateStore = new Map<string, StateEntry>();
const STATE_TTL_MS = 10 * 60 * 1000;

export function generateGoogleOAuthState(
  service: GoogleService,
  username: string,
  agentId: string | null = null,
  boardId: string | null = null,
): string {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (v.expiresAt < now) stateStore.delete(k);
  }
  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { service, username, agentId, boardId, expiresAt: now + STATE_TTL_MS });
  return state;
}

export function consumeGoogleOAuthState(state: string): Omit<StateEntry, 'expiresAt'> | null {
  const entry = stateStore.get(state);
  if (!entry) return null;
  stateStore.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return {
    service: entry.service,
    username: entry.username,
    agentId: entry.agentId,
    boardId: entry.boardId,
  };
}

function resolveScope(
  agentId: string | null,
  boardId: string | null,
  username: string,
): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
}

async function fetchUserEmail(service: GoogleService, accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (res.ok) {
      const profile = await res.json();
      return profile.email || null;
    }
  } catch (err) {
    console.warn(`[${service}] Could not fetch profile email:`, (err as Error).message);
  }
  return null;
}

function sendOAuthResult(
  res: express.Response,
  service: GoogleService | null,
  success: boolean,
  error?: string | null,
  email?: string | null,
) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`,
  );
  res.send(oauthResultPage(service, success, error, email, nonce));
}

export async function handleGoogleOAuthCallback(req: express.Request, res: express.Response) {
  const err = req.query.error as string | undefined;
  if (err) {
    const desc = (req.query.error_description as string | undefined) || err;
    return sendOAuthResult(res, null, false, String(desc));
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    return sendOAuthResult(res, null, false, 'Missing code or state parameter');
  }

  const stateData = consumeGoogleOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(res, null, false, 'Invalid or expired state. Please try again.');
  }

  const config = getGoogleOAuthConfig();
  if (!config) {
    return sendOAuthResult(res, stateData.service, false, 'Google OAuth not configured on server');
  }

  try {
    // Must match the redirect_uri sent in the auth URL — derive the same way.
    const redirectUri = `${req.protocol}://${req.get('host')}${GOOGLE_PLUGIN_REDIRECT_PATH}`;
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error(`[${stateData.service}] Token exchange failed:`, data);
      return sendOAuthResult(
        res,
        stateData.service,
        false,
        'Token exchange failed: ' + (data.error_description || data.error || 'unknown'),
      );
    }

    const email = await fetchUserEmail(stateData.service, data.access_token);
    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: stateData.service,
      scopeType,
      scopeId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      meta: { email },
    });

    console.log(`✅ [${stateData.service}] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'}) via redirect`);
    return sendOAuthResult(res, stateData.service, true, null, email);
  } catch (e) {
    console.error(`[${stateData.service}] OAuth redirect error:`, e);
    return sendOAuthResult(res, stateData.service, false, 'Internal error during token exchange');
  }
}

export function googleOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleGoogleOAuthCallback);
  return router;
}

function oauthResultPage(
  service: GoogleService | null,
  success: boolean,
  error?: string | null,
  email?: string | null,
  nonce?: string,
): string {
  const statusClass = success ? 'success' : 'error';
  const message = success ? 'Connected! This window will close...' : `Error: ${error || 'Unknown error'}`;
  const messageType = service === 'gdrive' ? 'gdrive-oauth-callback' : 'gmail-oauth-callback';
  const title = service === 'gdrive' ? 'Google Drive' : service === 'gmail' ? 'Gmail' : 'Google';

  return `<!DOCTYPE html>
<html><head><title>${title} - ${success ? 'Connected' : 'Error'}</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f14; color: #a0a0b0; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
.container { text-align: center; padding: 2rem; }
.success { color: #34d399; }
.error { color: #f87171; }
</style></head><body>
<div class="container">
  <p class="${statusClass}">${message}</p>
</div>
<script nonce="${nonce}">
if (window.opener) {
  window.opener.postMessage({ type: ${JSON.stringify(messageType)}, success: ${success}, email: ${JSON.stringify(email || null)}, error: ${JSON.stringify(error || null)} }, window.location.origin);
  ${success ? 'setTimeout(function() { window.close(); }, 1500);' : ''}
}
</script></body></html>`;
}
