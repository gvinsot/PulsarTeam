/**
 * OAuth account linking — who is allowed to adopt an existing local account.
 *
 * findOrCreateOAuthUser used to link any provider identity to the local account
 * whose username matched the address the provider reported. That address is not
 * a proof of anything unless the provider verified it: on the multi-tenant
 * Microsoft endpoints a `mail` attribute is set freely by whoever administers
 * the (anyone-can-create) tenant — Microsoft's own "nOAuth" advisory — and a
 * GitHub address can sit unverified. Matching one was therefore enough to be
 * handed the account it matched, including an admin's.
 *
 * These tests pin the rule: link on a verified address, refuse on an unverified
 * one, and never let the refusal quietly fall through to creating a duplicate.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

// ── In-memory fixtures backing the database mock ────────────────────────────
const usersByUsername: Record<string, any> = {
  'victim@example.com': { id: 'user-victim', username: 'victim@example.com', role: 'admin' },
};
const usersById: Record<string, any> = {
  'user-victim': usersByUsername['victim@example.com'],
};

mock.module('../database.js', {
  namedExports: {
    getUserByUsername: async (u: string) => usersByUsername[u] || null,
    getUserById: async (id: string) => usersById[id] || null,
    countUsers: async () => Object.keys(usersById).length,
    createUser: async () => ({}),
    isDatabaseConnected: () => true,
    getBoardById: async () => null,
    getBoardShare: async () => null,
    getProjectById: async () => null,
    hasProjectBoardAccess: async () => false,
    getUserByGoogleId: async () => null,
    createGoogleUser: async () => ({}),
    linkGoogleId: async () => {},
    getUserByMicrosoftId: async () => null,
    createMicrosoftUser: async () => ({}),
    linkMicrosoftId: async () => {},
    getUserByGitHubId: async () => null,
    createGitHubUser: async () => ({}),
    linkGitHubId: async () => {},
    acceptTerms: async () => {},
    completeTutorial: async () => {},
  },
});

mock.module('../userProvisioning.js', {
  namedExports: { provisionNewUser: async () => {} },
});

mock.module('../../secrets.js', {
  namedExports: {
    readSecret: () => 'test-secret-at-least-32-chars-long-xxxxx',
    readSecretOptional: () => undefined,
    invalidateSecret: () => {},
    validateProductionSecrets: () => {},
  },
});

const { findOrCreateOAuthUser, isSingleTenant, LoginError } =
  await import('../../routes/authLogin.js');

/** Records what the linking / creation hooks were asked to do. */
function spyHooks(existingByProviderId: any = null) {
  const calls = { linked: [] as any[], created: [] as any[] };
  return {
    calls,
    getByProviderId: async () => existingByProviderId,
    linkProviderId: async (userId: string, id: string) => {
      calls.linked.push({ userId, id });
    },
    createUser: async (id: string, loginUsername: string) => {
      calls.created.push({ id, loginUsername });
      return { id, username: loginUsername, role: 'advanced' };
    },
  };
}

test('an UNVERIFIED address must not adopt an existing account', async () => {
  const hooks = spyHooks();
  await assert.rejects(
    () =>
      findOrCreateOAuthUser({
        ...hooks,
        providerId: 'attacker-tenant-oid',
        loginUsername: 'victim@example.com',
        displayName: 'Not The Victim',
        avatarUrl: null,
        emailVerified: false,
        label: 'Microsoft',
      }),
    (err: any) => err instanceof LoginError && err.status === 403
  );
  // And the refusal is total: nothing linked, nothing created behind it.
  assert.deepEqual(hooks.calls.linked, []);
  assert.deepEqual(hooks.calls.created, []);
});

test('a missing emailVerified flag is treated as unverified', async () => {
  // Absent must not read as permissive — a provider spec that forgets the field
  // should fail closed rather than silently restore the old behaviour.
  const hooks = spyHooks();
  await assert.rejects(
    () =>
      findOrCreateOAuthUser({
        ...hooks,
        providerId: 'some-oid',
        loginUsername: 'victim@example.com',
        displayName: 'x',
        avatarUrl: null,
        label: 'GitHub',
      }),
    (err: any) => err instanceof LoginError && err.status === 403
  );
  assert.deepEqual(hooks.calls.linked, []);
});

test('a VERIFIED address links to the existing account', async () => {
  const hooks = spyHooks();
  const user = await findOrCreateOAuthUser({
    ...hooks,
    providerId: 'google-123',
    loginUsername: 'victim@example.com',
    displayName: 'The Victim',
    avatarUrl: null,
    emailVerified: true,
    label: 'Google',
  });
  assert.deepEqual(hooks.calls.linked, [{ userId: 'user-victim', id: 'google-123' }]);
  assert.equal(user.id, 'user-victim');
});

test('an unverified address with NO local match still creates its own account', async () => {
  // The rule guards adoption of someone else's account, not sign-up. A brand
  // new address has nothing to steal.
  const hooks = spyHooks();
  const user = await findOrCreateOAuthUser({
    ...hooks,
    providerId: 'gh-999',
    loginUsername: 'newcomer@users.noreply.github.com',
    displayName: 'Newcomer',
    avatarUrl: null,
    emailVerified: false,
    label: 'GitHub',
  });
  assert.equal(hooks.calls.created.length, 1);
  assert.equal(user.username, 'newcomer@users.noreply.github.com');
});

test('a known provider id short-circuits before the address is consulted', async () => {
  // A returning user is identified by the immutable provider id, so the
  // verification rule never even applies to them.
  const known = { id: 'user-known', username: 'known@example.com', role: 'advanced' };
  const hooks = spyHooks(known);
  const user = await findOrCreateOAuthUser({
    ...hooks,
    providerId: 'ms-oid-known',
    loginUsername: 'victim@example.com', // would have matched the admin
    displayName: 'Known',
    avatarUrl: null,
    emailVerified: false,
    label: 'Microsoft',
  });
  assert.equal(user.id, 'user-known');
  assert.deepEqual(hooks.calls.linked, []);
});

test('only a real tenant id counts as single-tenant', () => {
  // These three are the multi-tenant endpoints: sign-ins arrive from directories
  // this deployment does not control, so their email claims are not authoritative.
  for (const t of ['common', 'organizations', 'consumers', 'COMMON', '', undefined, null]) {
    assert.equal(isSingleTenant(t), false, `${t} must not read as single-tenant`);
  }
  assert.equal(isSingleTenant('72f988bf-86f1-41af-91ab-2d7cd011db47'), true);
  assert.equal(isSingleTenant('contoso.onmicrosoft.com'), true);
});
