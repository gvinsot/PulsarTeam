/**
 * Session tokens and the cookie they travel in.
 *
 * Single source of truth for how a browser session is minted, presented and
 * revoked. Everything that used to reach for `jwt.sign` / `jwt.verify` with an
 * ad-hoc payload goes through here instead, so the CSRF binding below cannot be
 * forgotten by a new call site.
 *
 * ── Why a cookie ──────────────────────────────────────────────────────────
 * The login JWT used to be handed to the SPA in the login response body and
 * kept in `localStorage`, which made any successful XSS a session exfiltration.
 * It now travels in an `HttpOnly` cookie that JavaScript cannot read, so a
 * script injection can no longer lift a credential off the page and replay it
 * elsewhere.
 *
 * ── Why the CSRF token lives *inside* the JWT ─────────────────────────────
 * An `HttpOnly` cookie is sent by the browser on every same-site request,
 * including ones a third-party page triggered — the classic CSRF exposure that
 * a bearer header does not have. The usual fix is a double-submit cookie, but
 * that needs a second, JS-readable cookie which a sibling subdomain could
 * fixate. Instead each session carries a random `csrf` claim *in the signed
 * token*: unforgeable, unreadable from the cookie (it is `HttpOnly`), and
 * handed to the SPA once in the login / `verify` response body, where it lives
 * in memory only. `csrfProtection` (middleware/csrf.ts) then requires an
 * `X-CSRF-Token` header matching that claim on every state-changing request.
 * A cross-site attacker cannot read the response that carries it (CORS
 * allow-list) and cannot set the header without a preflight we refuse.
 *
 * ── Bearer tokens still work ──────────────────────────────────────────────
 * `Authorization: Bearer <jwt>` remains accepted for non-browser clients (the
 * desktop bridge, scripts, tests). That is not a hole: a bearer header is an
 * *explicit* credential a browser never attaches on its own, so it carries no
 * CSRF exposure and is exempted from the header check.
 */
import jwt from 'jsonwebtoken';
import { randomBytes, timingSafeEqual } from 'crypto';
import type { Response } from 'express';
import type { IncomingHttpHeaders } from 'http';

import { readSecret } from '../secrets.js';
import { readFirstCookie } from '../lib/cookies.js';

/**
 * Session lifetime. Kept in one place: the JWT `exp` and the cookie `Max-Age`
 * are both derived from it, so a cookie can never outlive the token it holds.
 */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/**
 * Production uses the `__Host-` prefix, which the browser only accepts with
 * `Secure`, `Path=/` and no `Domain` — that makes the cookie unfixable from a
 * sibling subdomain. Development drops the prefix because `Secure` cookies over
 * plain `http://localhost` are not honoured by every browser.
 */
export const SESSION_COOKIE_SECURE = '__Host-pt_session';
export const SESSION_COOKIE_PLAIN = 'pt_session';
/** Both names are accepted on read, so a session survives an env flip. */
export const SESSION_COOKIE_NAMES = [SESSION_COOKIE_SECURE, SESSION_COOKIE_PLAIN] as const;

/**
 * Header the SPA echoes the `csrf` claim back in. Lower-case: header names are
 * case-insensitive and Node normalises them.
 */
export const CSRF_HEADER = 'x-csrf-token';

const isProd = (): boolean => process.env.NODE_ENV === 'production';

/** Cookie name for the current environment. */
export function sessionCookieName(prod: boolean = isProd()): string {
  return prod ? SESSION_COOKIE_SECURE : SESSION_COOKIE_PLAIN;
}

/** JWT signing/verification secret — `/run/secrets/JWT_SECRET`, env in dev. */
export function getJwtSecret(): string {
  const secret = readSecret('JWT_SECRET');
  if (!secret) {
    throw new Error(
      'JWT_SECRET is not set (expected at /run/secrets/JWT_SECRET or as env var in dev)'
    );
  }
  return secret;
}

export interface SessionClaims {
  userId: string;
  username: string;
  role: string;
  /** Per-session CSRF secret. See the module header. */
  csrf: string;
  /** Username of the admin who started an impersonation, when applicable. */
  impersonatedBy?: string;
  /** Id of that admin, so the session can be handed back without a re-login. */
  impersonatorId?: string;
  iat?: number;
  exp?: number;
}

/** The caller-supplied half of a session — the `csrf` claim is minted here. */
export type SessionInput = Omit<SessionClaims, 'csrf' | 'iat' | 'exp'>;

/** 256 bits of CSRF secret, URL-safe so it survives any header encoding. */
export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Sign a session JWT. Returns the token (for the cookie) and the CSRF secret
 * (for the response body) — the caller needs both and they must come from the
 * same mint, so they are never produced separately.
 */
export function signSessionToken(input: SessionInput): { token: string; csrfToken: string } {
  const csrfToken = newCsrfToken();
  const token = jwt.sign({ ...input, csrf: csrfToken }, getJwtSecret(), {
    expiresIn: SESSION_TTL_SECONDS,
  });
  return { token, csrfToken };
}

/**
 * Verify a session JWT. Returns null rather than throwing — every call site
 * treats "invalid" and "absent" the same way.
 */
export function verifySessionToken(token: string | undefined | null): SessionClaims | null {
  if (!token) return null;
  try {
    return jwt.verify(token, getJwtSecret()) as SessionClaims;
  } catch {
    return null;
  }
}

/** Session JWT from the request's cookie jar, whichever name it was set under. */
export function readSessionCookie(cookieHeader: string | undefined | null): string | undefined {
  return readFirstCookie(cookieHeader, SESSION_COOKIE_NAMES);
}

/**
 * Session JWT from an `Authorization: Bearer` header. The scheme is matched
 * case-insensitively, per RFC 7235 — and because the header parsing this
 * replaced simply split on the space and accepted any casing.
 */
export function readBearerToken(headers: IncomingHttpHeaders | undefined): string | undefined {
  const header = headers?.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^bearer\s+(.*)$/i.exec(header.trim());
  return match ? match[1].trim() || undefined : undefined;
}

export type AuthSource = 'bearer' | 'cookie';

/**
 * Where a request's credential came from. Bearer wins over the cookie: an
 * explicit header is a deliberate choice by the caller, the cookie is ambient.
 * Takes bare headers so the WebSocket upgrade handlers — which never reach
 * Express — can share it with the HTTP middleware.
 */
export function resolveSessionToken(req: { headers?: IncomingHttpHeaders }): {
  token: string;
  source: AuthSource;
} | null {
  const bearer = readBearerToken(req.headers);
  if (bearer) return { token: bearer, source: 'bearer' };
  const cookie = readSessionCookie(req.headers?.cookie);
  if (cookie) return { token: cookie, source: 'cookie' };
  return null;
}

/** Install the session cookie. `HttpOnly` is the point of the whole exercise. */
export function setSessionCookie(res: Response, token: string, prod: boolean = isProd()): void {
  res.cookie(sessionCookieName(prod), token, {
    httpOnly: true,
    // Lax, not Strict: the OAuth providers bounce the user back with a
    // cross-site top-level navigation. Lax already withholds the cookie from
    // every cross-site POST/PUT/PATCH/DELETE; the CSRF token is the primary
    // defence and this is the backstop.
    sameSite: 'lax',
    secure: prod,
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
  });
}

/** Revoke the session cookie under both names, so logout is not env-sensitive. */
export function clearSessionCookie(res: Response, prod: boolean = isProd()): void {
  for (const name of SESSION_COOKIE_NAMES) {
    res.clearCookie(name, {
      httpOnly: true,
      sameSite: 'lax',
      // A `__Host-` cookie is only deletable with the attributes it was set
      // with, so that one always clears as Secure.
      secure: prod || name === SESSION_COOKIE_SECURE,
      path: '/',
    });
  }
}

/** Constant-time comparison of a presented CSRF token against the session's. */
export function csrfMatches(provided: unknown, expected: unknown): boolean {
  if (typeof provided !== 'string' || typeof expected !== 'string') return false;
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
