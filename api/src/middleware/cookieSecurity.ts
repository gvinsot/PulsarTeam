import type { Request, Response, NextFunction } from 'express';

/**
 * Cookie security middleware (defense-in-depth).
 *
 * NOTE: This middleware is currently NOT mounted in index.ts — it protects
 * nothing at runtime today. It is retained (with its test suite) as ready-to-
 * mount hardening for the day the API starts issuing cookies. Mounting it is a
 * (mild) behavior change, so it is intentionally left unmounted until then.
 *
 * The API authenticates with JWTs in localStorage and intentionally does not
 * issue cookies. This middleware enforces secure flags on any Set-Cookie header
 * that may be added in the future (or by a third-party dependency), so a
 * regression cannot ship a cookie without HttpOnly, Secure, and SameSite.
 *
 * Rules applied to each cookie:
 *  - HttpOnly is added if missing (blocks JS access → mitigates XSS exfiltration)
 *  - SameSite=Lax is added if missing (OAuth-compatible CSRF mitigation)
 *  - Secure is added in production if missing (cookie only sent over HTTPS)
 *  - Path=/ is added if missing
 *  - In production, cookies named __Host-* must be Secure + Path=/ + no Domain
 *    (the function rewrites them to comply rather than refusing, since some
 *    libraries set the name without the matching flags).
 */

const isProd = () => process.env.NODE_ENV === 'production';

function hasFlag(parts: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return parts.some(p => p.trim().toLowerCase() === lower
    || p.trim().toLowerCase().startsWith(lower + '='));
}

function getFlagIndex(parts: string[], name: string): number {
  const lower = name.toLowerCase();
  return parts.findIndex(p => p.trim().toLowerCase() === lower
    || p.trim().toLowerCase().startsWith(lower + '='));
}

export function hardenCookie(cookie: string, prod = isProd()): string {
  const parts = cookie.split(';').map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) return cookie;

  const nameValue = parts[0];
  const attrs = parts.slice(1);

  if (!hasFlag(attrs, 'HttpOnly')) attrs.push('HttpOnly');
  if (!hasFlag(attrs, 'SameSite')) attrs.push('SameSite=Lax');
  if (!hasFlag(attrs, 'Path')) attrs.push('Path=/');
  if (prod && !hasFlag(attrs, 'Secure')) attrs.push('Secure');

  // __Host- prefix requires Secure, Path=/, and no Domain. Enforce in all envs
  // because the prefix is meaningless without these constraints.
  const name = nameValue.split('=')[0];
  if (name.startsWith('__Host-')) {
    if (!hasFlag(attrs, 'Secure')) attrs.push('Secure');
    const pathIdx = getFlagIndex(attrs, 'Path');
    if (pathIdx >= 0) attrs[pathIdx] = 'Path=/';
    const domainIdx = getFlagIndex(attrs, 'Domain');
    if (domainIdx >= 0) attrs.splice(domainIdx, 1);
  }

  return [nameValue, ...attrs].join('; ');
}

export function cookieSecurity() {
  return function cookieSecurityMiddleware(_req: Request, res: Response, next: NextFunction) {
    const originalSetHeader = res.setHeader.bind(res);
    res.setHeader = function (name: string, value: any) {
      if (typeof name === 'string' && name.toLowerCase() === 'set-cookie') {
        if (Array.isArray(value)) {
          value = value.map(c => hardenCookie(String(c)));
        } else if (value != null) {
          value = hardenCookie(String(value));
        }
      }
      return originalSetHeader(name, value);
    } as typeof res.setHeader;
    next();
  };
}
