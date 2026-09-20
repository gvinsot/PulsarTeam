import test from 'node:test';
import assert from 'node:assert/strict';
import {
  httpsOrigin,
  validateRequest,
  sessionCookies,
  permissionOrigins,
  transferUrl,
} from './core.mjs';
import { ExtensionError } from './errors.mjs';

const errorCode = code => error => error instanceof ExtensionError && error.code === code;

test('transfer preserves the signed-in page and rejects login and identity-provider pages', () => {
  assert.equal(
    transferUrl('https://www.site.test/feed?view=recent', 'https://www.site.test'),
    'https://www.site.test/feed?view=recent'
  );
  for (const url of [
    'https://accounts.google.com/',
    'https://www.site.test/login',
    'https://www.site.test/authwall',
    'https://www.site.test/callback?code=secret',
    'https://www.site.test/#access_token=secret',
  ]) {
    assert.throws(() => transferUrl(url, 'https://www.site.test'));
  }
});

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
  assert.throws(
    () => permissionOrigins('https://other.pulsar.test', 'https://app.pulsar.test'),
    errorCode('APP_DOMAIN_FORBIDDEN')
  );
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
  for (const [patch, code] of [
    [{ expiresAt: now }, 'REQUEST_INVALID'],
    [{ expiresAt: now + 999_999 }, 'REQUEST_INVALID'],
    [{ scope: 'user:first' }, 'REQUEST_INVALID'],
    [{ site: 'https://pulsar.test' }, 'SITE_MUST_DIFFER'],
    [{ site: 'https://site.test/path' }, 'SITE_MUST_DIFFER'],
    [{ site: 'http://site.test' }, 'HTTPS_REQUIRED'],
    [{ site: 'https://user:password@site.test' }, 'HTTPS_REQUIRED'],
    [{ site: 'https://site.test:8443' }, 'HTTPS_REQUIRED'],
  ]) {
    assert.throws(
      () => validateRequest({ ...request, ...patch }, 'https://pulsar.test', now),
      errorCode(code)
    );
  }
});

test('malformed URLs expose only a safe HTTPS error', () => {
  assert.throws(() => httpsOrigin('not-an-origin/synthetic-secret'), errorCode('HTTPS_REQUIRED'));
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
  assert.deepEqual(
    sessionCookies([cookie, { ...cookie, domain: 'www.site.test' }], request.site),
    result
  );
  assert.throws(
    () =>
      sessionCookies(
        [{ ...cookie, partitionKey: { topLevelSite: 'https://site.test' } }],
        request.site
      ),
    errorCode('PARTITIONED_COOKIES')
  );
});

const linkedinCookie = {
  name: 'JSESSIONID',
  value: 'synthetic-session',
  domain: '.linkedin.com',
  path: '/',
  httpOnly: true,
  session: false,
  expirationDate: now / 1000 + 3600,
  sameSite: 'no_restriction',
  hostOnly: false,
};
const linkedinHostCookie = { ...linkedinCookie, domain: 'www.linkedin.com', hostOnly: true };
const linkedinSite = 'https://www.linkedin.com';

test('identical LinkedIn parent and host cookies merge without widening their scope', () => {
  const expected = sessionCookies([linkedinCookie], linkedinSite);
  for (const cookies of [
    [linkedinCookie, linkedinHostCookie],
    [linkedinHostCookie, linkedinCookie],
  ]) {
    const actual = sessionCookies(cookies, linkedinSite);
    assert.deepEqual(actual, expected);
    assert.equal(actual.length, 1);
    assert.equal('domain' in actual[0], false);
  }
});

test('homonymous LinkedIn cookies with different imported fields remain ambiguous', () => {
  for (const patch of [
    { value: 'different-synthetic-session' },
    { httpOnly: false },
    { expirationDate: linkedinCookie.expirationDate + 1 },
    { session: true },
    { sameSite: 'strict' },
    { sameSite: 'lax' },
  ]) {
    for (const cookies of [
      [linkedinCookie, { ...linkedinHostCookie, ...patch }],
      [{ ...linkedinHostCookie, ...patch }, linkedinCookie],
    ]) {
      assert.throws(() => sessionCookies(cookies, linkedinSite), errorCode('AMBIGUOUS_COOKIES'));
    }
  }
});

test('identical partitioned cookies cannot be merged into an ordinary cookie', () => {
  const partitioned = {
    ...linkedinHostCookie,
    partitionKey: { topLevelSite: linkedinSite },
  };
  for (const cookies of [
    [linkedinCookie, partitioned],
    [partitioned, linkedinCookie],
  ]) {
    assert.throws(() => sessionCookies(cookies, linkedinSite), errorCode('PARTITIONED_COOKIES'));
  }
});

test('distinct cookie paths remain distinct and expired cookies cannot create ambiguity', () => {
  const cookies = sessionCookies(
    [
      linkedinCookie,
      { ...linkedinHostCookie, path: '/feed', value: 'different-path-session' },
      { ...linkedinHostCookie, expirationDate: now / 1000 - 1, value: 'expired-session' },
    ],
    linkedinSite,
    now / 1000
  );
  assert.deepEqual(
    cookies.map(cookie => cookie.path),
    ['/', '/feed']
  );
});

test('export retains the cookie-count limit after identical duplicates are merged', () => {
  const cookies = Array.from({ length: 200 }, (_, index) => ({
    ...linkedinCookie,
    name: `cookie-${index}`,
  }));
  assert.equal(sessionCookies([...cookies, { ...cookies[0] }], linkedinSite).length, 200);
  assert.throws(
    () => sessionCookies([...cookies, { ...linkedinCookie, name: 'one-too-many' }], linkedinSite),
    errorCode('TOO_MANY_COOKIES')
  );
});
