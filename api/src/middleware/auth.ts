import type { NextFunction, Request, Response } from 'express';
import { resolveSessionToken, verifySessionToken } from './session.js';
import type { SessionClaims } from './session.js';

/**
 * Authenticate a request from its session token.
 *
 * Two presentations are accepted, in this order:
 *
 *  • `Authorization: Bearer <jwt>` — explicit, used by non-browser clients
 *    (the internal MCP client in `services/mcpManager.ts`, the desktop bridge,
 *    scripts and tests).
 *  • The `HttpOnly` session cookie — what browsers send. Since it is ambient,
 *    every state-changing request over this path additionally goes through
 *    `csrfProtection` (middleware/csrf.ts).
 *
 * Both live in middleware/session.ts, which owns the cookie names and the JWT.
 */
export function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Response | void {
  const resolved = resolveSessionToken(req);
  if (!resolved) return res.status(401).json({ error: 'Access denied' });

  const claims = verifySessionToken(resolved.token);
  if (!claims) return res.status(401).json({ error: 'Invalid token' });

  req.user = claims;
  next();
}

// Role-based access control middleware
export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction): Response | void => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

/**
 * Narrow `req.user` inside a handler that is mounted behind
 * `authenticateToken`.
 *
 * `Express.Request['user']` is optional because it genuinely is optional — a
 * request that never went through `authenticateToken` carries no claims. Route
 * handlers that read the session must therefore prove it is there rather than
 * assert it. This answers the same 401 `authenticateToken` and `requireRole`
 * already produce, and returns `null` so the caller can `return` immediately:
 *
 *     const user = sessionUser(req, res);
 *     if (!user) return;
 */
export function sessionUser(req: Request, res: Response): SessionClaims | null {
  if (!req.user) {
    res.status(401).json({ error: 'Authentication required' });
    return null;
  }
  return req.user;
}

// Re-exported from its new home so the many existing importers keep working.
export { getJwtSecret } from './session.js';
