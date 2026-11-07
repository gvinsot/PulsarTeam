import { readSecret } from '../secrets.js';
import { getAgentById } from './database.js';
import { solveCloudflare } from './flaresolverr.js';

export type BrowserScope = { type: 'agent' | 'board'; id: string };
export interface BrowserStatus {
  configured: boolean;
  exists: boolean;
  connected: boolean;
  canControl?: boolean;
  canRead?: boolean;
  browserLocation?: 'server';
  pageState?: 'loading' | 'ready' | 'empty' | 'login_required' | 'challenge' | 'navigation_failed';
  phase?: 'pending' | 'login' | 'ready' | 'reauth_required';
  sessionId?: string;
  site?: string;
  expiresAt?: number;
}

/** How a read renders the page (worker field names). */
export interface BrowserReadOptions {
  format?: 'text' | 'aria' | 'both';
  wait_for?: string;
  wait_ms?: number;
}

export function browserConfigured() {
  return readSecret('AUTH_BROWSER_KEY').length >= 32;
}

export function workerScope(scope: BrowserScope) {
  return `${scope.type}:${scope.id}`;
}

export class BrowserCommandError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

/** Only the API can reach the worker. Neither this key nor session state goes to runners. */
export async function browserCommand<T = BrowserStatus>(
  scope: BrowserScope,
  operation: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  if (!browserConfigured())
    throw new BrowserCommandError('Authenticated Browser is not configured.', 503);
  let response: Response;
  try {
    response = await fetch(
      `${process.env.AUTH_BROWSER_SERVICE_URL || 'http://mcp-auth-browser:8000'}/command`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${readSecret('AUTH_BROWSER_KEY')}`,
        },
        body: JSON.stringify({ ...params, scope: workerScope(scope), operation }),
        signal: AbortSignal.timeout(55_000),
        redirect: 'error',
      }
    );
  } catch {
    throw new BrowserCommandError(
      'The secret is configured, but the browser service is unreachable. Check its status and its network connection to the API.',
      503
    );
  }
  if (!response.ok) {
    // Never forward arbitrary worker/Playwright response bodies or credentials.
    const errors: Record<number, string> = {
      400: 'Invalid URL, command or session data. Use a public HTTPS website.',
      401: 'The website rejected the transferred session and requires a new login. Sign in again, then transfer the session.',
      403: 'Browser access denied: check the session owner and website domain.',
      409: 'Session missing, expired, busy or not shared. Check the connection in the plugin.',
      412: 'The website presented a challenge in the server browser. The session was not shared. Check the website before transferring again.',
      424: 'The server browser did not render readable page content. This is a server-side page failure, not a local-tab focus problem. Do not repeat the login automatically.',
      413: 'The PDF of this page exceeds the 10 MB attachment limit.',
      429: 'Browser capacity reached. Close a session before trying again.',
    };
    throw new BrowserCommandError(
      errors[response.status] || 'The browser is unavailable. Try again or reconnect.',
      errors[response.status] ? response.status : 503
    );
  }
  return (await response.json()) as T;
}

export const UNSOLVED_CHALLENGE =
  'The site shows a Cloudflare challenge that could not be solved automatically. Hand back to the user; do not try to get around it another way.';

/**
 * Navigate the shared session. When the worker reports a Cloudflare challenge,
 * clear it once through FlareSolverr (flaresolverr.ts) and retry within the
 * worker; `challenge` stays set on the result when that did not work.
 */
export async function navigateBrowser<T extends object>(
  scope: BrowserScope,
  url: string,
  solve = solveCloudflare,
  read: BrowserReadOptions = {}
): Promise<T & { challenge?: boolean }> {
  // The session navigated is the one shared for the URL's own website.
  const site = new URL(url).origin;
  const page = await browserCommand<T & { challenge?: boolean }>(scope, 'navigate', {
    ...read,
    url,
    site,
  });
  if (!page.challenge) return page;
  const clearance = await solve(site);
  if (!clearance) return page;
  return browserCommand<T & { challenge?: boolean }>(scope, 'clearance', {
    ...read,
    url,
    site,
    cookies: clearance.cookies,
    user_agent: clearance.userAgent,
  });
}

/** Every website session (pending or shared) of one scope, as the worker lists them. */
export async function listBrowserSessions(
  scope: BrowserScope,
  controller?: string
): Promise<BrowserStatus[]> {
  // canControl on each entry is relative to `controller` (the human asking).
  const { sessions } = await browserCommand<{ sessions?: BrowserStatus[] }>(scope, 'list', {
    controller,
  });
  return Array.isArray(sessions) ? sessions : [];
}

export interface SharedBrowserSite {
  scope: BrowserScope;
  status: BrowserStatus & { site: string };
}

interface ScopeDeps {
  getAgent?: (id: string) => Promise<{ boardId?: string | null } | null | undefined>;
  list?: (s: BrowserScope) => Promise<BrowserStatus[]>;
}

/**
 * The websites an agent (or a board's MCP) may use: the agent's own sessions,
 * then its PERSISTED board's sessions for the other websites. Never a claimed
 * board or an arbitrary user's session. Per website, an agent session in ANY
 * phase wins: a pending login must not fall through into another account.
 */
export async function sharedBrowserSites(
  agentId: string | null,
  boardId: string | null,
  { getAgent = getAgentById, list = listBrowserSessions }: ScopeDeps = {}
): Promise<SharedBrowserSite[]> {
  const scopes: BrowserScope[] = [];
  if (agentId) {
    const agent = await getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    scopes.push({ type: 'agent', id: agentId });
    if (agent.boardId) scopes.push({ type: 'board', id: agent.boardId });
  } else if (boardId) {
    scopes.push({ type: 'board', id: boardId });
  } else {
    throw new Error('An explicit agent or board is required.');
  }
  const sites: SharedBrowserSite[] = [];
  for (const scope of scopes) {
    for (const status of await list(scope)) {
      const site = status.site;
      if (site && !sites.some(s => s.status.site === site)) {
        sites.push({ scope, status: { ...status, site } });
      }
    }
  }
  return sites;
}

export interface BrowserTarget {
  scope: BrowserScope;
  /** Origin of the website session the command goes to. */
  site?: string;
}

/**
 * Which session an agent command uses. With `site` (any URL on it): that
 * website's session. Without: the only shared website, or the only connected
 * one; several connected websites require the agent to name one.
 */
export async function resolveBrowserTarget(
  agentId: string | null,
  boardId: string | null,
  site?: string,
  deps: ScopeDeps = {}
): Promise<BrowserTarget> {
  const sites = await sharedBrowserSites(agentId, boardId, deps);
  if (site) {
    const origin = new URL(site).origin;
    const match = sites.find(s => s.status.site === origin);
    if (!match) {
      throw new BrowserCommandError(
        `No session is shared for ${origin}. Shared websites: ${sites.map(s => s.status.site).join(', ') || 'none'}.`,
        409
      );
    }
    return { scope: match.scope, site: origin };
  }
  const connected = sites.filter(s => s.status.connected);
  const only = sites.length === 1 ? sites : connected.length === 1 ? connected : [];
  if (only[0]) return { scope: only[0].scope, site: only[0].status.site };
  if (!sites.length) {
    throw new BrowserCommandError(
      'No browser session is shared. Ask the user to connect a website in the Authenticated Browser plugin.',
      409
    );
  }
  throw new BrowserCommandError(
    `Several websites are shared: ${sites.map(s => s.status.site).join(', ')}. Pass site.`,
    409
  );
}
