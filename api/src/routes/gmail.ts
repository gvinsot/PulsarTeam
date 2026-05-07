import express from 'express';
import crypto from 'crypto';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { readSecret } from '../secrets.js';

/**
 * Gmail OAuth2 routes.
 *
 * Tokens are stored in the unified oauth_tokens table, scoped by:
 *   - agent:<agentId>  (per-agent)
 *   - board:<boardId>  (per-board, shared by all agents on that board)
 *   - user:<username>  (per-user fallback)
 *
 * Resolution order when an agent calls a Gmail MCP tool:
 *   agent tokens → board tokens → user tokens → error
 */

// In-memory OAuth state store: state → { username, agentId, boardId, expiresAt }
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
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = readSecret('GMAIL_CLIENT_SECRET');
  const redirectUri = process.env.GMAIL_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function hasGmailTokensForAgent(agentId) {
  if (!agentId) return false;
  return hasOAuthToken('gmail', 'agent', agentId);
}

export function hasGmailTokensForBoard(boardId) {
  if (!boardId) return false;
  return hasOAuthToken('gmail', 'board', boardId);
}

async function refreshGmailToken(record: OAuthTokenRecord): Promise<string> {
  const config = getConfig();
  if (!config) throw new Error('Gmail not configured');
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
    await deleteOAuthToken('gmail', record.scopeType, record.scopeId);
    throw new Error(data.error_description || 'Token refresh failed');
  }

  await storeOAuthToken({
    provider: 'gmail',
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    meta: record.meta,
  });

  console.log(`🔄 [Gmail] Token refreshed for ${record.scopeType}:${record.scopeId}`);
  return data.access_token;
}

export async function getGmailAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('gmail', agentId, boardId, refreshGmailToken);
}

/**
 * Public OAuth redirect handler �� mounted WITHOUT authenticateToken.
 * Google redirects here (in the popup) after the user consents.
 * We exchange the code server-side then return a minimal HTML page
 * that notifies the opener via postMessage and closes the popup.
 */
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
    return sendOAuthResult(res, false, 'Gmail not configured on server');
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
      console.error('[Gmail] Token exchange failed:', data);
      return sendOAuthResult(res, false, 'Token exchange failed: ' + (data.error_description || data.error || 'unknown'));
    }

    let email = null;
    try {
      const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (profileRes.ok) {
        const profile = await profileRes.json();
        email = profile.emailAddress;
      }
    } catch (err) {
      console.warn('[Gmail] Could not fetch profile email:', err.message);
    }

    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: 'gmail',
      scopeType,
      scopeId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      meta: { email },
    });

    console.log(`✅ [Gmail] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'}) via redirect`);
    return sendOAuthResult(res, true, null, email);
  } catch (err) {
    console.error('[Gmail] OAuth redirect error:', err);
    return sendOAuthResult(res, false, 'Internal error during token exchange');
  }
}

export function gmailOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleOAuthCallback);
  return router;
}

export function gmailCallbackHandler() {
  return handleOAuthCallback;
}

function oauthResultPage(success: boolean, error?: string | null, email?: string | null, nonce?: string): string {
  const statusClass = success ? 'success' : 'error';
  const message = success
    ? 'Connected! This window will close...'
    : `Error: ${error || 'Unknown error'}`;

  return `<!DOCTYPE html>
<html><head><title>Gmail - ${success ? 'Connected' : 'Error'}</title>
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
  window.opener.postMessage({ type: 'gmail-oauth-callback', success: ${success}, email: ${JSON.stringify(email || null)}, error: ${JSON.stringify(error || null)} }, window.location.origin);
  ${success ? 'setTimeout(function() { window.close(); }, 1500);' : ''}
}
</script></body></html>`;
}

export function gmailRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = req.user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('gmail', scopeType, scopeId);
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
      return res.status(500).json({ error: 'Gmail not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REDIRECT_URI.' });
    }

    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
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

  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) return res.status(500).json({ error: 'Gmail not configured' });

    const { code, state } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });
    if (!state) return res.status(400).json({ error: 'State parameter required' });

    const stateData = consumeOAuthState(state);
    if (!stateData) return res.status(400).json({ error: 'Invalid or expired state' });

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
        console.error('[Gmail] Token exchange failed:', data);
        return res.status(400).json({ error: 'Token exchange failed' });
      }

      let email = null;
      try {
        const profileRes = await fetch('https://www.googleapis.com/gmail/v1/users/me/profile', {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          email = profile.emailAddress;
        }
      } catch (err) {
        console.warn('[Gmail] Could not fetch profile email:', err.message);
      }

      const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

      await storeOAuthToken({
        provider: 'gmail',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
        meta: { email },
      });

      console.log(`✅ [Gmail] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'})`);
      res.json({ success: true, expiresIn: data.expires_in, agentId: stateData.agentId, boardId: stateData.boardId, email });
    } catch (err) {
      console.error('[Gmail] Token exchange error:', err);
      res.status(500).json({ error: 'Token exchange failed' });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = req.user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken('gmail', scopeType, scopeId);
    console.log(`🔌 [Gmail] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
