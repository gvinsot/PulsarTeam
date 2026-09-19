import { assertPublicUrl } from '../lib/ssrfGuard.js';

/**
 * FlareSolverr client for the authenticated browser's Cloudflare challenges.
 *
 * Only the ROOT of the shared site goes to the solver — never the user's
 * cookies, nor the page path — and only Cloudflare's clearance cookies plus the
 * solver's user agent come back. cf_clearance is bound to that user agent (and
 * to the egress IP, which the cluster nodes share), so the worker adopts both.
 * FlareSolverr sits unauthenticated on `backend`: it must never hold a user
 * session. mcp-browser uses it directly, as a crawl4ai fallback.
 */
const CLEARANCE_COOKIES = new Set(['cf_clearance', '__cf_bm', '_cfuvid']);

export interface Clearance {
  cookies: { name: string; value: string; expires: number }[];
  userAgent: string;
}

interface SolverCookie {
  name?: unknown;
  value?: unknown;
  expires?: unknown;
  expiry?: unknown;
}

interface SolverAnswer {
  status?: string;
  solution?: { url?: string; userAgent?: string; cookies?: SolverCookie[] };
}

/** Clearance for `origin` (https://host), or null when unconfigured or unsolved. */
export async function solveCloudflare(origin: string): Promise<Clearance | null> {
  const endpoint = process.env.FLARESOLVERR_URL;
  if (!endpoint) return null;
  try {
    await assertPublicUrl(origin);
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd: 'request.get', url: `${origin}/`, maxTimeout: 60_000 }),
      signal: AbortSignal.timeout(90_000),
      redirect: 'error',
    });
    if (!response.ok) return null;
    const { status, solution } = (await response.json()) as SolverAnswer;
    if (status !== 'ok' || !solution?.userAgent || !solution.url) return null;
    // A solver redirected elsewhere holds clearance for another site.
    if (new URL(solution.url).origin !== origin) return null;
    const cookies = new Map<string, Clearance['cookies'][number]>();
    for (const c of solution.cookies || []) {
      if (typeof c.name !== 'string' || typeof c.value !== 'string') continue;
      if (!CLEARANCE_COOKIES.has(c.name) || cookies.has(c.name)) continue;
      const expires = [c.expires, c.expiry].find(v => typeof v === 'number') as number | undefined;
      cookies.set(c.name, { name: c.name, value: c.value, expires: expires ?? -1 });
    }
    if (!cookies.has('cf_clearance')) return null;
    return { cookies: [...cookies.values()], userAgent: solution.userAgent };
  } catch {
    return null;
  }
}
