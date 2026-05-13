import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import { generateMicrosoftOAuthState, consumeMicrosoftOAuthState } from './microsoftOAuth.js';

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
  });

  const data = await response.json();
  if (!response.ok) {
    await deleteOAuthToken('outlook', record.scopeType, record.scopeId);
    throw new Error(data.error_description || 'Token refresh failed');
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

  // Legacy POST callback — kept symmetric with onedrive/gmail flows.
  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) return res.status(500).json({ error: 'Outlook not configured' });

    const { code, state } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });
    if (!state) return res.status(400).json({ error: 'State parameter required' });

    const stateData = consumeMicrosoftOAuthState(state);
    if (!stateData) return res.status(400).json({ error: 'Invalid or expired state' });
    if (stateData.service !== 'outlook') return res.status(400).json({ error: 'State service mismatch' });

    try {
      const redirectUri = `${req.protocol}://${req.get('host')}${MICROSOFT_PLUGIN_REDIRECT_PATH}`;
      const body = new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      });

      const response = await fetch(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = await response.json();
      if (!response.ok) {
        console.error('[Outlook] Token exchange failed:', data);
        return res.status(400).json({ error: 'Token exchange failed' });
      }

      let email: string | null = null;
      try {
        const profileRes = await fetch('https://graph.microsoft.com/v1.0/me', {
          headers: { Authorization: `Bearer ${data.access_token}` },
        });
        if (profileRes.ok) {
          const profile = await profileRes.json();
          email = profile.mail || profile.userPrincipalName || null;
        }
      } catch (err) {
        console.warn('[Outlook] Could not fetch profile email:', (err as Error).message);
      }

      const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

      await storeOAuthToken({
        provider: 'outlook',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
        meta: { email },
      });

      console.log(`✅ [Outlook] OAuth tokens stored for ${scopeType}:${scopeId} (${email || 'unknown'})`);
      res.json({ success: true, expiresIn: data.expires_in, agentId: stateData.agentId, boardId: stateData.boardId, email });
    } catch (err) {
      console.error('[Outlook] Token exchange error:', err);
      res.status(500).json({ error: 'Token exchange failed' });
    }
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
