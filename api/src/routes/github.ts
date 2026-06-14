import express from 'express';
import { storeOAuthToken, resolveAccessToken, resolveOAuthTokenRecord } from '../services/database.js';
import { resolveScope, sendOAuthResult } from './oauthHelper.js';
import { createOAuthStateStore } from './oauthState.js';
import { oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';
import { readSecret } from '../secrets.js';

/**
 * GitHub OAuth2 routes — unified token store.
 * Resolution: agent → board → user → error
 */

// HKDF domain 'github' must stay byte-identical across deploys — see oauthState.ts.
const oauthStates = createOAuthStateStore<{ username: string; agentId: string | null; boardId: string | null }>('github');

function generateOAuthState(username: string, agentId: string | null = null, boardId: string | null = null) {
  return oauthStates.generate({ username, agentId, boardId });
}

function consumeOAuthState(state: string) {
  const entry = oauthStates.consume(state);
  if (!entry) return null;
  return { username: entry.username, agentId: entry.agentId || null, boardId: entry.boardId || null };
}

function getConfig() {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = readSecret('GITHUB_OAUTH_CLIENT_SECRET');
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Path under which the GitHub OAuth plugin dispatcher is mounted. The
 * auth-URL builder and the dispatcher itself must send GitHub the exact
 * same redirect_uri at token-exchange time — both derive it from this
 * constant plus req.protocol/host (so it always matches the public URL
 * the user's browser hit, behind any proxy honoring X-Forwarded-*).
 */
const GITHUB_PLUGIN_REDIRECT_PATH = '/api/github/oauth-redirect';

function pluginRedirectUri(req: express.Request): string {
  return `${req.protocol}://${req.get('host')}${GITHUB_PLUGIN_REDIRECT_PATH}`;
}

// Retries `fetch` on transient socket errors (undici "terminated", ECONNRESET, ETIMEDOUT).
// Such errors surface during GitHub OAuth token exchange when the egress connection
// is closed unexpectedly, leaving the popup stuck on "Connected!".
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
  baseDelayMs = 250,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // Per-attempt timeout so a blackholed endpoint fails fast instead of
      // hanging the OAuth popup for undici's default ~300s.
      return await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
    } catch (err: any) {
      lastErr = err;
      const cause = err?.cause?.code || err?.cause?.message || err?.code || err?.message || '';
      const transient = err?.name === 'TimeoutError'
        || /terminated|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|UND_ERR_SOCKET/i.test(String(cause));
      if (!transient || i === attempts - 1) throw err;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(`[GitHub] fetch ${url} failed with "${cause}", retrying in ${delay}ms (attempt ${i + 2}/${attempts})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function getGitHubAccessTokenForAgent(agentId, boardId = null) {
  // GitHub tokens don't expire
  return resolveAccessToken('github', agentId, boardId);
}

/**
 * Resolve GitHub credentials for an agent (agent → board → user fallback).
 * Returns null if no GitHub plugin is connected for any of those scopes.
 * Used to inject the access token into the runner container so the agent
 * can perform `git clone/pull/push` via HTTPS against the connected repo.
 */
export async function getGitHubCredentialsForAgent(
  agentId: string | null,
  boardId: string | null = null,
): Promise<{ token: string; login: string | null; provider: 'github' } | null> {
  const hit = await resolveOAuthTokenRecord('github', agentId, boardId);
  if (!hit) return null;
  return {
    token: hit.accessToken,
    // User-scope fallback deliberately reports login: null (the token may
    // belong to any user); agent/board scopes surface the stored login.
    login: hit.scopeType === 'user' ? null : (hit.record.meta as any)?.login || null,
    provider: 'github',
  };
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
    const response = await fetchWithRetry('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: pluginRedirectUri(req),
      }),
    });

    const data = await response.json();
    if (!response.ok || data.error || !data.access_token) {
      console.error('[GitHub] Token exchange failed:', data);
      return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, data.error_description || data.error || data.message || `Token exchange failed (HTTP ${response.status})`);
    }

    let login = null;
    try {
      const userRes = await fetchWithRetry('https://api.github.com/user', {
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
    }, { throwOnPersistError: true });

    console.log(`✅ [GitHub] OAuth token stored for ${scopeType}:${scopeId} (${login || 'unknown'}) via redirect`);
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', true, null, { login });
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || 'unknown';
    console.error('[GitHub] OAuth redirect error:', err);
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, `Token exchange failed: ${cause}`);
  }
}

export function githubOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', handleOAuthRedirect);
  return router;
}

const githubSpec: OAuthProviderSpec<{ clientId: string; clientSecret: string }> = {
  provider: 'github',
  label: 'GitHub',
  getConfig,
  notConfiguredError: 'GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.',
  generateState: (username, agentId, boardId) => generateOAuthState(username, agentId, boardId),
  buildAuthUrl: (req, config, state) => {
    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: pluginRedirectUri(req),
      scope: 'repo read:org read:user',
      state,
    });
    return `https://github.com/login/oauth/authorize?${params}`;
  },
  isConnected: (token) => !!(token && token.accessToken),
  statusFields: (token, connected) => ({ login: connected ? token?.meta?.login || null : null }),
};

export function githubRoutes() {
  return oauthProviderRoutes(githubSpec);
}
