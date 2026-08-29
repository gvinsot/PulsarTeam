import type { RequestHandler } from 'express';

// Express v4 doesn't forward rejected promises from async handlers to error
// middleware on its own — an unwrapped `async (req, res) => { ... }` that
// throws just hangs the request. Wrap every async route handler in this so
// errors (sync or async) reach the central error middleware in index.ts
// instead of each route hand-rolling its own try/catch.
//
// req/res/next are deliberately untyped here (not express.Request/Response):
// a typed signature would replace whatever route-specific req.params typing
// TypeScript infers at each `router.get('/:id', asyncHandler(...))` call
// site with this wrapper's own generic types, which is more disruptive than
// the loose typing already used throughout these route handlers.
export function asyncHandler(fn: (req: any, res: any, next: any) => any): RequestHandler {
  return (req, res, next) => {
    Promise.resolve()
      .then(() => fn(req, res, next))
      .catch(next);
  };
}
