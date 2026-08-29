/**
 * CSRF protection for cookie-authenticated requests.
 *
 * Moving the session into an `HttpOnly` cookie (middleware/session.ts) removes
 * the XSS exfiltration path but introduces the one weakness a bearer header
 * never had: the browser attaches the cookie to *any* same-site request,
 * including one a third-party page caused. This middleware closes that.
 *
 * The rule is narrow on purpose — it only fires when a request actually carries
 * ambient authority:
 *
 *   1. Safe methods (GET/HEAD/OPTIONS) are never checked. Nothing in this API
 *      changes state on a GET.
 *   2. `Authorization: Bearer …` requests are exempt. A bearer header is an
 *      explicit credential; a browser never attaches one on its own, and a
 *      cross-origin page cannot add it without a preflight the CORS allow-list
 *      refuses. This is the path the internal MCP client, the API-key clients
 *      and the test suite use.
 *   3. Requests with no session cookie are exempt — there is no authority to
 *      abuse, and the route's own auth middleware will reject them anyway.
 *   4. A session cookie that no longer verifies (expired, rotated secret) is
 *      treated as absent, so a stale cookie cannot lock a user out of logging
 *      back in.
 *   5. The routes that *establish* a session are exempt even when a valid
 *      cookie happens to be present — see SESSION_ENTRY_PATHS below.
 *
 * Everything else must present `X-CSRF-Token` matching the `csrf` claim inside
 * the signed session token. The attacker cannot read that claim (the cookie is
 * `HttpOnly`, and the response that carries it is CORS-protected) and cannot
 * send the header cross-origin without a preflight.
 *
 * Deliberately *not* enforced here: an `Origin` allow-list check. The desktop
 * companion serves the SPA from `http://127.0.0.1:<port>` and reverse-proxies
 * `/api` to the platform, so its same-origin POSTs arrive with an `Origin` the
 * server's allow-list does not know. The token check above is the defence that
 * matters; `SameSite=Lax` on the cookie is the second layer. WebSocket
 * handshakes, which cannot carry a header, *do* check `Origin` — see
 * `index.ts` (socket.io) and `routes/terminal.ts`.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';

import {
  CSRF_HEADER,
  csrfMatches,
  readBearerToken,
  readSessionCookie,
  verifySessionToken,
} from './session.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Routes that replace the session rather than act with it. Paths are relative
 * to the `/api` mount point in index.ts.
 *
 * These have to be exempt because the SPA can legitimately reach the login
 * screen while still holding a valid cookie — a transient backend error makes
 * /auth/verify fail, which lands the user on the login page with the in-memory
 * CSRF token gone. Without this, signing back in would answer 403 instead.
 *
 * Exempting them costs nothing: they use no existing authority, and a
 * cross-origin caller cannot reach them anyway. Both send `Content-Type:
 * application/json`, so the browser preflights, and the CORS allow-list refuses
 * the preflight.
 */
const SESSION_ENTRY_PATHS = [/^\/auth\/login\/?$/, /^\/auth\/[^/]+\/callback\/?$/];

/** True when this request must present a matching CSRF header. */
export function requiresCsrfCheck(req: Pick<Request, 'method' | 'headers' | 'path'>): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  if (SESSION_ENTRY_PATHS.some(re => re.test(req.path))) return false;
  if (readBearerToken(req.headers)) return false;
  const cookieToken = readSessionCookie(req.headers.cookie);
  if (!cookieToken) return false;
  return verifySessionToken(cookieToken) !== null;
}

export function csrfProtection(): RequestHandler {
  return function csrfMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!requiresCsrfCheck(req)) return next();

    // requiresCsrfCheck already proved this verifies; re-read for the claim.
    const claims = verifySessionToken(readSessionCookie(req.headers.cookie));
    const provided = req.headers[CSRF_HEADER];

    if (!csrfMatches(provided, claims?.csrf)) {
      res.status(403).json({
        error: 'Missing or invalid CSRF token',
        code: 'CSRF_INVALID',
      });
      return;
    }
    next();
  };
}
