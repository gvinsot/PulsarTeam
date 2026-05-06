import express from 'express';
import crypto from 'crypto';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { sendOAuthResult } from './oauthHelper.js';
import { readSecret } from '../secrets.js';

/**
 * OneDrive OAuth2 routes — unified token store.
 * Resolution: agent → board → user → error
 */

const stateStore = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;

function generateOAuthState(username, agentId = null, boardId = null) {
  const now = Date.now();
  for (const [k, v] of stateStore) { if (v.expiresAt < now) stateStore.delete(k); }
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
  const clientId = process.env.ONEDRIVE_CLIENT_ID;
  const clientSecret = readSecret('ONEDRIVE_CLIENT_SECRET');
  const redirectUri = process.env.ONEDRIVE_REDIRECT_URI;
  const tenantId = process.env.ONEDRIVE_TENANT_ID || 'common';
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, tenantId };
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

async function handleOAuthRedirect(req, res) {
  const error = req.query.error as string | undefined;
  if (error) {
    const desc = req.query.error_description || error;
    return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', false, String(desc));
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', false, 'Missing code or state parameter');
  }

  const config = getConfig();
  if (!config) {
    return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', false, 'OneDrive not configured on server');
  }

  const stateData = consumeOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', false, 'Invalid or expired state. Please try again.');
  }

  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
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
      return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', false, 'Token exchange failed: ' + (data.error_description || data.error || 'unknown'));
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

    console.log(`✅ [OneDrive] OAuth token stored for ${scopeType}:${scopeId} via redirect`);
    return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', true);
  } catch (err) {
    console.error('[OneDrive] OAuth redirect error:', err);
    return sendOAuthResult(res, 'OneDrive', 'onedrive-oauth-callback', false, 'Internal error during token exchange');
  }
}

export function onedriveOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleOAuthRedirect);
  return router;
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
      return res.status(500).json({ error: 'OneDrive not configured. Set ONEDRIVE_CLIENT_ID, ONEDRIVE_CLIENT_SECRET, and ONEDRIVE_REDIRECT_URI.' });
    }

    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;

    const scopes = ['Files.Read', 'Files.Read.All', 'Files.ReadWrite', 'Files.ReadWrite.All', 'Sites.Read.All', 'User.Read', 'offline_access'];
    const state = generateOAuthState(req.user?.username || 'default', agentId, boardId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: config.redirectUri,
      scope: scopes.join(' '),
      response_mode: 'query',
      state,
    });

    res.json({ authUrl: `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params}` });
  });

  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) return res.status(500).json({ error: 'OneDrive not configured' });

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
