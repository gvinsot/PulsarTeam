// ── Workflow role options ───────────────────────────────────────────────────
//
// The workflow editor's role selectors used to be fed an already board-filtered
// agent list, so any board whose agents carry a different boardId (or none at
// all) offered an empty dropdown — only "Role…" and "Automatic" — while the
// Agents view happily listed those same agents. The editor now receives the
// full agent list plus the board id and groups the roles here: the board's own
// roles first, then every other role the user has an agent for. Nothing the
// Agents view shows can go missing from the list.

/** Sentinel role telling the backend Role Router LLM to pick a role per task.
 *  Keep in sync with AUTO_ROLE in api/src/services/workflow/taskStateMachine.ts. */
export const AUTO_ROLE = '__auto__';

export type RoleAgent = {
  role?: string | null;
  boardId?: string | null;
  enabled?: boolean;
};

export interface RoleOptions {
  /** Roles held by an enabled agent attached to the edited board. */
  boardRoles: string[];
  /** Roles that only exist elsewhere (other boards, or agents with no board). */
  otherRoles: string[];
}

const cleanRole = (agent: RoleAgent): string =>
  typeof agent?.role === 'string' ? agent.role.trim() : '';

const sortRoles = (roles: string[]): string[] =>
  roles.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

/**
 * Unique roles of the enabled agents in `agents`, deduped case-insensitively
 * (the backend matches roles case-insensitively too) and sorted alphabetically.
 */
export function collectRoles(agents: RoleAgent[] = []): string[] {
  const byKey = new Map<string, string>();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent || agent.enabled === false) continue;
    const role = cleanRole(agent);
    if (!role) continue;
    const key = role.toLowerCase();
    if (!byKey.has(key)) byKey.set(key, role);
  }
  return sortRoles([...byKey.values()]);
}

/**
 * Split every available role into the ones backed by an agent on `boardId` and
 * the ones that only exist elsewhere. `currentRole` (the value already stored
 * in the workflow) is kept selectable even when no agent carries it anymore, so
 * the select never renders blank and silently rewrites the action on save.
 */
export function buildRoleOptions(
  agents: RoleAgent[] = [],
  boardId: string | null = null,
  currentRole: string = '',
): RoleOptions {
  const list = Array.isArray(agents) ? agents : [];
  const onBoard = boardId ? list.filter(a => a?.boardId === boardId) : list;

  const boardRoles = collectRoles(onBoard);
  const taken = new Set(boardRoles.map(r => r.toLowerCase()));
  const otherRoles = collectRoles(list).filter(r => !taken.has(r.toLowerCase()));

  const current = typeof currentRole === 'string' ? currentRole.trim() : '';
  if (
    current &&
    current !== AUTO_ROLE &&
    !taken.has(current.toLowerCase()) &&
    !otherRoles.some(r => r.toLowerCase() === current.toLowerCase())
  ) {
    otherRoles.push(current);
    sortRoles(otherRoles);
  }

  return { boardRoles, otherRoles };
}
