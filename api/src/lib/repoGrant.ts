import { getOAuthToken } from '../services/database.js';
import type { SessionClaims } from '../middleware/session.js';

export const REPO_GRANT_ERROR =
  'Only the user who granted GitHub access to this board/agent can change the active repository';

/**
 * Only the user who connected GitHub on a board (or agent) may change the
 * active repo of that board's / agent's tasks. The grantor's username is
 * recorded in the token's `meta.grantedBy` at OAuth time. Tokens created
 * before that field existed have no recorded grantor and stay unrestricted;
 * scopes with no GitHub token are unrestricted too (nothing to protect).
 */
export function canChangeTaskRepo(
  user: Pick<SessionClaims, 'username'> | null | undefined,
  scope: { boardId?: string | null; agentId?: string | null }
): boolean {
  const tok = scope.boardId
    ? getOAuthToken('github', 'board', scope.boardId)
    : scope.agentId
      ? getOAuthToken('github', 'agent', scope.agentId)
      : null;
  const grantedBy = (tok?.meta as Record<string, unknown> | undefined)?.grantedBy;
  if (typeof grantedBy !== 'string' || !grantedBy) return true;
  return !!user && user.username === grantedBy;
}
