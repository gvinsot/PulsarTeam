import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import {
  generateMicrosoftOAuthState,
  consumeMicrosoftOAuthState,
  microsoftOAuthRedirectRouter,
} from './microsoftOAuth.js';

/**
 * OneDrive OAuth2 routes — unified token store.
 * Resolution: agent → board → user → error
 *
 * The OAuth client credentials, redirect URI, and callback dispatcher are
 * shared across all Microsoft plugins (OneDrive, Outlook, …) via
 * services/microsoftOAuthConfig.ts and routes/microsoftOAuth.ts.
 */

export { microsoftOAuthRedirectRouter as onedriveOAuthRedirectRouter };

function resolveScope(agentId, boardId, username): { scopeType: ScopeType; scopeId: string } {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return { scopeType: 'user', scopeId: username || 'default' };
}

function getConfig() {
  return getMicrosoftOAuthConfig();
}

export function hasOnedriveTokensForAgent(agentId) {
  if (!agentId) return false;
  return hasOAuthToken('onedrive', 'agent', agentId);
}

export function hasOnedriveTokensForBoard(boardId) {
  if (!boardId) return false;
  return hasOAuthToken('onedrive', 'board', boardId);
}

async function refreshOnedriveToken(record: OAuthTokenRecord): Promise<string> {
  const config = getConfig();
  if (!config) throw new Error('OneDrive not configured');
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
    await deleteOAuthToken('onedrive', record.scopeType, record.scopeId);
    throw new Error(data.error_description || 'Token refresh failed');
  }

  await storeOAuthToken({
    provider: 'onedrive',
    scopeType: record.scopeType,
    scopeId: record.scopeId,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || record.refreshToken,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000,
    meta: record.meta,
  });

  console.log(`🔄 [OneDrive] Token refreshed for ${record.scopeType}:${record.scopeId}`);
  return data.access_token;
}

export async function getAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('onedrive', agentId, boardId, refreshOnedriveToken);
}

export function onedriveRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = req.user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('onedrive', scopeType, scopeId);
    const connected = !!(token && (!token.expiresAt || token.expiresAt > Date.now()));

    res.json({
      configured: !!config,
      connected,
      username: connected ? username : null,
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

    // Scopes compatibles à la fois comptes pro (work/school) et perso (hotmail/outlook.com/live).
    // Les variantes `.All` (Files.Read.All, Files.ReadWrite.All, Sites.Read.All) n'existent
    // pas dans le directory consumer — les inclure produit un token "amputé" qui échoue
    // sur /me/drive pour les comptes perso (accessDenied).
    const scopes = ['Files.Read', 'Files.ReadWrite', 'User.Read', 'offline_access'];
    const state = generateMicrosoftOAuthState('onedrive', req.user?.username || 'default', agentId, boardId);

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

  // Legacy POST callback — used by clients posting the code from a popup back
  // to the API. Kept for backward compat; the preferred flow is the redirect
  // handler in microsoftOAuth.ts.
  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) return res.status(500).json({ error: 'OneDrive not configured' });

    const { code, state } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });
    if (!state) return res.status(400).json({ error: 'State parameter required' });

    const stateData = consumeMicrosoftOAuthState(state);
    if (!stateData) return res.status(400).json({ error: 'Invalid or expired state' });
    if (stateData.service !== 'onedrive') return res.status(400).json({ error: 'State service mismatch' });

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
        console.error('[OneDrive] Token exchange failed:', data);
        return res.status(400).json({ error: 'Token exchange failed' });
      }

      const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

      await storeOAuthToken({
        provider: 'onedrive',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in - 60) * 1000,
        meta: {},
      });

      console.log(`✅ [OneDrive] OAuth tokens stored for ${scopeType}:${scopeId}`);
      res.json({ success: true, expiresIn: data.expires_in, agentId: stateData.agentId, boardId: stateData.boardId });
    } catch (err) {
      console.error('[OneDrive] Token exchange error:', err);
      res.status(500).json({ error: 'Token exchange failed' });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = req.user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken('onedrive', scopeType, scopeId);
    console.log(`🔌 [OneDrive] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
