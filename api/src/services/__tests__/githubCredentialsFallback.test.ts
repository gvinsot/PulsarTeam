/**
 * getGitHubCredentialsForAgent — server GITHUB_TOKEN fallback.
 *
 * Root cause of "some agents can push, some can't": credentials came ONLY from
 * a per-scope (agent/board/user) GitHub OAuth token. Two failure modes:
 *   1. Agents on a board that never connected the GitHub plugin resolved to
 *      null → no ~/.git-credentials in the runner → `git push` dies with
 *      "could not read Username".
 *   2. An agent WITH the plugin connected but whose OAuth token is
 *      expired/revoked resolved to that dead token and shipped it anyway, with
 *      no fallback — every push died with HTTP 401.
 * Operators can configure a server-wide GITHUB_TOKEN (documented in
 * .env.example) but it was never consulted in either case. These tests lock in:
 * a *usable* OAuth token wins; a dead one falls back to the server token when
 * one exists; the server token fills the gap when no OAuth token exists; null
 * only when neither exists.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as realDb from '../database.js';

// Control the OAuth resolver; keep the rest of database.js real (its full export
// surface is needed by github.ts's transitive imports).
const dbState: { hit: any } = { hit: null };
mock.module('../database.js', {
  namedExports: { ...realDb, resolveOAuthTokenRecord: async () => dbState.hit },
});

const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
const { invalidateSecret } = await import('../../secrets.js');

const realFetch = globalThis.fetch;

/**
 * Stub the GitHub `GET /user` liveness check. `status` is what the API returns
 * for the token (200 = usable, 401 = dead); 'network' throws to simulate a
 * transient failure. Restored via t.after(restoreFetch) in each case.
 */
function stubTokenCheck(status: number | 'network') {
  globalThis.fetch = (async () => {
    if (status === 'network') throw new Error('ECONNRESET');
    return new Response('{}', { status });
  }) as typeof fetch;
}
function restoreFetch() {
  globalThis.fetch = realFetch;
}

function setEnvToken(token: string | undefined, user?: string) {
  if (token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = token;
  if (user === undefined) delete process.env.GITHUB_USER;
  else process.env.GITHUB_USER = user;
  invalidateSecret('GITHUB_TOKEN'); // readSecret caches — clear between cases
}

test('a usable per-scope OAuth token wins over the server GITHUB_TOKEN', async (t) => {
  dbState.hit = { accessToken: 'oauth-tok', scopeType: 'board', record: { meta: { login: 'octocat' } } };
  setEnvToken('server-pat', 'serverbot');
  stubTokenCheck(200); // GitHub accepts the OAuth token
  t.after(restoreFetch);
  const creds = await getGitHubCredentialsForAgent('agent-1', 'board-1');
  assert.deepEqual(creds, { token: 'oauth-tok', login: 'octocat', provider: 'github' });
});

test('a dead OAuth token falls back to the server GITHUB_TOKEN', async (t) => {
  dbState.hit = { accessToken: 'expired-tok', scopeType: 'board', record: { meta: { login: 'octocat' } } };
  setEnvToken('server-pat', 'serverbot');
  stubTokenCheck(401); // GitHub rejects the expired OAuth token
  t.after(restoreFetch);
  const creds = await getGitHubCredentialsForAgent('agent-1b', 'board-1b');
  assert.deepEqual(creds, { token: 'server-pat', login: 'serverbot', provider: 'github' });
});

test('a dead OAuth token is kept when there is no server fallback (best we have)', async (t) => {
  dbState.hit = { accessToken: 'expired-tok', scopeType: 'board', record: { meta: { login: 'octocat' } } };
  setEnvToken(undefined); // no server token → nothing better to switch to
  // With no fallback we must NOT even make the liveness call — assert that.
  globalThis.fetch = (async () => { throw new Error('should not validate without a fallback'); }) as typeof fetch;
  t.after(restoreFetch);
  const creds = await getGitHubCredentialsForAgent('agent-1c', 'board-1c');
  assert.deepEqual(creds, { token: 'expired-tok', login: 'octocat', provider: 'github' });
});

test('a transient liveness-check failure keeps the OAuth token (no false fallback)', async (t) => {
  dbState.hit = { accessToken: 'oauth-tok', scopeType: 'board', record: { meta: { login: 'octocat' } } };
  setEnvToken('server-pat', 'serverbot');
  stubTokenCheck('network'); // check itself errors out — token is not proven dead
  t.after(restoreFetch);
  const creds = await getGitHubCredentialsForAgent('agent-1d', 'board-1d');
  assert.deepEqual(creds, { token: 'oauth-tok', login: 'octocat', provider: 'github' });
});

test('falls back to server GITHUB_TOKEN + GITHUB_USER when no OAuth token', async () => {
  dbState.hit = null;
  setEnvToken('server-pat', 'serverbot');
  const creds = await getGitHubCredentialsForAgent('agent-2', 'board-2');
  assert.deepEqual(creds, { token: 'server-pat', login: 'serverbot', provider: 'github' });
});

test('server token with no GITHUB_USER reports login null (runner uses x-access-token)', async () => {
  dbState.hit = null;
  setEnvToken('server-pat'); // no user
  const creds = await getGitHubCredentialsForAgent('agent-3', null);
  assert.deepEqual(creds, { token: 'server-pat', login: null, provider: 'github' });
});

test('a whitespace-only GITHUB_TOKEN is treated as unset', async () => {
  dbState.hit = null;
  setEnvToken('   ');
  const creds = await getGitHubCredentialsForAgent('agent-4', null);
  assert.equal(creds, null);
});

test('returns null when neither an OAuth token nor GITHUB_TOKEN exists', async () => {
  dbState.hit = null;
  setEnvToken(undefined);
  const creds = await getGitHubCredentialsForAgent('agent-5', 'board-5');
  assert.equal(creds, null);
});
