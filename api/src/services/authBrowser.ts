import { readSecret } from '../secrets.js';
import { getAgentById } from './database.js';
import { solveCloudflare } from './flaresolverr.js';

/** A site-pinned plugin gets its own worker slot, separate from the generic browser. */
export type BrowserSite = 'linkedin';
export type BrowserScope = { type: 'agent' | 'board'; id: string; site?: BrowserSite };
export const LINKEDIN_ORIGIN = 'https://www.linkedin.com';
export interface BrowserStatus {
  configured: boolean;
  exists: boolean;
  connected: boolean;
  canControl?: boolean;
  phase?: 'pending' | 'login' | 'ready';
  sessionId?: string;
  site?: string;
  expiresAt?: number;
}

export function browserConfigured() {
  return readSecret('AUTH_BROWSER_KEY').length >= 32;
}

export function workerScope(scope: BrowserScope) {
  return `${scope.site ? `${scope.site}:` : ''}${scope.type}:${scope.id}`;
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
    throw new BrowserCommandError('Le navigateur authentifié n’est pas configuré.', 503);
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
      'Le secret est configuré, mais le service de navigateur est injoignable. Vérifiez son état et sa liaison réseau avec l’API.',
      503
    );
  }
  if (!response.ok) {
    // Never forward arbitrary worker/Playwright response bodies or credentials.
    const errors: Record<number, string> = {
      400: 'URL, commande ou données de session invalides. Utilisez un site HTTPS public.',
      401: 'Le site a refusé la session transférée et demande une nouvelle connexion. Reconnectez-vous puis transférez à nouveau.',
      403: 'Accès au navigateur refusé : vérifiez le propriétaire de la session et le domaine.',
      409: 'Session absente, expirée, occupée ou non partagée. Vérifiez la connexion dans les plugins.',
      429: 'Capacité de navigateurs atteinte. Fermez une session avant de réessayer.',
    };
    throw new BrowserCommandError(
      errors[response.status] || 'Le navigateur est indisponible. Réessayez ou reconnectez-vous.',
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
    site,
    getAgent = getAgentById,
    status = (s: BrowserScope) => browserCommand(s, 'status'),
  }: {
    site?: BrowserSite;
    getAgent?: (id: string) => Promise<{ boardId?: string | null } | null | undefined>;
    status?: (s: BrowserScope) => Promise<BrowserStatus>;
  } = {}
): Promise<BrowserScope> {
  const inSite = (scope: BrowserScope): BrowserScope => (site ? { ...scope, site } : scope);
  if (agentId) {
    const agent = await getAgent(agentId);
    if (!agent) throw new Error('Agent introuvable.');
    const own = inSite({ type: 'agent', id: agentId });
    const ownStatus = await status(own);
    // A pending login must not fall through into another account on the board.
    if (ownStatus.exists || !agent.boardId) return own;
    return inSite({ type: 'board', id: agent.boardId });
  }
  if (boardId) return inSite({ type: 'board', id: boardId });
  throw new Error('Un agent ou un board explicite est requis.');
}
