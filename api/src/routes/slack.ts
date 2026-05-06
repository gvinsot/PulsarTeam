import express from 'express';
import crypto from 'crypto';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { ScopeType } from '../services/database.js';
import { sendOAuthResult } from './oauthHelper.js';
import { readSecret } from '../secrets.js';

/**
 * Slack OAuth2 routes — unified token store.
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
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = readSecret('SLACK_CLIENT_SECRET');
  const redirectUri = process.env.SLACK_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}

export function hasSlackTokensForAgent(agentId) {
  if (!agentId) return false;
  return hasOAuthToken('slack', 'agent', agentId);
}

export function hasSlackTokensForBoard(boardId) {
  if (!boardId) return false;
  return hasOAuthToken('slack', 'board', boardId);
}

export function getSlackAccessTokenForAgent(agentId, boardId = null) {
  // Slack tokens don't expire, no refresh needed
  return resolveAccessToken('slack', agentId, boardId);
}

async function handleOAuthRedirect(req, res) {
  const error = req.query.error as string | undefined;
  if (error) {
    const desc = req.query.error_description || error;
    return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', false, String(desc));
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', false, 'Missing code or state parameter');
  }

  const config = getConfig();
  if (!config) {
    return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', false, 'Slack not configured on server');
  }

  const stateData = consumeOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', false, 'Invalid or expired state. Please try again.');
  }

  try {
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.redirectUri,
    });

    const response = await fetch('https://slack.com/api/oauth.v2.access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await response.json();
    if (!data.ok) {
      console.error('[Slack] Token exchange failed:', data);
      return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', false, `Token exchange failed: ${data.error}`);
    }

    const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

    await storeOAuthToken({
      provider: 'slack',
      scopeType,
      scopeId,
      accessToken: data.access_token,
      meta: {
        teamId: data.team?.id,
        teamName: data.team?.name,
        botUserId: data.bot_user_id,
        authedUser: data.authed_user,
      },
    });

    console.log(`✅ [Slack] OAuth token stored for ${scopeType}:${scopeId} (team: ${data.team?.name || 'unknown'}) via redirect`);
    return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', true, null, { teamName: data.team?.name });
  } catch (err) {
    console.error('[Slack] OAuth redirect error:', err);
    return sendOAuthResult(res, 'Slack', 'slack-oauth-callback', false, 'Internal error during token exchange');
  }
}

export function slackOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleOAuthRedirect);
  return router;
}

export function slackRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = getConfig();
    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const username = (req as any).user?.username;

    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    const token = getOAuthToken('slack', scopeType, scopeId);
    const connected = !!token;

    res.json({
      configured: !!config,
      connected,
      teamName: connected ? token?.meta?.teamName || null : null,
      agentId: agentId || null,
      boardId: boardId || null,
    });
  });

  router.get('/auth-url', (req, res) => {
    const config = getConfig();
    if (!config) {
      return res.status(500).json({ error: 'Slack not configured. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI.' });
    }

    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;

    const scopes = [
      'channels:read', 'channels:history', 'chat:write', 'users:read',
      'groups:read', 'groups:history', 'im:read', 'im:history', 'im:write',
      'mpim:read', 'mpim:history', 'reactions:read', 'reactions:write', 'files:read',
    ];

    const state = generateOAuthState((req as any).user?.username || 'default', agentId, boardId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      scope: scopes.join(','),
      redirect_uri: config.redirectUri,
      state,
    });

    res.json({ authUrl: `https://slack.com/oauth/v2/authorize?${params}` });
  });

  router.post('/callback', async (req, res) => {
    const config = getConfig();
    if (!config) return res.status(500).json({ error: 'Slack not configured' });

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
      });

      const response = await fetch('https://slack.com/api/oauth.v2.access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });

      const data = await response.json();
      if (!data.ok) {
        console.error('[Slack] Token exchange failed:', data);
        return res.status(400).json({ error: `Token exchange failed: ${data.error}` });
      }

      const { scopeType, scopeId } = resolveScope(stateData.agentId, stateData.boardId, stateData.username);

      await storeOAuthToken({
        provider: 'slack',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        meta: {
          teamId: data.team?.id,
          teamName: data.team?.name,
          botUserId: data.bot_user_id,
          authedUser: data.authed_user,
        },
      });

      console.log(`✅ [Slack] OAuth tokens stored for ${scopeType}:${scopeId} (team: ${data.team?.name || 'unknown'})`);
      res.json({ success: true, teamName: data.team?.name, agentId: stateData.agentId, boardId: stateData.boardId });
    } catch (err) {
      console.error('[Slack] Token exchange error:', err);
      res.status(500).json({ error: 'Token exchange failed' });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = (req as any).user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken('slack', scopeType, scopeId);
    console.log(`🔌 [Slack] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
