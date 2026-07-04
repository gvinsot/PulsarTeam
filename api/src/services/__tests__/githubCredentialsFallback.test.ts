/**
 * getGitHubCredentialsForAgent — server GITHUB_TOKEN fallback.
 *
 * Root cause of "some agents can push, some can't": credentials came ONLY from
 * a per-scope (agent/board/user) GitHub OAuth token. Agents on a board that
 * never connected the GitHub plugin resolved to null → no ~/.git-credentials in
 * the runner → `git push` dies with "could not read Username". Operators can
 * configure a server-wide GITHUB_TOKEN (documented in .env.example) but it was
 * never consulted. These tests lock in: OAuth token wins when present; the
 * server token fills the gap; null only when neither exists.
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

function setEnvToken(token: string | undefined, user?: string) {
  if (token === undefined) delete process.env.GITHUB_TOKEN;
  else process.env.GITHUB_TOKEN = token;
  if (user === undefined) delete process.env.GITHUB_USER;
  else process.env.GITHUB_USER = user;
  invalidateSecret('GITHUB_TOKEN'); // readSecret caches — clear between cases
}

test('per-scope OAuth token wins over the server GITHUB_TOKEN', async () => {
  dbState.hit = { accessToken: 'oauth-tok', scopeType: 'board', record: { meta: { login: 'octocat' } } };
  setEnvToken('server-pat', 'serverbot');
  const creds = await getGitHubCredentialsForAgent('agent-1', 'board-1');
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
