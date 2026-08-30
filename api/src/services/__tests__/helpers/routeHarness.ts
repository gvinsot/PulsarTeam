// ── Reusable route test harness ───────────────────────────────────────────────
//
// Mounts one router (or a single middleware) on a throwaway Express app,
// listens on an ephemeral port, and issues a real HTTP request against it. It
// exists so an authorization test can state the thing it actually cares about
// — "as THIS user, does THIS verb on THIS path get through?" — instead of
// re-implementing the listen/fetch/close dance and hard-coding one identity.
//
// Extracted from projectTenantIsolation.test.ts, which could only do GET as a
// single hard-coded user. The harness adds the HTTP method, a JSON body, and
// `as(user)` so a test can replay the same request under a different identity.
//
// The injected identity is written straight onto `req.user`, i.e. it stands in
// for `authenticateToken` having already run. A test that wants to exercise
// authentication itself should mount `authenticateToken` and pass `as(null)`.

import express from 'express';
import type { RequestHandler, Router } from 'express';
import type { SessionClaims } from '../../../middleware/session.js';

/** The identity the harness puts on `req.user`, or `null` for anonymous. */
export type HarnessIdentity = SessionClaims | null;

export interface HarnessRequestOptions {
  /** HTTP method. Defaults to GET. */
  method?: string;
  /** Serialized as JSON with a `Content-Type: application/json` header. */
  body?: unknown;
  /** Extra request headers, merged after the body's content type. */
  headers?: Record<string, string>;
}

export interface RouteHarness {
  /** A copy of this harness that authenticates every request as `user`. */
  as(user: HarnessIdentity): RouteHarness;
  request(path: string, options?: HarnessRequestOptions): Promise<Response>;
  get(path: string, options?: Omit<HarnessRequestOptions, 'method'>): Promise<Response>;
  post(path: string, body?: unknown, options?: HarnessRequestOptions): Promise<Response>;
  put(path: string, body?: unknown, options?: HarnessRequestOptions): Promise<Response>;
  patch(path: string, body?: unknown, options?: HarnessRequestOptions): Promise<Response>;
  del(path: string, options?: HarnessRequestOptions): Promise<Response>;
}

/**
 * A convenience identity for the common "some ordinary tenant user" case.
 * Tests that care about a specific id should build their own literal.
 */
export function harnessUser(overrides: Partial<SessionClaims> = {}): SessionClaims {
  return {
    userId: 'user-A',
    username: 'user-a',
    role: 'basic',
    csrf: 'csrf-secret',
    ...overrides,
  };
}

/**
 * Build a harness around `mounted`.
 *
 * Each request gets its own app and its own listening socket, so no state
 * leaks between assertions and the harness never has to be torn down.
 */
export function createRouteHarness(
  mounted: Router | RequestHandler,
  identity: HarnessIdentity = harnessUser()
): RouteHarness {
  async function request(path: string, options: HarnessRequestOptions = {}): Promise<Response> {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (identity) req.user = identity;
      next();
    });
    app.use(mounted);

    const server = app.listen(0);
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    try {
      const address = server.address();
      if (!address || typeof address !== 'object') {
        throw new Error('route harness: server did not report a numeric address');
      }
      const hasBody = options.body !== undefined;
      const headers: Record<string, string> = {
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      };
      return await fetch(`http://127.0.0.1:${address.port}${path}`, {
        method: options.method ?? 'GET',
        headers,
        ...(hasBody ? { body: JSON.stringify(options.body) } : {}),
      });
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  const harness: RouteHarness = {
    as: user => createRouteHarness(mounted, user),
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, body, options) => request(path, { ...options, method: 'POST', body }),
    put: (path, body, options) => request(path, { ...options, method: 'PUT', body }),
    patch: (path, body, options) => request(path, { ...options, method: 'PATCH', body }),
    del: (path, options) => request(path, { ...options, method: 'DELETE' }),
  };
  return harness;
}
