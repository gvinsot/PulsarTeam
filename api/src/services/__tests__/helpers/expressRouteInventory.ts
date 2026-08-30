// ── Express routing-stack inventory ───────────────────────────────────────────
//
// Loads the REAL application from src/index.ts and flattens everything it
// mounted into a list of {method, path, chain} records, where `chain` is the
// ordered list of function names a request traverses before the terminal
// handler. routeInventory.test.ts compares that list against an explicit
// policy table, so a route cannot be added — or a guard removed — without the
// test saying so.
//
// Why load index.ts rather than re-declare the mounts here: a hand-maintained
// copy of the mount table is exactly the thing that drifts. The stack we walk
// is the one Express will use in production.
//
// Booting index.ts is a side effect, so two things are neutralized:
//
//   • `validateProductionSecrets` is replaced with a throw. It is the FIRST
//     statement of `start()`, so the rejection aborts the boot before
//     `initDatabase()`, `httpServer.listen()`, the task loop or any MCP
//     connection can start. Everything above `start()` — every `app.use`, i.e.
//     the whole routing stack — has already run by then, which is all we need.
//   • `process.exit` is stubbed for the duration of the import, because
//     index.ts ends with `start().catch(() => process.exit(1))` and that would
//     otherwise take the test runner down with it.
//
// The app itself is captured by wrapping `express.application.init`, which
// `express()` copies onto every application it creates: the wrapper therefore
// runs with `this` bound to the new app. That avoids mocking the `express`
// module, which cannot be done here — it is CommonJS with a callable default
// export, and `mock.module` refuses to attach named exports to one (routes/
// tasks.ts and routes/localFolder.ts import `{ Router }` from it).

import { mock } from 'node:test';
import express from 'express';
import type { Application } from 'express';
import * as realSecrets from '../../../secrets.js';

class BootAborted extends Error {}

mock.module('../../../secrets.js', {
  namedExports: {
    ...realSecrets,
    validateProductionSecrets: () => {
      throw new BootAborted('route inventory: boot deliberately aborted');
    },
  },
});

/** One leaf route, with the ordered names of the functions guarding it. */
export interface MountedRoute {
  /** Upper-cased HTTP verb, or 'ALL' for a route registered with `app.all()`. */
  method: string;
  /** Full path as mounted, e.g. '/api/agents/:id/tasks'. */
  path: string;
  /**
   * Every named function on the way to the handler, in execution order:
   * app-level middleware that matches, the router's own middleware, then the
   * route's own stack. Anonymous functions appear as '<anonymous>'.
   */
  chain: string[];
}

// ── Minimal structural views of Express internals ────────────────────────────
// Express does not type its routing stack. These describe only the fields the
// walk reads; anything Express changes here surfaces as a loud failure in
// decodeMountPath() or getRouterStack() rather than a silent empty inventory.

interface LayerHandle {
  (...args: never[]): unknown;
  stack?: StackLayer[];
}

interface RouteInternals {
  path: string | string[];
  methods: Record<string, boolean>;
  stack: Array<{ name: string; handle: unknown }>;
}

interface StackLayer {
  name: string;
  handle: LayerHandle;
  regexp: RegExp & { fast_slash?: boolean };
  /** Express 4 stores `{ name }` objects here; Express 5 stores bare strings. */
  keys?: Array<{ name: string | number } | string>;
  route?: RouteInternals;
}

interface RouterInternals {
  stack: StackLayer[];
}

interface AppInternals {
  /** Express 4. */
  _router?: RouterInternals;
  /** Express 5 renamed it. */
  router?: RouterInternals;
}

// The tail path-to-regexp appends to an `app.use(path, ...)` mount, so that
// '/api/users' also matches '/api/users/42'. If a future Express stops
// emitting it, decodeMountPath() throws by design.
const MOUNT_SUFFIX = '\\/?(?=\\/|$)';

// A route registered with `app.all()` carries one entry per HTTP verb. When
// all of these are present we report it as the single pseudo-verb 'ALL'
// instead of 35 near-identical rows.
const CORE_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

function getRouterStack(app: Application): StackLayer[] {
  // @types/express describes a shape that does not match the express 4 runtime
  // (its `keys` are objects, not strings), so the view above is applied through
  // `unknown` rather than trusted from the published types.
  const internals = app as unknown as AppInternals;
  const router = internals._router ?? internals.router;
  if (!router || !Array.isArray(router.stack)) {
    throw new Error(
      'route inventory: could not find the routing stack (neither app._router nor ' +
        'app.router). Express changed its internals — update getRouterStack().'
    );
  }
  return router.stack;
}

function isRouter(layer: StackLayer): boolean {
  return typeof layer.handle === 'function' && Array.isArray(layer.handle.stack);
}

/**
 * Recover the literal mount path of an `app.use(path, ...)` layer.
 *
 * Express 4 keeps only the compiled RegExp, so the path is read back out of
 * `regexp.source`. Every step is checked and the result is validated against
 * the RegExp it came from: a shape this function does not recognize throws, so
 * an Express upgrade breaks the test loudly instead of silently producing an
 * empty or wrong inventory.
 */
function decodeMountPath(layer: StackLayer): string {
  if (layer.regexp.fast_slash) return '';
  const source = layer.regexp.source;
  if (!source.startsWith('^') || !source.endsWith(MOUNT_SUFFIX)) {
    throw new Error(
      `route inventory: unrecognized mount pattern ${source} — path-to-regexp output ` +
        'changed. Update decodeMountPath().'
    );
  }
  const body = source.slice(1, source.length - MOUNT_SUFFIX.length);
  const keys = [...(layer.keys ?? [])];
  const withParams = body.replace(/\(\?:\\\/\(\[\^\/\]\+\?\)\)/g, () => {
    const key = keys.shift();
    if (key === undefined) return '/:param';
    return `/:${typeof key === 'string' ? key : key.name}`;
  });
  const path = withParams.replace(/\\(.)/g, '$1');
  const probe = path.replace(/:[^/]+/g, 'probe');
  if (!layer.regexp.test(probe)) {
    throw new Error(
      `route inventory: decoded mount path ${path} does not match its own pattern ` +
        `${source}. Update decodeMountPath().`
    );
  }
  return path;
}

/** True when `layer`'s pattern applies to something mounted at `localPath`. */
function layerApplies(layer: StackLayer, localPath: string): boolean {
  if (layer.regexp.fast_slash) return true;
  return layer.regexp.test(localPath.replace(/:[^/]+/g, 'probe') || '/');
}

function methodsOf(route: RouteInternals): string[] {
  const names = Object.keys(route.methods).filter(name => name !== '_all');
  if (CORE_METHODS.every(method => names.includes(method))) return ['ALL'];
  return names.map(method => method.toUpperCase()).sort();
}

/**
 * The route's own handler names, de-duplicated by function identity.
 *
 * `app.all()` registers the same handler list once per HTTP verb, so the raw
 * stack repeats `[guard, handler]` 35 times; identity de-duplication collapses
 * that back to the chain a single request actually runs.
 */
function routeChain(route: RouteInternals): string[] {
  const seen = new Set<unknown>();
  const names: string[] = [];
  for (const entry of route.stack) {
    if (seen.has(entry.handle)) continue;
    seen.add(entry.handle);
    names.push(entry.name || '<anonymous>');
  }
  return names;
}

function joinPath(prefix: string, path: string): string {
  const joined = `${prefix}${path === '/' ? '' : path}`;
  return joined || '/';
}

function walk(stack: StackLayer[], prefix: string, inherited: string[], out: MountedRoute[]): void {
  // Middleware registered at this level, in order. A layer only guards what is
  // registered after it, which is how `app.use(path, guard, router)` reads.
  const pending: StackLayer[] = [];
  for (const layer of stack) {
    const route = layer.route;
    if (route) {
      const paths = Array.isArray(route.path) ? route.path : [route.path];
      for (const routePath of paths) {
        const applicable = pending
          .filter(candidate => layerApplies(candidate, routePath))
          .map(candidate => candidate.name || '<anonymous>');
        const chain = [...inherited, ...applicable, ...routeChain(route)];
        for (const method of methodsOf(route)) {
          out.push({ method, path: joinPath(prefix, routePath), chain });
        }
      }
    } else if (isRouter(layer)) {
      const mount = decodeMountPath(layer);
      const applicable = pending
        .filter(candidate => layerApplies(candidate, mount || '/'))
        .map(candidate => candidate.name || '<anonymous>');
      walk(layer.handle.stack ?? [], `${prefix}${mount}`, [...inherited, ...applicable], out);
    } else {
      pending.push(layer);
    }
  }
}

let cached: MountedRoute[] | null = null;

/**
 * Boot src/index.ts once and return every route it mounted.
 *
 * Cached: ESM imports a module once per process, so a second call would
 * capture nothing.
 */
export async function loadMountedRoutes(): Promise<MountedRoute[]> {
  if (cached) return cached;

  const captured: Application[] = [];
  const originalInit = express.application.init;
  express.application.init = function patchedInit(this: Application): void {
    captured.push(this);
    originalInit.call(this);
  };

  const originalExit = process.exit;
  const originalError = console.error;
  // `process.exit` is declared as returning `never`; a stub cannot be, so the
  // cast goes through `unknown`. Restored in the `finally` below.
  process.exit = (() => undefined) as unknown as typeof process.exit;
  console.error = (...args: unknown[]) => {
    // index.ts logs the aborted boot; anything else still reaches the runner.
    if (typeof args[0] === 'string' && args[0].startsWith('Failed to start server')) return;
    originalError(...args);
  };
  // Belt and braces: should index.ts ever listen before validating secrets, do
  // not let the test bind the real port.
  process.env.PORT = '0';

  try {
    await import('../../../index.js');
    // Let `start().catch(...)` settle while process.exit is still stubbed.
    await new Promise<void>(resolve => setImmediate(resolve));
  } finally {
    express.application.init = originalInit;
    process.exit = originalExit;
    console.error = originalError;
  }

  if (captured.length === 0) {
    throw new Error('route inventory: importing src/index.ts created no Express application');
  }

  const routes: MountedRoute[] = [];
  walk(getRouterStack(captured[0]), '', [], routes);
  if (routes.length === 0) {
    throw new Error('route inventory: the app mounted no routes — the walk is broken');
  }
  cached = routes;
  return routes;
}
