import express from 'express';
import { errorMessage } from '../lib/errors.js';
import {
  storeOAuthToken,
  getOAuthToken,
  listOAuthTokensByProvider,
  resolveAccessToken,
  resolveOAuthTokenRecord,
} from '../services/database.js';
import type { OAuthTokenRecord, ScopeType } from '../services/database.js';
import { resolveScope, sendOAuthResult } from './oauthHelper.js';
import { createOAuthStateStore } from './oauthState.js';
import { oauthProviderRoutes, makeRefresh } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';
import { readSecret } from '../secrets.js';

import { asyncHandler } from '../lib/asyncHandler.js';
/**
 * GitHub OAuth2 routes — unified token store.
 * Resolution: agent → board → error
 *
 * Two properties of GitHub App user-to-server tokens drive the token handling
 * below, and getting either wrong sends the owner round an endless reconnect
 * carousel:
 *   1. They EXPIRE (8h) and ship a `refresh_token`. Dropping those fields on
 *      the floor means "reconnect GitHub" several times a day, forever.
 *   2. Re-authorizing as the same GitHub user REVOKES the token minted by the
 *      previous authorization. Since a scope (agent/board/user) each stores its
 *      own copy, connecting agent N killed agents 1..N-1 — so the tokens of one
 *      GitHub account are kept in sync instead of treated as independent.
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

/** Serves both the authorization-code exchange and the refresh-token grant. */
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';

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
  // GitHub App user tokens expire after 8h — refresh rather than make the owner reconnect.
  return resolveAccessToken('github', agentId, boardId, refreshGitHubToken);
}

/** The GitHub account a stored token belongs to, or null when unknown. */
function recordLogin(record: OAuthTokenRecord | null | undefined): string | null {
  const login = (record?.meta as Record<string, unknown> | undefined)?.login;
  return typeof login === 'string' && login ? login : null;
}

/**
 * Hand the credential we just obtained to every OTHER connection of the same
 * GitHub account.
 *
 * GitHub mints a new user token on each authorization and revokes the previous
 * one, so per-scope copies are not independent credentials — they are stale
 * copies of a single one. Fanning the live token out means one connect (or one
 * refresh) covers every agent and board using that account.
 *
 * Connections whose recorded login differs — or that never recorded one — are
 * left untouched: they may legitimately belong to a different GitHub account.
 *
 * Note that `storeOAuthToken` COALESCEs a null refresh token onto the existing
 * one, so a source without a refresh token leaves the sibling's in place. Its
 * next refresh then fails and the recovery path re-adopts a live token — the
 * only way in is switching the app from a GitHub App back to an OAuth App.
 */
async function propagateGitHubToken(
  login: string,
  source: Pick<OAuthTokenRecord, 'accessToken' | 'refreshToken' | 'expiresAt'>,
  origin: { scopeType: ScopeType; scopeId: string }
): Promise<number> {
  let updated = 0;
  try {
    for (const sibling of await listOAuthTokensByProvider('github')) {
      if (sibling.scopeType === origin.scopeType && sibling.scopeId === origin.scopeId) continue;
      if (recordLogin(sibling) !== login) continue;
      if (sibling.accessToken === source.accessToken) continue; // already current
      await storeOAuthToken({
        provider: 'github',
        scopeType: sibling.scopeType,
        scopeId: sibling.scopeId,
        accessToken: source.accessToken,
        refreshToken: source.refreshToken ?? null,
        expiresAt: source.expiresAt ?? null,
        meta: { ...(sibling.meta || {}), login },
      });
      updated++;
    }
  } catch (err) {
    // Best effort: the scope that triggered this already has its own token.
    console.warn('[GitHub] Could not share the token with sibling scopes:', errorMessage(err));
  }
  if (updated > 0) {
    console.log(
      `🔗 [GitHub] Shared the live "${login}" token with ${updated} other connection(s) — no reconnect needed there`
    );
  }
  return updated;
}

// Refresh tokens are single-use: two scopes refreshing the same credential at
// once would burn it and leave one of them holding a dead token. Keyed on the
// refresh token so every scope sharing it joins the same in-flight refresh.
const refreshesInFlight = new Map<string, Promise<string>>();

/** Refresh a GitHub user token, then share the result across the account's scopes. */
export async function refreshGitHubToken(record: OAuthTokenRecord): Promise<string> {
  const key = record.refreshToken || `${record.scopeType}:${record.scopeId}`;
  const pending = refreshesInFlight.get(key);
  if (pending) return pending;

  const refresh = (async () => {
    const accessToken = await githubBaseRefresh(record);
    const login = recordLogin(record);
    if (login) {
      // Read back what makeRefresh persisted: GitHub rotates the refresh token
      // on every use, and the siblings need the new one, not the spent one.
      const stored = getOAuthToken('github', record.scopeType, record.scopeId);
      await propagateGitHubToken(
        login,
        {
          accessToken,
          refreshToken: stored?.refreshToken ?? null,
          expiresAt: stored?.expiresAt ?? null,
        },
        record
      );
    }
    return accessToken;
  })();

  refreshesInFlight.set(key, refresh);
  try {
    return await refresh;
  } finally {
    refreshesInFlight.delete(key);
  }
}

/** How many sibling tokens we probe against GitHub before giving up. */
const MAX_SIBLING_PROBES = 5;

/**
 * Recover a token GitHub has just rejected, before asking a human to reconnect:
 *   1. refresh it, when it carries a refresh token;
 *   2. otherwise adopt a live token stored for the same GitHub account under
 *      another scope — after a sibling reconnect that is precisely the token
 *      that revoked this one, so it is the one GitHub still honours.
 * Returns a usable token, or null when nothing recovered it.
 */
async function recoverRejectedGitHubToken(record: OAuthTokenRecord): Promise<string | null> {
  const login = recordLogin(record);

  if (record.refreshToken) {
    try {
      const refreshed = await refreshGitHubToken(record);
      if (await isGitHubTokenUsable(refreshed)) return refreshed;
    } catch (err) {
      console.warn(
        `[GitHub] Could not refresh the rejected ${record.scopeType} token:`,
        errorMessage(err)
      );
    }
  }

  if (!login) return null;
  const probed = new Set([record.accessToken]);
  for (const sibling of await listOAuthTokensByProvider('github')) {
    if (recordLogin(sibling) !== login || probed.has(sibling.accessToken)) continue;
    if (probed.size >= MAX_SIBLING_PROBES) break;
    probed.add(sibling.accessToken);
    if (!(await isGitHubTokenUsable(sibling.accessToken))) continue;
    console.log(
      `✅ [GitHub] Recovered ${record.scopeType}:${record.scopeId} from the live "${login}" token ` +
        `held by ${sibling.scopeType}:${sibling.scopeId}`
    );
    await propagateGitHubToken(login, sibling, sibling);
    return sibling.accessToken;
  }
  return null;
}

/** Safe to return to clients; never includes a token or an upstream response. */
export class GitHubReconnectRequiredError extends Error {
  readonly code = 'GITHUB_RECONNECT_REQUIRED';

  constructor() {
    super(
      'GitHub rejected the configured credentials. Reconnect GitHub in the agent Plugins tab, then select the repository again.'
    );
    this.name = 'GitHubReconnectRequiredError';
  }
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
 *   agent → board OAuth token  →  server-wide GITHUB_TOKEN fallback.
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
 *      token against the GitHub API and, if it is definitively dead, try to
 *      recover it (refresh, or adopt the account's live token from another
 *      scope) and only then fall through to the server token instead of
 *      shipping credentials that cannot push.
 *
 * A *usable* per-scope OAuth token always wins; the server token only fills the
 * gap when none exists or the resolved one is dead beyond recovery. Without a
 * fallback, a definite 401 requires reconnection rather than shipping a
 * known-dead token.
 */
export async function getGitHubCredentialsForAgent(
  agentId: string | null,
  boardId: string | null = null
): Promise<{ token: string; login: string | null; provider: 'github' } | null> {
  const hit = await resolveOAuthTokenRecord('github', agentId, boardId, refreshGitHubToken);
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
      login: hit.scopeType === 'user' ? null : recordLogin(hit.record),
      provider: 'github' as const,
    };
    if (await isGitHubTokenUsable(oauthCreds.token)) return oauthCreds;

    // Rejected before its expiry — almost always because a newer authorization
    // for the same account revoked it. Self-heal instead of sending the owner
    // back to the Plugins tab.
    const recovered = await recoverRejectedGitHubToken(hit.record);
    if (recovered) return { ...oauthCreds, token: recovered };

    if (!envToken) throw new GitHubReconnectRequiredError();
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
    const response = await fetchWithRetry(GITHUB_TOKEN_URL, {
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

    // A GitHub App with expiring user tokens returns expires_in (8h) plus a
    // refresh_token; a classic OAuth App returns neither. Keeping them is what
    // turns "reconnect three times a day" into a silent background refresh.
    const refreshToken: string | null = data.refresh_token || null;
    const expiresAt: number | null = data.expires_in
      ? Date.now() + (Number(data.expires_in) - 60) * 1000
      : null;

    await storeOAuthToken(
      {
        provider: 'github',
        scopeType,
        scopeId,
        accessToken: data.access_token,
        refreshToken,
        expiresAt,
        meta: { scope: data.scope, tokenType: data.token_type, login },
      },
      { throwOnPersistError: true }
    );

    console.log(
      `✅ [GitHub] OAuth token stored for ${scopeType}:${scopeId} (${login || 'unknown'}) via redirect`
    );

    // This authorization revoked whatever token the account's other scopes were
    // holding, so hand them the new one before they start failing.
    if (login) {
      await propagateGitHubToken(
        login,
        { accessToken: data.access_token, refreshToken, expiresAt },
        { scopeType, scopeId }
      );
    }
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
  refreshTokenUrl: () => GITHUB_TOKEN_URL,
  // Without this GitHub answers in form-urlencoded and the response parses empty.
  refreshHeaders: { Accept: 'application/json' },
  refreshNotConfiguredError:
    'Cannot refresh the GitHub token: GITHUB_OAUTH_CLIENT_ID / GITHUB_OAUTH_CLIENT_SECRET are not set.',
};

/**
 * Bound lazily at call time, not at module init: `githubSpec` is declared below
 * the functions that use it, so evaluating this eagerly would hit its TDZ.
 */
const githubBaseRefresh = (record: OAuthTokenRecord) => makeRefresh(githubSpec)(record);

export function githubRoutes() {
  return oauthProviderRoutes(githubSpec);
}
