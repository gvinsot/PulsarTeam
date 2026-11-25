import { timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { readSecret } from '../secrets.js';

/** Dedicated service credential; user JWTs and general runner keys cannot export sessions. */
export function authenticateAuthBrowserWorker(req: Request, res: Response, next: NextFunction) {
  const secret = readSecret('AUTH_BROWSER_KEY') || '';
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(req.headers.authorization || '');
  if (
    secret.length < 32 ||
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected)
  ) {
    res.status(403).json({ error: 'Browser worker authentication required' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  next();
}
