import express from 'express';
import crypto from 'crypto';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { getGoogleOAuthConfig } from '../services/googleOAuthConfig.js';

/**
 * Google Drive OAuth2 routes.
 *
 * Tokens are stored in the unified oauth_tokens table under provider="gdrive",
 * scoped by:
 *   - agent:<agentId>  (per-agent)
 *   - board:<boardId>  (per-board, shared by all agents on that board)
 *   - user:<username>  (per-user fallback)
 *
 * Resolution order when an agent calls a Google Drive MCP tool:
 *   agent tokens → board tokens → user tokens → error
 *
 * Credentials are resolved by getGoogleOAuthConfig('gdrive') with this
 * fallback order:
 *   1. GDRIVE_CLIENT_ID / GDRIVE_CLIENT_SECRET / GDRIVE_REDIRECT_URI
 *   2. GMAIL_CLIENT_ID  / GMAIL_CLIENT_SECRET  (redirect URI is auto-derived
 *      from GMAIL_REDIRECT_URI by swapping `/api/gmail/oauth-redirect` →
 *      `/api/gdrive/oauth-redirect`)
 *   3. GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *
 * The same Google Cloud OAuth client can be reused as long as the Drive API
 * scopes are enabled and the derived redirect URI is registered in the
 * Cloud Console.
 */

const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function generateOAuthState(username, agentId = null, boardId = null) {
  const now = Date.now();
  for (const [k, v] of stateStore) {
    if (v.expiresAt < now) stateStore.delete(k);
  }
  const state = crypto.randomBytes(32).toString('hex');
  stateStore.set(state, { username, agentId, boardId, expiresAt: now + STATE_TTL_MS });
  return state;
}

function consumeOAuthState(state) {
  const entry = stateStore.get(state);
  if (!entry) return null;
  stateStore.delete(state);
  if (entry.expiresAt < Date.now()) return null;
  return { username: entry.username, agentId: entry.agentId || null, boardId: entry.boardId || null };
}

function resolveScope(agentId, boardId, username): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
}

function getConfig() {
  return getGoogleOAuthConfig('gdrive');
}

export function hasGdriveTokensForAgent(agentId) {
  if (!agentId) return false;
  return hasOAuthToken('gdrive', 'agent', agentId);
}

export function hasGdriveTokensForBoard(boardId) {
  if (!boardId) return false;
  return hasOAuthToken('gdrive', 'board', boardId);
}

async function refreshGdriveToken(record: OAuthTokenRecord): Promise<string> {
  const config = getConfig();
  if (!config) throw new Error('Google Drive not configured');
  if (!record.refreshToken) throw new Error('No refresh token available');

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: record.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  const data = await response.json();
  if (!response.ok) {
    await deleteOAuthToken('gdrive', record.scopeType, record.scopeId);
    throw new Error(data.error_description || 'Token refresh failed');
  }

  await storeOAuthToken({
    provider: 'gdrive',
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    meta: record.meta,
  });

  console.log(`🔄 [Gdrive] Token refreshed for ${record.scopeType}:${record.scopeId}`);
  return data.access_token;
}

export async function getGdriveAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('gdrive', agentId, boardId, refreshGdriveToken);
}

function sendOAuthResult(res, success: boolean, error?: string | null, email?: string | null) {
  const nonce = crypto.randomBytes(16).toString('base64');
  res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'`);
  res.send(oauthResultPage(success, error, email, nonce));
}

async function handleOAuthCallback(req, res) {
  const error = req.query.error as string | undefined;
  if (error) {
    const desc = req.query.error_description || error;
    return sendOAuthResult(res, false, String(desc));
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;

  if (!code || !state) {
    return sendOAuthResult(res, false, 'Missing code or state parameter');
  }

  const config = getConfig();
  if (!config) {
    return sendOAuthResult(res, false, 'Google Drive not configured on server');
  }

  const stateData = consumeOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(res, false, 'Invalid or expired state. Please try again.');
  }

  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    });

    const response = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('[Gdrive] Token exchange failed:', data);
      return sendOAuthResult(res, false, 'Token exchange failed: ' + (data.error_description || data.error || 'unknown'));
    }

    let email = null;
    try {
      const profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        email = profile.email;
      }
    } catch (err) {
      console.warn('[Gdrive] Could not fetch profile email:', err.message);
    }

    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: 'gdrive',
      scopeType,
      scopeId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      meta: { email },
    });

    console.log(`✅ [Gdrive] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'}) via redirect`);
    return sendOAuthResult(res, true, null, email);
  } catch (err) {
    console.error('[Gdrive] OAuth redirect error:', err);
    return sendOAuthResult(res, false, 'Internal error during token exchange');
  }
}

export function gdriveOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleOAuthCallback);
  return router;
}

function oauthResultPage(success: boolean, error?: string | null, email?: string | null, nonce?: string): string {
  const statusClass = success ? 'success' : 'error';
  const message = success
    ? 'Connected! This window will close...'
    : `Error: ${error || 'Unknown error'}`;

  return `<!DOCTYPE html>
<html><head><title>Google Drive - ${success ? 'Connected' : 'Error'}</title>
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
  window.opener.postMessage({ type: 'gdrive-oauth-callback', success: ${success}, email: ${JSON.stringify(email || null)}, error: ${JSON.stringify(error || null)} }, window.location.origin);
  ${success ? 'setTimeout(function() { window.close(); }, 1500);' : ''}
}
</script></body></html>`;
}

export function gdriveRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = req.user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('gdrive', scopeType, scopeId);
    const connected = !!(token && (!token.expiresAt || token.expiresAt > Date.now()));

    res.json({
      configured: !!config,
      connected,
      email: connected ? token?.meta?.email || null : null,
      agentId: agentId || null,
      boardId: boardId || null,
    });
  });

  router.get('/auth-url', (req, res) => {
    const config = getConfig();
    if (!config) {
      return res.status(500).json({ error: 'Google Drive not configured. Set GDRIVE_CLIENT_ID/GDRIVE_CLIENT_SECRET/GDRIVE_REDIRECT_URI, or reuse the GMAIL_* (or shared GOOGLE_*) credentials — the Drive redirect URI is auto-derived from GMAIL_REDIRECT_URI when not set explicitly.' });
    }

    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ];

    const state = generateOAuthState(req.user?.username || 'default', agentId, boardId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    res.json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = req.user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken('gdrive', scopeType, scopeId);
    console.log(`🔌 [Gdrive] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
