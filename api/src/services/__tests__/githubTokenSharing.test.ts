/**
 * GitHub tokens: expiry-aware storage + one live credential per GitHub account.
 *
 * Root cause of "I constantly have to re-authenticate GitHub for my agents":
 * PulsarTeam treated a GitHub user token as an eternal, per-scope credential.
 * Both halves of that are wrong for a GitHub App:
 *   1. The token expires after 8h and comes with a refresh_token — which the
 *      callback threw away, so the only way back was a manual reconnect.
 *   2. Authorizing again as the same GitHub user REVOKES the token minted by the
 *      previous authorization. With one copy stored per agent/board, connecting
 *      agent N silently killed agents 1..N-1; production logs showed five agents
 *      being re-authorized in rotation all day, each fixing one and breaking the
 *      last.
 * These tests lock in: the refresh token and expiry are persisted; a new
 * authorization is shared with the account's other connections; a rejected token
 * is recovered (by refresh, or by adopting the account's live token) instead of
 * demanding a reconnect; and connections for a *different* GitHub account are
 * never touched.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as realDb from '../database.js';
import type { OAuthTokenRecord } from '../database.js';

process.env.JWT_SECRET = 'github-token-sharing-test-secret';
process.env.GITHUB_OAUTH_CLIENT_ID = 'test-client-id';
process.env.GITHUB_OAUTH_CLIENT_SECRET = 'test-client-secret';
delete process.env.GITHUB_TOKEN; // no server-wide fallback: exercise the OAuth paths

// ---------------------------------------------------------------- fake store

const store = new Map<string, OAuthTokenRecord>();
const storeKey = (scopeType: string, scopeId: string) => `${scopeType}:${scopeId}`;

function seed(scopeType: string, scopeId: string, rec: Partial<OAuthTokenRecord>) {
  store.set(storeKey(scopeType, scopeId), {
    provider: 'github',
    scopeType: scopeType as any,
    scopeId,
    accessToken: 'seeded',
    ...rec,
  } as OAuthTokenRecord);
}

const resolved: { hit: any } = { hit: null };

mock.module('../database.js', {
  namedExports: {
    ...realDb,
    storeOAuthToken: async (rec: OAuthTokenRecord) => {
      store.set(storeKey(rec.scopeType, rec.scopeId), { ...rec });
    },
    getOAuthToken: (_p: string, scopeType: string, scopeId: string) =>
      store.get(storeKey(scopeType, scopeId)) || null,
    listOAuthTokensByProvider: async () => [...store.values()],
    resolveOAuthTokenRecord: async () => resolved.hit,
  },
});

const { getGitHubCredentialsForAgent, githubOAuthRedirectRouter } =
  await import('../../routes/github.js');
const { createOAuthStateStore } = await import('../../routes/oauthState.js');
const { invalidateSecret } = await import('../../secrets.js');
invalidateSecret('JWT_SECRET');
invalidateSecret('GITHUB_OAUTH_CLIENT_SECRET');

// ---------------------------------------------------------------- fake GitHub

interface GitHubStub {
  /** Tokens GitHub still honours; anything else gets a 401 from GET /user. */
  live: Set<string>;
  /** Response for the token endpoint (code exchange and refresh alike). */
  grant: Record<string, unknown> | null;
  /** Bodies posted to the token endpoint, for asserting the grant type. */
  grants: string[];
}

const realFetch = globalThis.fetch;
let gh: GitHubStub;

function stubGitHub(init: Partial<GitHubStub> = {}) {
  gh = { live: new Set(), grant: null, grants: [], ...init };
  globalThis.fetch = (async (url: any, opts: any = {}) => {
    const href = String(url);
    if (href.startsWith('https://github.com/login/oauth/access_token')) {
      gh.grants.push(String(opts.body ?? ''));
      if (!gh.grant)
        return new Response(JSON.stringify({ error: 'bad_refresh_token' }), { status: 200 });
      return new Response(JSON.stringify(gh.grant), { status: 200 });
    }
    if (href === 'https://api.github.com/user') {
      const token = String(opts.headers?.Authorization || '').replace('Bearer ', '');
      if (!gh.live.has(token)) return new Response('{}', { status: 401 });
      return new Response(JSON.stringify({ login: 'gvinsot' }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
}

function reset() {
  store.clear();
  resolved.hit = null;
  globalThis.fetch = realFetch;
}

/** Drive the real /oauth-redirect handler with a state this process signed. */
async function completeOAuthRedirect(agentId: string | null, boardId: string | null) {
  // Same HKDF domain + JWT_SECRET as github.ts ⇒ the state verifies there.
  const states = createOAuthStateStore<{
    username: string;
    agentId: string | null;
    boardId: string | null;
  }>('github');
  const state = states.generate({ username: 'gildas', agentId, boardId });

  const router = githubOAuthRedirectRouter();
  const req: any = {
    method: 'GET',
    url: `/oauth-redirect?code=abc&state=${encodeURIComponent(state)}`,
    query: { code: 'abc', state },
    protocol: 'https',
    headers: { host: 'pulsarteam.io' },
    get: (h: string) => (h.toLowerCase() === 'host' ? 'pulsarteam.io' : undefined),
  };
  return await new Promise<string>((resolve, reject) => {
    const res: any = {
      setHeader() {},
      status() {
        return res;
      },
      send: (body: string) => resolve(body),
      json: (body: unknown) => resolve(JSON.stringify(body)),
    };
    router(req, res, (err: unknown) => (err ? reject(err) : resolve('')));
  });
}

// ---------------------------------------------------------------------- tests

test('the callback persists the refresh token and expiry (no more 8-hourly reconnect)', async t => {
  reset();
  t.after(reset);
  stubGitHub({
    live: new Set(['fresh-token']),
    grant: {
      access_token: 'fresh-token',
      refresh_token: 'refresh-1',
      expires_in: 28800,
      token_type: 'bearer',
      scope: 'repo',
    },
  });

  const body = await completeOAuthRedirect('agent-a', null);
  assert.match(body, /success/i);

  const stored = store.get(storeKey('agent', 'agent-a'))!;
  assert.equal(stored.accessToken, 'fresh-token');
  assert.equal(stored.refreshToken, 'refresh-1');
  assert.ok(stored.expiresAt && stored.expiresAt > Date.now(), 'expiry recorded');
  assert.equal((stored.meta as any).login, 'gvinsot');
});

test('a new authorization is shared with the same account, not with other accounts', async t => {
  reset();
  t.after(reset);
  // Two agents already connected as gvinsot, one connected as a different user.
  seed('agent', 'agent-a', { accessToken: 'old-a', meta: { login: 'gvinsot' } });
  seed('agent', 'agent-b', { accessToken: 'old-b', meta: { login: 'gvinsot' } });
  seed('agent', 'agent-c', { accessToken: 'other', meta: { login: 'ceo-intramuros' } });
  seed('board', 'board-x', { accessToken: 'no-login-recorded', meta: {} });

  stubGitHub({
    live: new Set(['fresh-token']),
    grant: { access_token: 'fresh-token', refresh_token: 'refresh-1', expires_in: 28800 },
  });

  await completeOAuthRedirect('agent-b', null);

  // Every gvinsot connection now holds the one token GitHub considers live…
  assert.equal(store.get(storeKey('agent', 'agent-b'))!.accessToken, 'fresh-token');
  assert.equal(store.get(storeKey('agent', 'agent-a'))!.accessToken, 'fresh-token');
  assert.equal(store.get(storeKey('agent', 'agent-a'))!.refreshToken, 'refresh-1');
  // …while a different account, and a connection of unknown identity, are left alone.
  assert.equal(store.get(storeKey('agent', 'agent-c'))!.accessToken, 'other');
  assert.equal(store.get(storeKey('board', 'board-x'))!.accessToken, 'no-login-recorded');
});

test('a rejected token is refreshed instead of demanding a reconnect', async t => {
  reset();
  t.after(reset);
  seed('agent', 'agent-a', {
    accessToken: 'revoked',
    refreshToken: 'refresh-1',
    meta: { login: 'gvinsot' },
  });
  seed('agent', 'agent-b', { accessToken: 'revoked', meta: { login: 'gvinsot' } });
  resolved.hit = {
    accessToken: 'revoked',
    scopeType: 'agent',
    record: store.get(storeKey('agent', 'agent-a')),
  };
  stubGitHub({
    live: new Set(['renewed']),
    grant: { access_token: 'renewed', refresh_token: 'refresh-2', expires_in: 28800 },
  });

  const creds = await getGitHubCredentialsForAgent('agent-a', null);
  assert.deepEqual(creds, { token: 'renewed', login: 'gvinsot', provider: 'github' });
  assert.match(gh.grants[0], /grant_type=refresh_token/);
  // The rotated refresh token reaches the sibling too, so it can refresh next time.
  const sibling = store.get(storeKey('agent', 'agent-b'))!;
  assert.equal(sibling.accessToken, 'renewed');
  assert.equal(sibling.refreshToken, 'refresh-2');
});

test('without a refresh token, the account’s live token is adopted from another scope', async t => {
  reset();
  t.after(reset);
  // agent-b was reconnected a moment ago, which is exactly what revoked agent-a's token.
  seed('agent', 'agent-a', { accessToken: 'revoked', meta: { login: 'gvinsot' } });
  seed('agent', 'agent-b', { accessToken: 'reconnected', meta: { login: 'gvinsot' } });
  resolved.hit = {
    accessToken: 'revoked',
    scopeType: 'agent',
    record: store.get(storeKey('agent', 'agent-a')),
  };
  stubGitHub({ live: new Set(['reconnected']) });

  const creds = await getGitHubCredentialsForAgent('agent-a', null);
  assert.deepEqual(creds, { token: 'reconnected', login: 'gvinsot', provider: 'github' });
  // …and agent-a is healed in the store, so the next run costs no probing.
  assert.equal(store.get(storeKey('agent', 'agent-a'))!.accessToken, 'reconnected');
});

test('a live token belonging to another GitHub account is never adopted', async t => {
  reset();
  t.after(reset);
  seed('agent', 'agent-a', { accessToken: 'revoked', meta: { login: 'gvinsot' } });
  seed('agent', 'agent-c', { accessToken: 'someone-else', meta: { login: 'ceo-intramuros' } });
  resolved.hit = {
    accessToken: 'revoked',
    scopeType: 'agent',
    record: store.get(storeKey('agent', 'agent-a')),
  };
  stubGitHub({ live: new Set(['someone-else']) });

  await assert.rejects(getGitHubCredentialsForAgent('agent-a', null), {
    code: 'GITHUB_RECONNECT_REQUIRED',
  });
  assert.equal(store.get(storeKey('agent', 'agent-a'))!.accessToken, 'revoked');
});

test('a failed refresh with nothing to adopt still asks for a reconnect', async t => {
  reset();
  t.after(reset);
  seed('agent', 'agent-a', {
    accessToken: 'revoked',
    refreshToken: 'expired-refresh',
    meta: { login: 'gvinsot' },
  });
  resolved.hit = {
    accessToken: 'revoked',
    scopeType: 'agent',
    record: store.get(storeKey('agent', 'agent-a')),
  };
  stubGitHub({ live: new Set(), grant: null }); // token endpoint answers bad_refresh_token

  await assert.rejects(getGitHubCredentialsForAgent('agent-a', null), {
    code: 'GITHUB_RECONNECT_REQUIRED',
  });
});
