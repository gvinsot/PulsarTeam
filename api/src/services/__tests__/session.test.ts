/**
 * Tests for middleware/session — cookie naming, session JWT minting/verification,
 * credential extraction and the constant-time CSRF comparison.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import type { Response } from 'express';

// A deterministic, sufficiently long signing key. Set before any token is
// minted; getJwtSecret() reads it lazily, so assigning it after the imports is
// fine (readSecret only caches values that came from /run/secrets).
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars-long';

import {
  SESSION_COOKIE_PLAIN,
  SESSION_COOKIE_SECURE,
  SESSION_TTL_SECONDS,
  clearSessionCookie,
  csrfMatches,
  readBearerToken,
  readSessionCookie,
  resolveSessionToken,
  sessionCookieName,
  setSessionCookie,
  signSessionToken,
  verifySessionToken,
} from '../../middleware/session.js';

const USER = { userId: 'u-1', username: 'gigi', role: 'admin' };

interface CookieCall {
  name: string;
  value?: string;
  opts: Record<string, unknown>;
}

/** Minimal Express `res` that records cookie writes. */
function makeRes(): { res: Response; set: CookieCall[]; cleared: CookieCall[] } {
  const set: CookieCall[] = [];
  const cleared: CookieCall[] = [];
  const res = {
    cookie(name: string, value: string, opts: Record<string, unknown>) {
      set.push({ name, value, opts });
      return res;
    },
    clearCookie(name: string, opts: Record<string, unknown>) {
      cleared.push({ name, opts });
      return res;
    },
  };
  return { res: res as unknown as Response, set, cleared };
}

// ── Cookie naming ────────────────────────────────────────────────────────────

test('sessionCookieName uses the __Host- prefix in production', () => {
  assert.equal(sessionCookieName(true), '__Host-pt_session');
  assert.equal(sessionCookieName(true), SESSION_COOKIE_SECURE);
});

test('sessionCookieName drops the prefix outside production', () => {
  assert.equal(sessionCookieName(false), 'pt_session');
  assert.equal(sessionCookieName(false), SESSION_COOKIE_PLAIN);
});

// ── Minting and verifying ────────────────────────────────────────────────────

test('signSessionToken returns both a token and a CSRF token', () => {
  const { token, csrfToken } = signSessionToken(USER);
  assert.equal(typeof token, 'string');
  assert.ok(token.length > 0);
  assert.equal(typeof csrfToken, 'string');
  assert.ok(csrfToken.length >= 32, 'csrf token should carry real entropy');
});

test('verifySessionToken round-trips the claims and the csrf binding', () => {
  const { token, csrfToken } = signSessionToken(USER);
  const claims = verifySessionToken(token);
  assert.ok(claims);
  assert.equal(claims.userId, 'u-1');
  assert.equal(claims.username, 'gigi');
  assert.equal(claims.role, 'admin');
  assert.equal(claims.csrf, csrfToken);
  assert.equal(typeof claims.exp, 'number');
});

test('verifySessionToken preserves the impersonation claims when present', () => {
  const { token } = signSessionToken({
    ...USER,
    impersonatedBy: 'root',
    impersonatorId: 'u-0',
  });
  const claims = verifySessionToken(token);
  assert.equal(claims?.impersonatedBy, 'root');
  assert.equal(claims?.impersonatorId, 'u-0');
});

test('two mints produce different CSRF tokens', () => {
  const a = signSessionToken(USER);
  const b = signSessionToken(USER);
  assert.notEqual(a.csrfToken, b.csrfToken);
});

test('verifySessionToken returns null for undefined / null / empty', () => {
  assert.equal(verifySessionToken(undefined), null);
  assert.equal(verifySessionToken(null), null);
  assert.equal(verifySessionToken(''), null);
});

test('verifySessionToken returns null for garbage instead of throwing', () => {
  assert.equal(verifySessionToken('not-a-jwt'), null);
  assert.equal(verifySessionToken('a.b.c'), null);
});

test('verifySessionToken returns null for a token signed with another secret', () => {
  const forged = jwt.sign({ ...USER, csrf: 'x' }, 'a-completely-different-signing-secret-value', {
    expiresIn: SESSION_TTL_SECONDS,
  });
  assert.equal(verifySessionToken(forged), null);
});

// ── Reading the credential off a request ─────────────────────────────────────

test('readSessionCookie finds the token under the __Host- name', () => {
  assert.equal(readSessionCookie(`${SESSION_COOKIE_SECURE}=tok-a`), 'tok-a');
});

test('readSessionCookie finds the token under the plain name', () => {
  assert.equal(readSessionCookie(`${SESSION_COOKIE_PLAIN}=tok-b`), 'tok-b');
});

test('readSessionCookie prefers __Host-pt_session when both are present', () => {
  const header = `${SESSION_COOKIE_PLAIN}=plain; ${SESSION_COOKIE_SECURE}=hosted`;
  assert.equal(readSessionCookie(header), 'hosted');
});

test('readSessionCookie returns undefined when no session cookie is present', () => {
  assert.equal(readSessionCookie('other=1'), undefined);
  assert.equal(readSessionCookie(undefined), undefined);
});

test('readBearerToken parses an Authorization: Bearer header', () => {
  assert.equal(readBearerToken({ authorization: 'Bearer abc.def.ghi' }), 'abc.def.ghi');
});

test('readBearerToken matches the scheme case-insensitively (RFC 7235)', () => {
  assert.equal(readBearerToken({ authorization: 'bearer abc.def.ghi' }), 'abc.def.ghi');
  assert.equal(readBearerToken({ authorization: 'BEARER abc.def.ghi' }), 'abc.def.ghi');
});

test('readBearerToken rejects a bare token with no scheme', () => {
  assert.equal(readBearerToken({ authorization: 'abc.def.ghi' }), undefined);
});

test('readBearerToken rejects a "Bearer " header with nothing after it', () => {
  assert.equal(readBearerToken({ authorization: 'Bearer ' }), undefined);
  assert.equal(readBearerToken({ authorization: 'Bearer    ' }), undefined);
});

test('readBearerToken returns undefined for a missing header or headers object', () => {
  assert.equal(readBearerToken({}), undefined);
  assert.equal(readBearerToken(undefined), undefined);
});

test('resolveSessionToken prefers the bearer header over the cookie', () => {
  const resolved = resolveSessionToken({
    headers: {
      authorization: 'Bearer from-header',
      cookie: `${SESSION_COOKIE_PLAIN}=from-cookie`,
    },
  });
  assert.deepEqual(resolved, { token: 'from-header', source: 'bearer' });
});

test('resolveSessionToken falls back to the cookie and reports source "cookie"', () => {
  const resolved = resolveSessionToken({
    headers: { cookie: `${SESSION_COOKIE_SECURE}=from-cookie` },
  });
  assert.deepEqual(resolved, { token: 'from-cookie', source: 'cookie' });
});

test('resolveSessionToken returns null when neither credential is present', () => {
  assert.equal(resolveSessionToken({ headers: {} }), null);
  assert.equal(resolveSessionToken({}), null);
});

// ── Writing and revoking the cookie ──────────────────────────────────────────

test('setSessionCookie in production uses the __Host- name with Secure', () => {
  const { res, set } = makeRes();
  setSessionCookie(res, 'tok', true);
  assert.equal(set.length, 1);
  assert.equal(set[0].name, SESSION_COOKIE_SECURE);
  assert.equal(set[0].value, 'tok');
  assert.equal(set[0].opts.secure, true);
});

test('setSessionCookie outside production uses the plain name without Secure', () => {
  const { res, set } = makeRes();
  setSessionCookie(res, 'tok', false);
  assert.equal(set.length, 1);
  assert.equal(set[0].name, SESSION_COOKIE_PLAIN);
  assert.equal(set[0].opts.secure, false);
});

test('setSessionCookie always sets HttpOnly, SameSite=Lax, Path=/ and the TTL Max-Age', () => {
  for (const prod of [true, false]) {
    const { res, set } = makeRes();
    setSessionCookie(res, 'tok', prod);
    assert.equal(set[0].opts.httpOnly, true, `httpOnly for prod=${prod}`);
    assert.equal(set[0].opts.sameSite, 'lax', `sameSite for prod=${prod}`);
    assert.equal(set[0].opts.path, '/', `path for prod=${prod}`);
    assert.equal(set[0].opts.maxAge, SESSION_TTL_SECONDS * 1000, `maxAge for prod=${prod}`);
  }
});

test('clearSessionCookie revokes both cookie names', () => {
  const { res, cleared } = makeRes();
  clearSessionCookie(res, true);
  assert.deepEqual(
    cleared.map(c => c.name).sort(),
    [SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN].slice().sort()
  );
});

test('clearSessionCookie clears the __Host- cookie as Secure even outside production', () => {
  const { res, cleared } = makeRes();
  clearSessionCookie(res, false);
  const hosted = cleared.find(c => c.name === SESSION_COOKIE_SECURE);
  const plain = cleared.find(c => c.name === SESSION_COOKIE_PLAIN);
  // A __Host- cookie is only deletable with the attributes it was set with.
  assert.equal(hosted?.opts.secure, true);
  assert.equal(plain?.opts.secure, false);
  assert.equal(hosted?.opts.path, '/');
  assert.equal(hosted?.opts.httpOnly, true);
  assert.equal(hosted?.opts.sameSite, 'lax');
});

// ── Constant-time CSRF comparison ────────────────────────────────────────────

test('csrfMatches accepts two equal strings', () => {
  assert.equal(csrfMatches('same-token-value', 'same-token-value'), true);
});

test('csrfMatches rejects two different strings of equal length', () => {
  assert.equal(csrfMatches('aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'), false);
});

test('csrfMatches rejects different lengths without throwing', () => {
  // crypto.timingSafeEqual() throws on a length mismatch — the guard must run first.
  assert.doesNotThrow(() => csrfMatches('short', 'a-much-longer-token'));
  assert.equal(csrfMatches('short', 'a-much-longer-token'), false);
  assert.equal(csrfMatches('a-much-longer-token', 'short'), false);
});

test('csrfMatches rejects non-string inputs', () => {
  assert.equal(csrfMatches(undefined, 'token'), false);
  assert.equal(csrfMatches('token', undefined), false);
  assert.equal(csrfMatches(null, 'token'), false);
  assert.equal(csrfMatches(42, 'token'), false);
  assert.equal(csrfMatches({ toString: () => 'token' }, 'token'), false);
  assert.equal(csrfMatches(['token'], 'token'), false);
});

test('csrfMatches rejects empty strings on either side', () => {
  assert.equal(csrfMatches('', ''), false);
  assert.equal(csrfMatches('', 'token'), false);
  assert.equal(csrfMatches('token', ''), false);
});

test('csrfMatches accepts a real minted CSRF token echoed back verbatim', () => {
  const { csrfToken } = signSessionToken(USER);
  assert.equal(csrfMatches(csrfToken, csrfToken), true);
  assert.equal(csrfMatches(`${csrfToken}x`, csrfToken), false);
});
