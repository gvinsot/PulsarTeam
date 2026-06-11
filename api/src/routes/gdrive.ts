import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../services/googleOAuthConfig.js';
import { generateGoogleOAuthState } from './googleOAuth.js';

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
 * Drive shares the same OAuth client, redirect URI, state store, and
 * callback handler as Gmail — see api/src/routes/googleOAuth.ts. Only
 * Drive-specific auth-url, status, and disconnect endpoints live here.
 */

function resolveScope(agentId, boardId, username): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
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
  const config = getGoogleOAuthConfig();
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
    signal: AbortSignal.timeout(15_000),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // Only invalid_grant means the refresh token itself is revoked/expired.
    // Transient failures (429, 5xx) must keep the token so the next call retries.
    if (data.error === 'invalid_grant') {
      await deleteOAuthToken('gdrive', record.scopeType, record.scopeId);
    } else {
      console.warn(`⚠️ [Gdrive] Token refresh failed (HTTP ${response.status}) for ${record.scopeType}:${record.scopeId} — keeping token for retry:`, data.error || 'no error body');
    }
    throw new Error(data.error_description || data.error || `Token refresh failed (HTTP ${response.status})`);
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

export function gdriveRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getGoogleOAuthConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = req.user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('gdrive', scopeType, scopeId);
    // hasOAuthToken treats expired-but-refreshable tokens as connected — the
    // access token only lasts ~1h but resolveAccessToken refreshes transparently.
    const connected = hasOAuthToken('gdrive', scopeType, scopeId);

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
      return res.status(500).json({ error: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — the same OAuth client is reused for Gmail, Drive, and Google login.' });
    }

    const agentId = (req.query.agentId as string | undefined) || null;
    const boardId = (req.query.boardId as string | undefined) || null;

    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ];

    const state = generateGoogleOAuthState('gdrive', req.user?.username || 'default', agentId, boardId);

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
