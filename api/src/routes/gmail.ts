import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../services/googleOAuthConfig.js';
import { generateGoogleOAuthState, consumeGoogleOAuthState } from './googleOAuth.js';

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
 *
 * The OAuth state lifecycle and redirect callback are shared with Google
 * Drive — see api/src/routes/googleOAuth.ts. Only Gmail-specific auth-url,
 * status, callback (legacy POST), and disconnect endpoints live here.
 */

function resolveScope(agentId, boardId, username): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
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
  const config = getGoogleOAuthConfig();
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

export function gmailRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getGoogleOAuthConfig();
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
    const config = getGoogleOAuthConfig();
    if (!config) {
      return res.status(500).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REDIRECT_URI.' });
    }

    const agentId = (req.query.agentId as string | undefined) || null;
    const boardId = (req.query.boardId as string | undefined) || null;

    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
      'https://www.googleapis.com/auth/userinfo.email',
    ];

    const state = generateGoogleOAuthState('gmail', req.user?.username || 'default', agentId, boardId);

    const redirectUri = `${req.protocol}://${req.get('host')}${GOOGLE_PLUGIN_REDIRECT_PATH}`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    res.json({ authUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });

  // Legacy POST callback — used by the frontend-hosted gmail-callback.html flow
  // (popup posts the code back to the API instead of the API handling the
  // redirect itself). Kept for backward compat with older clients.
  router.post('/callback', async (req, res) => {
    const config = getGoogleOAuthConfig();
    if (!config) return res.status(500).json({ error: 'Gmail not configured' });

    const { code, state } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });
    if (!state) return res.status(400).json({ error: 'State parameter required' });

    const stateData = consumeGoogleOAuthState(state);
    if (!stateData) return res.status(400).json({ error: 'Invalid or expired state' });
    if (stateData.service !== 'gmail') return res.status(400).json({ error: 'State service mismatch' });

    try {
      // Match the redirect_uri used in the auth URL exactly — Google rejects
      // mismatches. Both calls come from the same browser through the same
      // proxy so req.protocol + host resolves consistently.
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
