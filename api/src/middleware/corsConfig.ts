import type { CorsOptions } from 'cors';

/**
 * Centralised CORS configuration (SEC-15).
 *
 * The API is JWT-authenticated and uses `credentials: true`, so an
 * `Access-Control-Allow-Origin: *` response would either be silently
 * ignored by browsers (the spec forbids `*` with credentials) OR — worse —
 * grant any third-party site the ability to read authenticated responses
 * if the wildcard ever leaked through. We therefore enforce an explicit
 * allow-list at startup and refuse to run in production with a wildcard
 * or empty configuration.
 *
 * Every cross-origin request is matched against the allow-list via a
 * callback so we can log refusals (instead of silently dropping CORS
 * headers, which makes misconfigurations very hard to debug from the
 * frontend's side).
 */

const DEV_DEFAULTS = ['http://localhost:5173', 'http://localhost:3000'];

function isProduction(): boolean {
  return process.env.NODE_ENV === 'production';
}

function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean);
}

/** Parsed allow-list. Falls back to localhost defaults outside production. */
export function getCorsOrigins(): string[] {
  const fromEnv = parseOrigins(process.env.CORS_ORIGINS);
  if (fromEnv.length > 0) return fromEnv;
  return DEV_DEFAULTS;
}

function isValidOrigin(value: string): boolean {
  try {
    const u = new URL(value);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.host) return false;
    // An origin is scheme://host[:port] — pathname/search/hash are not part
    // of an origin and almost always indicate a typo in CORS_ORIGINS.
    if (u.pathname !== '/' && u.pathname !== '') return false;
    if (u.search || u.hash) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate CORS configuration. In production, any issue is fatal so an operator
 * cannot accidentally ship an open allow-list. In dev we only warn.
 */
export function validateCorsConfig(): void {
  const raw = process.env.CORS_ORIGINS;
  const origins = parseOrigins(raw);
  const errors: string[] = [];
  const warnings: string[] = [];

  const checks = isProduction() ? errors : warnings;

  if (isProduction() && (!raw || origins.length === 0)) {
    errors.push(
      'CORS_ORIGINS is unset or empty in production. Configure an explicit ' +
      'comma-separated allow-list (e.g. CORS_ORIGINS=https://app.example.com).'
    );
  }

  if (origins.includes('*')) {
    checks.push(
      "CORS_ORIGINS contains '*' (wildcard). The API runs with credentials:true, " +
      'so a wildcard is forbidden by the CORS spec and would expose authenticated ' +
      'endpoints to any site if accepted. Replace with an explicit allow-list.'
    );
  }

  for (const o of origins) {
    if (o === '*') continue;
    if (!isValidOrigin(o)) {
      checks.push(
        `CORS_ORIGINS entry "${o}" is not a valid origin (expected scheme://host[:port], no path).`
      );
    }
  }

  if (errors.length === 0 && warnings.length === 0) return;

  const banner = '='.repeat(72);

  if (isProduction()) {
    console.error('');
    console.error(banner);
    console.error('  FATAL: invalid CORS configuration (NODE_ENV=production)');
    for (const e of errors) console.error(`  - ${e}`);
    console.error(banner);
    console.error('');
    process.exit(1);
  }

  console.warn('');
  console.warn(banner);
  console.warn('  WARNING: CORS configuration issues (dev mode)');
  for (const w of warnings) console.warn(`  - ${w}`);
  console.warn(banner);
  console.warn('');
}

const recentlyLoggedRejections = new Map<string, number>();
const REJECTION_LOG_WINDOW_MS = 60_000;

/** Logs a rejected origin at most once per minute to avoid log floods. */
export function logRejectedOrigin(origin: string, source: 'http' | 'ws' = 'http'): void {
  const now = Date.now();
  const lastLogged = recentlyLoggedRejections.get(origin);
  if (lastLogged !== undefined && now - lastLogged < REJECTION_LOG_WINDOW_MS) return;
  recentlyLoggedRejections.set(origin, now);
  console.warn(`[CORS] Rejected ${source} origin: "${origin}" (not in allow-list)`);

  // Periodically prune stale entries so the map cannot grow unbounded under attack.
  if (recentlyLoggedRejections.size > 256) {
    for (const [k, ts] of recentlyLoggedRejections) {
      if (now - ts > REJECTION_LOG_WINDOW_MS) recentlyLoggedRejections.delete(k);
    }
  }
}

/**
 * Checks a request origin against the allow-list. Requests with no `Origin`
 * header (server-to-server, curl, same-origin navigations) are allowed —
 * CORS only applies to cross-origin browser requests anyway.
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[] = getCorsOrigins()): boolean {
  if (!origin) return true;
  if (allowed.includes('*')) {
    // Defensive: validateCorsConfig refuses '*' in production. If we somehow get
    // here in dev with '*', honour it but never combine with credentials.
    return true;
  }
  return allowed.includes(origin);
}

/** Build CorsOptions for the express `cors` middleware. */
export function buildCorsOptions(allowedOverride?: string[]): CorsOptions {
  return {
    origin(origin, cb) {
      const allowed = allowedOverride ?? getCorsOrigins();
      if (!origin) return cb(null, true);
      if (allowed.includes(origin)) return cb(null, true);
      logRejectedOrigin(origin, 'http');
      return cb(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']
  };
}

/** @internal exposed for tests */
export function _resetRejectionLogCache(): void {
  recentlyLoggedRejections.clear();
}
