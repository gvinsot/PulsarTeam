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
  solve = solveCloudflare
): Promise<T & { challenge?: boolean }> {
  const page = await browserCommand<T & { challenge?: boolean }>(scope, 'navigate', { url });
  if (!page.challenge) return page;
  const clearance = await solve(new URL(url).origin);
  if (!clearance) return page;
  return browserCommand<T & { challenge?: boolean }>(scope, 'clearance', {
    url,
    cookies: clearance.cookies,
    user_agent: clearance.userAgent,
  });
}

/** Agent first, then its PERSISTED board; never a claimed board or arbitrary user's session. */
export async function resolveBrowserScope(
  agentId: string | null,
  boardId: string | null,
  {
    getAgent = getAgentById,
    status = (s: BrowserScope) => browserCommand(s, 'status'),
  }: {
    getAgent?: (id: string) => Promise<{ boardId?: string | null } | null | undefined>;
    status?: (s: BrowserScope) => Promise<BrowserStatus>;
  } = {}
): Promise<BrowserScope> {
  if (agentId) {
    const agent = await getAgent(agentId);
    if (!agent) throw new Error('Agent not found.');
    const own: BrowserScope = { type: 'agent', id: agentId };
    const ownStatus = await status(own);
    // A pending login must not fall through into another account on the board.
    if (ownStatus.exists || !agent.boardId) return own;
    return { type: 'board', id: agent.boardId };
  }
  if (boardId) return { type: 'board', id: boardId };
  throw new Error('An explicit agent or board is required.');
}
