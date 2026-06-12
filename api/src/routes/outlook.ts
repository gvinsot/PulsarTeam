import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import { generateMicrosoftOAuthState } from './microsoftOAuth.js';

/**
 * Outlook OAuth2 routes — unified token store.
 *
 * Reuses the Microsoft OAuth client (MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI)
 * and the shared dispatcher in routes/microsoftOAuth.ts. Tokens are stored in
 * the unified oauth_tokens table under provider='outlook' and scoped by:
 *   - agent:<agentId>  (per-agent)
 *   - board:<boardId>  (per-board, shared by all agents on that board)
 *   - user:<username>  (per-user fallback)
 *
 * Resolution order when an agent calls an Outlook MCP tool:
 *   agent tokens → board tokens → user tokens → error
 */

function resolveScope(agentId, boardId, username): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
}

function getConfig() {
  return getMicrosoftOAuthConfig();
}

export function hasOutlookTokensForAgent(agentId) {
  if (!agentId) return false;
  return hasOAuthToken('outlook', 'agent', agentId);
}

export function hasOutlookTokensForBoard(boardId) {
  if (!boardId) return false;
  return hasOAuthToken('outlook', 'board', boardId);
}

async function refreshOutlookToken(record: OAuthTokenRecord): Promise<string> {
  const config = getConfig();
  if (!config) throw new Error('Outlook not configured');
  if (!record.refreshToken) throw new Error('No refresh token available');

  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: record.refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
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
      await deleteOAuthToken('outlook', record.scopeType, record.scopeId);
    } else {
      console.warn(`⚠️ [Outlook] Token refresh failed (HTTP ${response.status}) for ${record.scopeType}:${record.scopeId} — keeping token for retry:`, data.error || 'no error body');
    }
    throw new Error(data.error_description || data.error || `Token refresh failed (HTTP ${response.status})`);
  }

  await storeOAuthToken({
    provider: 'outlook',
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    meta: record.meta,
  });

  console.log(`🔄 [Outlook] Token refreshed for ${record.scopeType}:${record.scopeId}`);
  return data.access_token;
}

export async function getOutlookAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('outlook', agentId, boardId, refreshOutlookToken);
}

export function outlookRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = req.user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('outlook', scopeType, scopeId);
    // hasOAuthToken treats expired-but-refreshable tokens as connected — the
    // access token only lasts ~1h but resolveAccessToken refreshes transparently.
    const connected = hasOAuthToken('outlook', scopeType, scopeId);

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
      return res.status(500).json({ error: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.' });
    }

    const agentId = (req.query.agentId as string | undefined) || null;
    const boardId = (req.query.boardId as string | undefined) || null;

    // Microsoft Graph Mail scopes. offline_access is required for refresh tokens.
    const scopes = [
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'MailboxSettings.Read',
      'User.Read',
      'offline_access',
    ];

    const state = generateMicrosoftOAuthState('outlook', req.user?.username || 'default', agentId, boardId);

    const redirectUri = `${req.protocol}://${req.get('host')}${MICROSOFT_PLUGIN_REDIRECT_PATH}`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      response_mode: 'query',
      state,
    });

    res.json({ authUrl: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params}` });
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = req.user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken('outlook', scopeType, scopeId);
    console.log(`🔌 [Outlook] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
