import type { NextFunction, Request, Response } from 'express';
import {
  resolveApiKey,
  scopeSatisfies,
  touchApiKey,
  validateApiKey,
  type ApiKeyScope,
} from '../services/apiKeyManager.js';
import { getUserById } from '../services/database.js';
import { errorMessage } from '../lib/errors.js';

/**
 * Express middleware that authenticates requests via API key (Bearer token).
 *
 * ── The LEGACY path ─────────────────────────────────────────────────────────
 * `authenticateApiKey` guards `/api/swarm/*` and answers a boolean: the key is
 * valid or it is not. It attaches NO identity, because a legacy key has none —
 * it is the one ownerless instance-wide secret described in
 * services/apiKeyManager.ts. Everything it reaches therefore runs unscoped,
 * which is precisely why `validateApiKey` now accepts legacy rows ONLY: a
 * scoped key honoured here would hand its holder the whole instance and defeat
 * its own scope.
 *
 * ── The SCOPED path ─────────────────────────────────────────────────────────
 * `requireApiKeyScope(scope)` guards `/api/mcp/*`. It resolves the key to its
 * OWNER, re-reads that user from the database, and publishes the result as
 * `req.user` — the same shape `authenticateToken` publishes, so every
 * downstream authorization helper (checkBoardAccess, checkAgentAccess,
 * checkProjectAccess…) applies unchanged and an MCP tool cannot diverge from
 * the REST route beside it.
 *
 * The re-read is the point, and it is why claims are NOT baked into the key:
 * a demotion from admin, or a deleted account, restricts every key that user
 * holds on its very next request instead of whenever the key is next rotated.
 */
export async function authenticateApiKey(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<Response | void> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'API key required. Use Authorization: Bearer <api-key>' });
  }
  const key = authHeader.slice(7);
  try {
    const valid = await validateApiKey(key);
    if (!valid) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
  } catch (err) {
    console.error('API key validation failed:', errorMessage(err));
    return res.status(503).json({ error: 'Auth backend unavailable' });
  }
  next();
}

/** The key a scoped request came in on, for logging and per-tool checks. */
declare global {
  namespace Express {
    interface Request {
      apiKey?: { id: string; scope: ApiKeyScope };
    }
  }
}

/**
 * Guard a route with a scoped, user-owned API key.
 *
 * The scope ladder is one-way (`admin` opens a `management` endpoint, never the
 * reverse) and lives in services/apiKeyManager.ts so the rule has one home.
 *
 * The middleware is NAMED with the scope it demands for the same reason
 * `requireRole` and `authorizeBoardAccess` are: Express keeps only the function
 * reference, so without a name the route inventory
 * (services/__tests__/routeInventory.test.ts) cannot tell this guard from any
 * anonymous closure — nor notice an `admin` endpoint quietly downgraded to
 * `management`.
 */
export function requireApiKeyScope(required: ApiKeyScope) {
  const guard = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res
        .status(401)
        .json({ error: 'API key required. Use Authorization: Bearer <api-key>' });
    }

    let resolved;
    try {
      resolved = await resolveApiKey(authHeader.slice(7));
    } catch (err) {
      console.error('API key validation failed:', errorMessage(err));
      return res.status(503).json({ error: 'Auth backend unavailable' });
    }

    if (!resolved) {
      return res.status(403).json({ error: 'Invalid API key' });
    }

    // A legacy key names no owner, so there is no tenant to run these tools in.
    // Accepting it would reintroduce the ownerless instance-wide access this
    // surface was built to replace.
    if (resolved.legacy || !resolved.userId || !resolved.scope) {
      return res.status(403).json({
        error:
          'This endpoint requires a scoped API key. The instance-wide (legacy) key is not accepted here — mint a per-user key from Settings → API keys.',
      });
    }

    if (!scopeSatisfies(resolved.scope, required)) {
      return res
        .status(403)
        .json({ error: `API key scope "${resolved.scope}" does not grant "${required}"` });
    }

    // Live re-read: the key carries an owner id and nothing else.
    let owner;
    try {
      owner = await getUserById(resolved.userId);
    } catch (err) {
      console.error('API key owner lookup failed:', errorMessage(err));
      return res.status(503).json({ error: 'Auth backend unavailable' });
    }
    if (!owner) {
      return res.status(403).json({ error: 'API key owner no longer exists' });
    }

    req.user = {
      userId: owner.id,
      username: owner.username,
      role: owner.role,
      // No cookie, no ambient authority, so nothing for CSRF to protect: this
      // request authenticated with a bearer secret the browser never attaches
      // on its own. The claim is required by the SessionClaims shape.
      csrf: '',
    };
    req.apiKey = { id: resolved.id, scope: resolved.scope };

    // Reporting only — never awaited, never allowed to fail the request.
    void touchApiKey(resolved.id);
    next();
  };
  Object.defineProperty(guard, 'name', { value: `requireApiKeyScope(${required})` });
  return guard;
}
