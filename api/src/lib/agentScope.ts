// ── Agent tenancy: what an agent may SEE when it lists ───────────────────────
//
// lib/agentAccess.ts answers "who may act as this agent". This answers the
// mirror question, which the listing tools had never asked: once an agent is
// running, WHICH boards, tasks, projects and sibling agents belong to its own
// tenant?
//
// Before this helper, every listing surface an agent can reach resolved that
// scope as "everything on the instance": `_listAvailableProjects` asked
// getAccessibleBoardRepos(null, 'admin'), list_boards/list_tasks read
// getAllBoards()/getTasksByStatusAndBoard(null, null), and the swarm roster
// mapped the whole agents map. A brand-new agent therefore started its very
// first turn already naming repos, boards and tasks from other boards — and,
// on a multi-tenant instance, from other organizations.
//
// ── The rule ────────────────────────────────────────────────────────────────
// One case per case of checkAgentAccess (lib/agentAccess.ts), so an agent can
// only ever see the tenant that would have been allowed to create it:
//   1. Attached to a board  → that board, and only that board. The board is
//      the agent's tenant, exactly as it is the unit that decides access.
//   2. No board, but owned  → the boards its owner can reach (own + shared).
//   3. Neither              → nothing. `agents.owner_id` drops to NULL when a
//      user is deleted, and those orphans stay closed rather than falling back
//      to the whole instance.
//
// Case 1 is deliberately narrower than "the owner's boards": an agent working
// on board A has no business enumerating board B's repos just because the same
// person owns both. A leader that must dispatch across boards is given those
// boards by being left board-less (case 2), not by widening case 1.

import { canSeeAgent, type AgentAccessSubject } from './agentAccess.js';
import { getUserBoardIdSet } from './boardAccess.js';

/**
 * The board ids an agent may read through its own tools. Always a Set — an
 * EMPTY one means "no board", which callers must render as an empty listing,
 * never as "unscoped".
 */
export async function getAgentBoardScope(
  agent: AgentAccessSubject | null | undefined
): Promise<Set<string>> {
  if (!agent) return new Set();
  if (agent.boardId) return new Set([agent.boardId]);
  if (agent.ownerId) return getUserBoardIdSet(agent.ownerId);
  return new Set();
}

/**
 * The sibling agents one agent may see (swarm roster, ask_agent, list_agents).
 *
 * Reuses the request-time rule verbatim, with the acting agent's OWNER as the
 * identity and `role: null` — never 'admin'. An agent does not inherit its
 * owner's admin role: a human admin browsing the UI is entitled to the whole
 * instance, an agent running inside one board is not.
 */
export function agentsVisibleTo(
  agent: AgentAccessSubject | null | undefined,
  allAgents: any[],
  scope: ReadonlySet<string>
): any[] {
  const userId = agent?.ownerId || null;
  return allAgents.filter((candidate: any) => canSeeAgent(candidate, { userId, role: null }, scope));
}
