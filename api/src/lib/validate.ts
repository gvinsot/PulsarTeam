import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, ZodError, ZodTypeAny } from 'zod';

// Centralised zod-based validation middleware.
//
// Use these factories to attach a schema to a route — the parsed (and coerced)
// value replaces req.body / req.query / req.params, so handlers always work
// against trusted data. On validation failure a single, consistent 400 payload
// is returned: { error: 'Validation failed', details: [...zod issues] }.

export type ValidationTarget = 'body' | 'query' | 'params';

export interface ValidationErrorBody {
  error: 'Validation failed';
  details: { path: string; message: string; code: string }[];
}

export function formatZodError(err: ZodError): ValidationErrorBody {
  return {
    error: 'Validation failed',
    details: err.issues.map(i => ({
      path: i.path.map(String).join('.') || '<root>',
      message: i.message,
      code: i.code,
    })),
  };
}

function makeValidator(target: ValidationTarget) {
  // Returned as `any` so TypeScript can't widen the surrounding handler's
  // request shape — the validator only mutates `req[target]`, which the
  // caller already treats as untyped via `req.body` / `req.query` access.
  return <S extends ZodTypeAny>(schema: S): RequestHandler => {
    const handler = (req: Request, res: Response, next: NextFunction) => {
      const result = schema.safeParse((req as any)[target]);
      if (!result.success) {
        return res.status(400).json(formatZodError(result.error));
      }
      // Replace the original input with the parsed value so coercions /
      // defaults / strips take effect for the rest of the chain.
      try {
        (req as any)[target] = result.data;
      } catch {
        // req.query is a getter on some express versions — fall back to
        // attaching as a non-enumerable property the handler can read.
        Object.defineProperty(req, target, { value: result.data, configurable: true });
      }
      next();
    };
    return handler as any;
  };
}

export const validateBody = makeValidator('body');
export const validateQuery = makeValidator('query');
export const validateParams = makeValidator('params');

// Common reusable atoms — keep here so per-route schemas can compose them.
export const uuidSchema = z.string().uuid('Must be a valid UUID');
export const idParamSchema = z.object({ id: uuidSchema });

export { z, ZodError };
