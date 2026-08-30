import express from 'express';
import { errorMessage } from '../lib/errors.js';
import {
  storeOAuthToken,
  resolveAccessToken,
  resolveOAuthTokenRecord,
} from '../services/database.js';
import { resolveScope, sendOAuthResult } from './oauthHelper.js';
import { createOAuthStateStore } from './oauthState.js';
import { oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';
import { readSecret } from '../secrets.js';

import { asyncHandler } from '../lib/asyncHandler.js';
/**
 * GitHub OAuth2 routes — unified token store.
 * Resolution: agent → board → user → error
 */

// HKDF domain 'github' must stay byte-identical across deploys — see oauthState.ts.
const oauthStates = createOAuthStateStore<{
  username: string;
  agentId: string | null;
  boardId: string | null;
}>('github');

function generateOAuthState(
  username: string,
  agentId: string | null = null,
  boardId: string | null = null
) {
  return oauthStates.generate({ username, agentId, boardId });
}

function consumeOAuthState(state: string) {
  const entry = oauthStates.consume(state);
  if (!entry) return null;
  return {
    username: entry.username,
    agentId: entry.agentId || null,
    boardId: entry.boardId || null,
  };
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
  baseDelayMs = 250
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
      const transient =
        err?.name === 'TimeoutError' ||
        /terminated|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN|UND_ERR_SOCKET/i.test(String(cause));
      if (!transient || i === attempts - 1) throw err;
      const delay = baseDelayMs * Math.pow(2, i);
      console.warn(
        `[GitHub] fetch ${url} failed with "${cause}", retrying in ${delay}ms (attempt ${i + 2}/${attempts})`
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

export async function getGitHubAccessTokenForAgent(
  agentId: string | null,
  boardId: string | null = null
) {
  // GitHub tokens don't expire
  return resolveAccessToken('github', agentId, boardId);
}

/**
 * Best-effort liveness check for a GitHub token: `GET /user` with the token and
 * report whether GitHub *definitively* rejected it (HTTP 401). Any other outcome
 * — 200, a 403 rate-limit, a 5xx, or a network failure that survives the retry
 * budget — returns `true` (usable): an ambiguous result must never cause us to
 * throw away a token that might be perfectly good. Only a clear 401 is treated
 * as dead, since that's what an expired/revoked OAuth token returns.
 */
async function isGitHubTokenUsable(token: string): Promise<boolean> {
  try {
    const res = await fetchWithRetry(
      'https://api.github.com/user',
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PulsarTeam',
        },
      },
      2
    );
    return res.status !== 401;
  } catch {
    // Network error / timeout after retries — can't prove the token is dead, so
    // keep it rather than falling back on a transient blip.
    return true;
  }
}

/**
 * Resolve GitHub credentials for an agent. Resolution order:
 *   agent → board → user OAuth token  →  server-wide GITHUB_TOKEN fallback.
 * Returns null only when NO source yields a token. Used to inject the access
 * token into the runner container so the agent can `git clone/pull/push` via
 * HTTPS.
 *
 * The GITHUB_TOKEN fallback is what fixes the "some agents can push, some
 * can't" inconsistency. Two failure modes are covered:
 *   1. No plugin connected at any scope → no OAuth token → server token fills
 *      the gap (otherwise every push dies with "could not read Username").
 *   2. A plugin IS connected but its OAuth token is expired/revoked → the token
 *      is present yet every push is rejected with HTTP 401, and previously we
 *      returned it anyway with NO fallback. We now validate a resolved OAuth
 *      token against the GitHub API *when a server fallback exists* and, if it
 *      is definitively dead, fall through to the server token instead of
 *      shipping credentials that cannot push.
 *
 * A *usable* per-scope OAuth token always wins; the server token only fills the
 * gap when none exists or the resolved one is dead. Validation is skipped when
 * there is no server fallback (nothing better to switch to) so the common path
 * pays no extra network round-trip.
 */
export async function getGitHubCredentialsForAgent(
  agentId: string | null,
  boardId: string | null = null
): Promise<{ token: string; login: string | null; provider: 'github' } | null> {
  const hit = await resolveOAuthTokenRecord('github', agentId, boardId);
  // Server-wide fallback: GITHUB_TOKEN (documented in .env.example, mountable
  // as a Docker secret via readSecret). GITHUB_USER is the matching username;
  // it defaults to `x-access-token` in the runner when unset, which GitHub
  // accepts for PAT/installation tokens.
  const envToken = readSecret('GITHUB_TOKEN', '').trim();

  if (hit) {
    const oauthCreds = {
      token: hit.accessToken,
      // User-scope fallback deliberately reports login: null (the token may
      // belong to any user); agent/board scopes surface the stored login.
      login: hit.scopeType === 'user' ? null : (hit.record.meta as any)?.login || null,
      provider: 'github' as const,
    };
    // No server fallback to switch to → return the OAuth token unchecked (a
    // dead token is still the best — and only — thing we have).
    if (!envToken) return oauthCreds;
    // A server fallback exists: only ship the OAuth token if it can still auth.
    if (await isGitHubTokenUsable(oauthCreds.token)) return oauthCreds;
    console.warn(
      `[GitHub] Resolved OAuth token (scope=${hit.scopeType}) was rejected by GitHub (401); ` +
        `falling back to server GITHUB_TOKEN so the agent can still push.`
    );
    // fall through to the server token
  }

  if (envToken) {
    const envUser = (process.env.GITHUB_USER || '').trim();
    return { token: envToken, login: envUser || null, provider: 'github' };
  }
  return null;
}

async function handleOAuthRedirect(req: express.Request, res: express.Response) {
  const error = req.query.error as string | undefined;
  if (error) {
    const desc = req.query.error_description || error;
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', false, String(desc));
  }

  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) {
    return sendOAuthResult(
      res,
      'GitHub',
      'github-oauth-callback',
      false,
      'Missing code or state parameter'
    );
  }

  const config = getConfig();
  if (!config) {
    return sendOAuthResult(
      res,
      'GitHub',
      'github-oauth-callback',
      false,
      'GitHub OAuth not configured on server'
    );
  }

  const stateData = consumeOAuthState(state);
  if (!stateData) {
    return sendOAuthResult(
      res,
      'GitHub',
      'github-oauth-callback',
      false,
      'Invalid or expired state. Please try again.'
    );
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
      return sendOAuthResult(
        res,
        'GitHub',
        'github-oauth-callback',
        false,
        data.error_description ||
          data.error ||
          data.message ||
          `Token exchange failed (HTTP ${response.status})`
      );
    }

    let login = null;
    try {
      const userRes = await fetchWithRetry('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${data.access_token}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'PulsarTeam',
        },
      });
      if (userRes.ok) {
        const user = await userRes.json();
        login = user.login;
      }
    } catch (err) {
      console.warn('[GitHub] Could not fetch user profile:', errorMessage(err));
    }

    const { scopeType, scopeId } = resolveScope(
      stateData.agentId,
      stateData.boardId,
      stateData.username
    );

    await storeOAuthToken(
      {
        provider: 'github',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        meta: { scope: data.scope, tokenType: data.token_type, login },
      },
      { throwOnPersistError: true }
    );

    console.log(
      `✅ [GitHub] OAuth token stored for ${scopeType}:${scopeId} (${login || 'unknown'}) via redirect`
    );
    return sendOAuthResult(res, 'GitHub', 'github-oauth-callback', true, null, { login });
  } catch (err: any) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || 'unknown';
    console.error('[GitHub] OAuth redirect error:', err);
    return sendOAuthResult(
      res,
      'GitHub',
      'github-oauth-callback',
      false,
      `Token exchange failed: ${cause}`
    );
  }
}

export function githubOAuthRedirectRouter() {
  const router = express.Router();
  router.get('/oauth-redirect', asyncHandler(handleOAuthRedirect));
  return router;
}

const githubSpec: OAuthProviderSpec<{ clientId: string; clientSecret: string }> = {
  provider: 'github',
  label: 'GitHub',
  getConfig,
  notConfiguredError:
    'GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.',
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
  isConnected: token => !!(token && token.accessToken),
  statusFields: (token, connected) => ({ login: connected ? token?.meta?.login || null : null }),
};

export function githubRoutes() {
  return oauthProviderRoutes(githubSpec);
}
