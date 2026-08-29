import { resolveSessionToken, verifySessionToken } from './session.js';

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
export function authenticateToken(req, res, next) {
  const resolved = resolveSessionToken(req);
  if (!resolved) return res.status(401).json({ error: 'Access denied' });

  const claims = verifySessionToken(resolved.token);
  if (!claims) return res.status(401).json({ error: 'Invalid token' });

  req.user = claims;
  next();
}

// Role-based access control middleware
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Re-exported from its new home so the many existing importers keep working.
export { getJwtSecret } from './session.js';
