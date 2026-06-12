import express from 'express';
import { storeOAuthToken, resolveAccessToken } from '../services/database.js';
import { resolveScope, sendOAuthResult } from './oauthHelper.js';
import { createOAuthStateStore } from './oauthState.js';
import { oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';
import { readSecret } from '../secrets.js';

/**
 * Slack OAuth2 routes — unified token store.
 * Resolution: agent → board → user → error
 */

// HKDF domain 'slack' must stay byte-identical across deploys — see oauthState.ts.
const oauthStates = createOAuthStateStore<{ username: string; agentId: string | null; boardId: string | null }>('slack');

function generateOAuthState(username: string, agentId: string | null = null, boardId: string | null = null) {
  return oauthStates.generate({ username, agentId, boardId });
}

function consumeOAuthState(state: string) {
  const entry = oauthStates.consume(state);
  if (!entry) return null;
  return { username: entry.username, agentId: entry.agentId || null, boardId: entry.boardId || null };
}

function getConfig() {
  const clientId = process.env.SLACK_CLIENT_ID;
  const clientSecret = readSecret('SLACK_CLIENT_SECRET');
  const redirectUri = process.env.SLACK_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
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
    }, { throwOnPersistError: true });

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

const slackSpec: OAuthProviderSpec<{ clientId: string; clientSecret: string; redirectUri: string }> = {
  provider: 'slack',
  label: 'Slack',
  getConfig,
  notConfiguredError: 'Slack not configured. Set SLACK_CLIENT_ID, SLACK_CLIENT_SECRET, and SLACK_REDIRECT_URI.',
  generateState: (username, agentId, boardId) => generateOAuthState(username, agentId, boardId),
  buildAuthUrl: (req, config, state) => {
    const scopes = [
      'channels:read', 'channels:history', 'chat:write', 'users:read',
      'groups:read', 'groups:history', 'im:read', 'im:history', 'im:write',
      'mpim:read', 'mpim:history', 'reactions:read', 'reactions:write', 'files:read',
    ];
    const params = new URLSearchParams({
      client_id: config.clientId,
      scope: scopes.join(','),
      redirect_uri: config.redirectUri,
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  },
  isConnected: (token) => !!token,
  statusFields: (token, connected) => ({ teamName: connected ? token?.meta?.teamName || null : null }),
};

export function slackRoutes() {
  return oauthProviderRoutes(slackSpec);
}
