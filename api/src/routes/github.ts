import express from 'express';
import crypto from 'crypto';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { ScopeType } from '../services/database.js';
import { sendOAuthResult } from './oauthHelper.js';
import { readSecret } from '../secrets.js';

/**
 * GitHub OAuth2 routes — unified token store.
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
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = readSecret('GITHUB_OAUTH_CLIENT_SECRET');
  const redirectUri = process.env.GITHUB_OAUTH_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function hasGitHubTokensForAgent(agentId) {
  if (!agentId) return false;
  return hasOAuthToken('github', 'agent', agentId);
}

export function hasGitHubTokensForBoard(boardId) {
  if (!boardId) return false;
  return hasOAuthToken('github', 'board', boardId);
}

export async function getGitHubAccessTokenForAgent(agentId, boardId = null) {
  // GitHub tokens don't expire
  return resolveAccessToken('github', agentId, boardId);
}

async function handleOAuthRedirect(req, res) {
  const error = req.query.error as string | undefined;
  if (error) {
    const desc = req.query.error_description || error;
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, String(desc));
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, 'Missing code or state parameter');
  }

  const config = getConfig();
  if (!config) {
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, 'GitHub OAuth not configured on server');
  }

  const stateData = consumeOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, 'Invalid or expired state. Please try again.');
  }

  try {
    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
    });

    const data = await response.json();
    if (data.error) {
      console.error('[GitHub] Token exchange failed:', data);
      return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, data.error_description || 'Token exchange failed');
    }

    let login = null;
    try {
      const userRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'PulsarTeam' },
      });
      if (userRes.ok) {
        const user = await userRes.json();
        login = user.login;
      }
    } catch (err) {
      console.warn('[GitHub] Could not fetch user profile:', err.message);
    }

    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: 'github',
      scopeType,
      scopeId,
      accessToken: data.access_token,
      meta: { scope: data.scope, tokenType: data.token_type, login },
    });

    console.log(`✅ [GitHub] OAuth token stored for ${scopeType}:${scopeId} (${login || 'unknown'}) via redirect`);
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', true, null, { login });
  } catch (err) {
    console.error('[GitHub] OAuth redirect error:', err);
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, 'Internal error during token exchange');
  }
}

export function githubOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleOAuthRedirect);
  return router;
}

export function githubRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = req.user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('github', scopeType, scopeId);
    const connected = !!(token && token.accessToken);

    res.json({
      configured: !!config,
      connected,
      login: connected ? token?.meta?.login || null : null,
      agentId: agentId || null,
      boardId: boardId || null,
    });
  });

  router.get('/auth-url', (req, res) => {
    const config = getConfig();
    if (!config) {
      return res.status(500).json({ error: 'GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID, GITHUB_OAUTH_CLIENT_SECRET, and GITHUB_OAUTH_REDIRECT_URI.' });
    }

    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const state = generateOAuthState(req.user?.username || 'default', agentId, boardId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: 'repo read:org read:user',
      state,
    });

    res.json({ authUrl: `https://github.com/login/oauth/authorize?${params}` });
  });

  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) return res.status(500).json({ error: 'GitHub OAuth not configured' });

    const { code, state } = req.body;
    if (!code) return res.status(400).json({ error: 'Authorization code is required' });
    if (!state) return res.status(400).json({ error: 'State parameter required' });

    const stateData = consumeOAuthState(state);
    if (!stateData) return res.status(400).json({ error: 'Invalid or expired state' });

    try {
      const response = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code,
          redirect_uri: config.redirectUri,
        }),
      });

      const data = await response.json();
      if (data.error) {
        console.error('[GitHub] Token exchange failed:', data);
        return res.status(400).json({ error: data.error_description || 'Token exchange failed' });
      }

      let login = null;
      try {
        const userRes = await fetch('https://api.github.com/user', {
          headers: { Authorization: `Bearer ${data.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'PulsarTeam' },
        });
        if (userRes.ok) {
          const user = await userRes.json();
          login = user.login;
        }
      } catch (err) {
        console.warn('[GitHub] Could not fetch user profile:', err.message);
      }

      const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

      await storeOAuthToken({
        provider: 'github',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        meta: { scope: data.scope, tokenType: data.token_type, login },
      });

      console.log(`✅ [GitHub] OAuth token stored for ${scopeType}:${scopeId} (${login || 'unknown'})`);
      res.json({ success: true, agentId: stateData.agentId, boardId: stateData.boardId, login });
    } catch (err) {
      console.error('[GitHub] Token exchange error:', err);
      res.status(500).json({ error: 'Token exchange failed' });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = req.user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken('github', scopeType, scopeId);
    console.log(`🔌 [GitHub] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
