/**
 * Tests for middleware/csrf — when the CSRF header is demanded and what happens
 * when it is missing, wrong, or the wrong length.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

// Deterministic signing key, >= 32 chars. Read lazily by getJwtSecret().
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-at-least-32-chars-long';

import { csrfProtection, requiresCsrfCheck } from '../../middleware/csrf.js';
import {
  CSRF_HEADER,
  SESSION_COOKIE_PLAIN,
  SESSION_COOKIE_SECURE,
  SESSION_TTL_SECONDS,
  signSessionToken,
} from '../../middleware/session.js';

const USER = { userId: 'u-1', username: 'gigi', role: 'admin' };

/** A live session: a cookie header plus the CSRF token the SPA holds in memory. */
function session(cookieName: string = SESSION_COOKIE_PLAIN) {
  const { token, csrfToken } = signSessionToken(USER);
  return { cookie: `${cookieName}=${token}`, token, csrfToken };
}

/** A session token this server cannot verify (stale secret / rotated key). */
function foreignToken(): string {
  return jwt.sign({ ...USER, csrf: 'irrelevant' }, 'some-other-signing-secret-entirely', {
    expiresIn: SESSION_TTL_SECONDS,
  });
}

interface FakeReq {
  method: string;
  headers: Record<string, string | undefined>;
  // Relative to the `/api` mount point, as Express reports it inside the
  // middleware. Some paths are exempt — see SESSION_ENTRY_PATHS in csrf.ts.
  path: string;
}

function makeReq(
  method: string,
  headers: Record<string, string | undefined> = {},
  path = '/agents'
): FakeReq {
  return { method, headers, path };
}

interface Recorded {
  statusCode?: number;
  body?: unknown;
  nextCalled: boolean;
}

/** Run the middleware against fake req/res/next and report what happened. */
function run(req: FakeReq): Recorded {
  const rec: Recorded = { nextCalled: false };
  const res = {
    status(code: number) {
      rec.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      rec.body = payload;
      return res;
    },
  };
  const next: NextFunction = (() => {
    rec.nextCalled = true;
  }) as NextFunction;
  csrfProtection()(req as unknown as Request, res as unknown as Response, next);
  return rec;
}

// ── Safe methods are never checked ───────────────────────────────────────────

for (const method of ['GET', 'HEAD', 'OPTIONS']) {
  test(`${method} with a valid session cookie is not CSRF-checked`, () => {
    const s = session();
    const req = makeReq(method, { cookie: s.cookie });
    assert.equal(requiresCsrfCheck(req as unknown as Request), false);
    const rec = run(req);
    assert.equal(rec.nextCalled, true);
    assert.equal(rec.statusCode, undefined);
  });
}

test('requiresCsrfCheck upper-cases the method (lower-case "get" is still safe)', () => {
  const s = session();
  assert.equal(
    requiresCsrfCheck(makeReq('get', { cookie: s.cookie }) as unknown as Request),
    false
  );
  assert.equal(
    requiresCsrfCheck(makeReq('head', { cookie: s.cookie }) as unknown as Request),
    false
  );
});

test('requiresCsrfCheck upper-cases the method (lower-case "post" is still checked)', () => {
  const s = session();
  assert.equal(
    requiresCsrfCheck(makeReq('post', { cookie: s.cookie }) as unknown as Request),
    true
  );
  const rec = run(makeReq('post', { cookie: s.cookie }));
  assert.equal(rec.statusCode, 403);
  assert.equal(rec.nextCalled, false);
});

// ── Requests carrying no ambient authority ───────────────────────────────────

test('POST with neither cookie nor bearer passes through (route auth rejects it later)', () => {
  const req = makeReq('POST', {});
  assert.equal(requiresCsrfCheck(req as unknown as Request), false);
  const rec = run(req);
  assert.equal(rec.nextCalled, true);
  assert.equal(rec.statusCode, undefined);
});

test('POST with an unrelated cookie but no session cookie passes through', () => {
  const rec = run(makeReq('POST', { cookie: 'theme=dark; lang=fr' }));
  assert.equal(rec.nextCalled, true);
});

// ── The bearer exemption ─────────────────────────────────────────────────────

test('POST with a valid bearer token is exempt even alongside a session cookie', () => {
  const s = session();
  const req = makeReq('POST', {
    cookie: s.cookie,
    authorization: `Bearer ${s.token}`,
  });
  // No X-CSRF-Token header at all.
  assert.equal(requiresCsrfCheck(req as unknown as Request), false);
  const rec = run(req);
  assert.equal(rec.nextCalled, true);
  assert.equal(rec.statusCode, undefined);
});

// ── The check itself ─────────────────────────────────────────────────────────

test('POST with a session cookie and the matching CSRF header passes', () => {
  const s = session();
  const req = makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: s.csrfToken });
  assert.equal(requiresCsrfCheck(req as unknown as Request), true);
  const rec = run(req);
  assert.equal(rec.nextCalled, true);
  assert.equal(rec.statusCode, undefined);
});

test('POST with a session cookie under the __Host- name is checked too', () => {
  const s = session(SESSION_COOKIE_SECURE);
  const rec = run(makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: s.csrfToken }));
  assert.equal(rec.nextCalled, true);
});

test('POST with a session cookie and NO CSRF header is rejected with CSRF_INVALID', () => {
  const s = session();
  const rec = run(makeReq('POST', { cookie: s.cookie }));
  assert.equal(rec.statusCode, 403);
  assert.deepEqual(rec.body, {
    error: 'Missing or invalid CSRF token',
    code: 'CSRF_INVALID',
  });
  assert.equal(rec.nextCalled, false);
});

test('POST with a session cookie and the WRONG CSRF header is rejected', () => {
  const s = session();
  // Same length, different content — exercises the constant-time comparison.
  const wrong = 'x'.repeat(s.csrfToken.length);
  assert.equal(wrong.length, s.csrfToken.length);
  const rec = run(makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: wrong }));
  assert.equal(rec.statusCode, 403);
  assert.equal((rec.body as { code?: string }).code, 'CSRF_INVALID');
  assert.equal(rec.nextCalled, false);
});

test('POST with a CSRF header of a different length is rejected without throwing', () => {
  const s = session();
  const shorter = s.csrfToken.slice(0, 8);
  const longer = `${s.csrfToken}-and-then-some`;
  let rec: Recorded | undefined;
  assert.doesNotThrow(() => {
    rec = run(makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: shorter }));
  });
  assert.equal(rec?.statusCode, 403);
  assert.equal(rec?.nextCalled, false);
  assert.doesNotThrow(() => {
    rec = run(makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: longer }));
  });
  assert.equal(rec?.statusCode, 403);
});

test('POST with an empty CSRF header is rejected', () => {
  const s = session();
  const rec = run(makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: '' }));
  assert.equal(rec.statusCode, 403);
  assert.equal(rec.nextCalled, false);
});

test('a CSRF token from a different session does not unlock this one', () => {
  const s = session();
  const other = signSessionToken(USER);
  const rec = run(makeReq('POST', { cookie: s.cookie, [CSRF_HEADER]: other.csrfToken }));
  assert.equal(rec.statusCode, 403);
});

// ── Unverifiable cookies must not lock a user out ────────────────────────────

test('POST with a session cookie signed by another secret passes through', () => {
  const req = makeReq('POST', { cookie: `${SESSION_COOKIE_PLAIN}=${foreignToken()}` });
  assert.equal(requiresCsrfCheck(req as unknown as Request), false);
  const rec = run(req);
  assert.equal(rec.nextCalled, true, 'a stale cookie must not block re-login');
  assert.equal(rec.statusCode, undefined);
});

test('POST with a syntactically bogus session cookie passes through', () => {
  const rec = run(makeReq('POST', { cookie: `${SESSION_COOKIE_PLAIN}=not-a-jwt-at-all` }));
  assert.equal(rec.nextCalled, true);
  assert.equal(rec.statusCode, undefined);
});

test('POST with an already-expired session cookie passes through', () => {
  const expired = jwt.sign(
    { ...USER, csrf: 'stale' },
    process.env.JWT_SECRET as string,
    { expiresIn: -60 } // issued and expired a minute ago
  );
  const rec = run(makeReq('POST', { cookie: `${SESSION_COOKIE_PLAIN}=${expired}` }));
  assert.equal(rec.nextCalled, true);
  assert.equal(rec.statusCode, undefined);
});

// ── The other unsafe methods behave identically ──────────────────────────────

for (const method of ['PUT', 'PATCH', 'DELETE']) {
  test(`${method} with a session cookie and no CSRF header is rejected`, () => {
    const s = session();
    const req = makeReq(method, { cookie: s.cookie });
    assert.equal(requiresCsrfCheck(req as unknown as Request), true);
    const rec = run(req);
    assert.equal(rec.statusCode, 403);
    assert.equal((rec.body as { code?: string }).code, 'CSRF_INVALID');
    assert.equal(rec.nextCalled, false);
  });

  test(`${method} with a session cookie and a matching CSRF header passes`, () => {
    const s = session();
    const rec = run(makeReq(method, { cookie: s.cookie, [CSRF_HEADER]: s.csrfToken }));
    assert.equal(rec.nextCalled, true);
    assert.equal(rec.statusCode, undefined);
  });
}

// ── Session-entry routes are exempt even with a live cookie ──────────────────
//
// A transient backend error makes /auth/verify fail, which lands the SPA on the
// login screen still holding a valid cookie but no in-memory CSRF token. These
// routes replace the session rather than act with it, so signing back in must
// not 403.

for (const path of ['/auth/login', '/auth/google/callback', '/auth/github/callback']) {
  test(`POST ${path} with a live cookie and no CSRF header is exempt`, () => {
    const s = session();
    const req = makeReq('POST', { cookie: s.cookie }, path);
    assert.equal(requiresCsrfCheck(req as unknown as Request), false);
    const rec = run(req);
    assert.equal(rec.nextCalled, true);
    assert.equal(rec.statusCode, undefined);
  });
}

// Routes that act *with* the session, including the ones sitting next to the
// exempt pair, stay checked.
for (const path of [
  '/auth/logout',
  '/auth/impersonate/u-2',
  '/auth/stop-impersonation',
  '/auth/accept-terms',
  // An integration callback — connects a plugin to the signed-in user, so it
  // uses existing authority and must not inherit the login exemption.
  '/gmail/callback',
]) {
  test(`POST ${path} with a live cookie and no CSRF header is still rejected`, () => {
    const s = session();
    const req = makeReq('POST', { cookie: s.cookie }, path);
    assert.equal(requiresCsrfCheck(req as unknown as Request), true);
    const rec = run(req);
    assert.equal(rec.statusCode, 403);
    assert.equal(rec.nextCalled, false);
  });
}
