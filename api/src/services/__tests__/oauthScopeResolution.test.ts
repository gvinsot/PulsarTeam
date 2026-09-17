import test from 'node:test';
import assert from 'node:assert/strict';
import { getOAuthTokenCache, resolveOAuthTokenRecord } from '../database/oauthTokens.js';
import { setPool } from '../database/connection.js';

test.beforeEach(() => {
  setPool(null);
  getOAuthTokenCache().clear();
});
test('an unrelated user account is never adopted, even when it is the only account', async () => {
  getOAuthTokenCache().set('gmail:user:alice', {
    provider: 'gmail',
    scopeType: 'user',
    scopeId: 'alice',
    accessToken: 'alice-secret',
  });
  assert.equal(await resolveOAuthTokenRecord('gmail', 'bob-agent', 'bob-board'), null);
  assert.equal(await resolveOAuthTokenRecord('gmail', null, null), null);
});
test('agent connection takes precedence over its explicitly supplied board', async () => {
  for (const type of ['agent', 'board'] as const)
    getOAuthTokenCache().set(`gmail:${type}:${type}-1`, {
      provider: 'gmail',
      scopeType: type,
      scopeId: `${type}-1`,
      accessToken: `${type}-secret`,
    });
  assert.equal(
    (await resolveOAuthTokenRecord('gmail', 'agent-1', 'board-1'))?.accessToken,
    'agent-secret'
  );
  assert.equal(
    (await resolveOAuthTokenRecord('gmail', 'agent-2', 'board-1'))?.accessToken,
    'board-secret'
  );
});
test('an expired agent token refreshes without selecting a user account', async () => {
  getOAuthTokenCache().set('gmail:agent:a', {
    provider: 'gmail',
    scopeType: 'agent',
    scopeId: 'a',
    accessToken: 'old',
    refreshToken: 'refresh',
    expiresAt: 1,
  });
  getOAuthTokenCache().set('gmail:user:alice', {
    provider: 'gmail',
    scopeType: 'user',
    scopeId: 'alice',
    accessToken: 'unrelated',
  });
  assert.equal(
    (await resolveOAuthTokenRecord('gmail', 'a', null, async () => 'new'))?.accessToken,
    'new'
  );
  assert.equal(
    await resolveOAuthTokenRecord('gmail', 'a', null, async () => {
      throw new Error('revoked');
    }),
    null
  );
});
