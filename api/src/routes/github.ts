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

const STATE_TTL_MS = 10 * 60 * 1000;

// States are HMAC-signed and stateless so an API restart/redeploy between
// /auth-url and the provider redirect does not invalidate in-flight consent
// popups. The consumed set below only guards against replay within this
// process; after a restart a state could be replayed until its TTL expires,
// which is acceptable because the authorization code is single-use at GitHub.
const consumedStates = new Map<string, number>();

let fallbackStateSecret: Buffer | null = null;
function getStateSecret(): Buffer {
  const jwt = readSecret('JWT_SECRET', '');
  if (jwt) {
    // Domain-separate from JWT signing and from the other providers' states.
    return Buffer.from(
      crypto.hkdfSync('sha256', Buffer.from(jwt, 'utf-8'), Buffer.alloc(0), Buffer.from('pulsarteam:oauth-state:github:v1', 'utf-8'), 32)
    );
  }
  // Dev fallback without JWT_SECRET: per-process key (states then only
  // survive within this process, as with the previous in-memory store).
  if (!fallbackStateSecret) fallbackStateSecret = crypto.randomBytes(32);
  return fallbackStateSecret;
}

function signStatePayload(payload: string): string {
  return crypto.createHmac('sha256', getStateSecret()).update(payload).digest('base64url');
}

function generateOAuthState(username, agentId = null, boardId = null) {
  const now = Date.now();
  for (const [k, exp] of consumedStates) { if (exp < now) consumedStates.delete(k); }
  const payload = Buffer.from(
    JSON.stringify({ username, agentId, boardId, expiresAt: now + STATE_TTL_MS, nonce: crypto.randomBytes(8).toString('hex') }),
    'utf-8',
  ).toString('base64url');
  return `${payload}.${signStatePayload(payload)}`;
}

function consumeOAuthState(state) {
  const dot = state.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = state.slice(0, dot);
  const signature = Buffer.from(state.slice(dot + 1));
  const expected = Buffer.from(signStatePayload(payload));
  if (signature.length !== expected.length || !crypto.timingSafeEqual(signature, expected)) return null;

  let entry;
  try {
    entry = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
  if (!entry || typeof entry.expiresAt !== 'number' || entry.expiresAt < Date.now()) return null;
  if (consumedStates.has(state)) return null;
  consumedStates.set(state, entry.expiresAt);
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
  // Try agent then board scope first (cheap, in-memory)
  const directScopes: Array<{ type: ScopeType; id: string }> = [];
  if (agentId) directScopes.push({ type: 'agent', id: agentId });
  if (boardId) directScopes.push({ type: 'board', id: boardId });

  for (const scope of directScopes) {
    const tok = getOAuthToken('github', scope.type, scope.id);
    if (tok && tok.accessToken) {
      return {
        token: tok.accessToken,
        login: (tok.meta && (tok.meta as any).login) || null,
        provider: 'github',
      };
    }
  }

  // Fall back to user-level via the unified resolver (which scans user-scoped
  // tokens). resolveAccessToken throws when nothing matches — swallow that.
  try {
    const token = await resolveAccessToken('github', agentId, boardId);
    return { token, login: null, provider: 'github' };
  } catch {
    return null;
  }
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
      return res.status(500).json({ error: 'GitHub OAuth not configured. Set GITHUB_OAUTH_CLIENT_ID and GITHUB_OAUTH_CLIENT_SECRET.' });
    }

    const agentId = req.query.agentId || null;
    const boardId = req.query.boardId || null;
    const state = generateOAuthState(req.user?.username || 'default', agentId, boardId);

    const params = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: pluginRedirectUri(req),
      scope: 'repo read:org read:user',
      state,
    });

    res.json({ authUrl: `https://github.com/login/oauth/authorize?${params}` });
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
