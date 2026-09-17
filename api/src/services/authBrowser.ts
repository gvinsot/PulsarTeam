import { readSecret } from '../secrets.js';
import { getAgentById } from './database.js';

export type BrowserScope = { type: 'agent' | 'board'; id: string };
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
        body: JSON.stringify({ ...params, scope: `${scope.type}:${scope.id}`, operation }),
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

/** Agent first, then its PERSISTED board; never a claimed board or arbitrary user's session. */
export async function resolveBrowserScope(
  agentId: string | null,
  boardId: string | null,
  dependencies = {
    getAgent: getAgentById,
    status: (s: BrowserScope) => browserCommand(s, 'status'),
  }
): Promise<BrowserScope> {
  if (agentId) {
    const agent = await dependencies.getAgent(agentId);
    if (!agent) throw new Error('Agent introuvable.');
    const own: BrowserScope = { type: 'agent', id: agentId };
    const status = await dependencies.status(own);
    // A pending login must not fall through into another account on the board.
    if (status.exists || !agent.boardId) return own;
    return { type: 'board', id: agent.boardId };
  }
  if (boardId) return { type: 'board', id: boardId };
  throw new Error('Un agent ou un board explicite est requis.');
}
