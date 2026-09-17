import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, sessionCookies, permissionOrigins } from './core.mjs';

test('cookie permissions include exact parents but stop at public and private suffixes', () => {
  assert.deepEqual(permissionOrigins('https://login.example.co.uk', 'https://pulsar.test'), [
    'https://login.example.co.uk/*',
    'https://pulsar.test/*',
    'https://example.co.uk/*',
  ]);
  assert.deepEqual(permissionOrigins('https://www.tenant.github.io', 'https://pulsar.test'), [
    'https://www.tenant.github.io/*',
    'https://pulsar.test/*',
    'https://tenant.github.io/*',
  ]);
  assert.throws(() => permissionOrigins('https://other.pulsar.test', 'https://app.pulsar.test'));
});

const now = Date.now();
const request = {
  version: 1,
  requestId: 'a'.repeat(8) + '-aaaa-aaaa-aaaa-' + 'a'.repeat(12),
  scope: 'board:selected',
  expiresAt: now + 600_000,
  site: 'https://www.site.test',
};
test('pairing requires exact HTTPS site, explicit scope and short expiry', () => {
  assert.equal(validateRequest(request, 'https://pulsar.test/', now).scope, 'board:selected');
  for (const patch of [
    { expiresAt: now },
    { expiresAt: now + 999_999 },
    { scope: 'user:first' },
    { site: 'https://pulsar.test' },
    { site: 'http://site.test' },
    { site: 'https://user:password@site.test' },
    { site: 'https://site.test:8443' },
  ]) {
    assert.throws(() => validateRequest({ ...request, ...patch }, 'https://pulsar.test', now));
  }
});
test('only selected-host cookies transfer; HttpOnly survives, parent scope does not', () => {
  const cookie = {
    name: 'session',
    value: 'synthetic-secret',
    domain: '.site.test',
    path: '/',
    httpOnly: true,
    session: true,
    sameSite: 'no_restriction',
    hostOnly: false,
  };
  const result = sessionCookies(
    [
      cookie,
      { ...cookie, domain: '.other.test' },
      { ...cookie, domain: '.evilsite.test' },
      { ...cookie, domain: 'site.test', hostOnly: true },
    ],
    request.site
  );
  assert.deepEqual(result, [
    {
      name: 'session',
      value: 'synthetic-secret',
      path: '/',
      expires: -1,
      httpOnly: true,
      sameSite: 'None',
    },
  ]);
  assert.throws(() =>
    sessionCookies([cookie, { ...cookie, domain: 'www.site.test' }], request.site)
  );
  assert.throws(() =>
    sessionCookies(
      [{ ...cookie, partitionKey: { topLevelSite: 'https://site.test' } }],
      request.site
    )
  );
});
