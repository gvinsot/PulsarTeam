// ── The tenant an API-key MCP call runs in ──────────────────────────────────
//
// `/api/mcp/admin` and `/api/mcp/management` are reached with a scoped API key
// (middleware/apiKeyAuth.ts), which resolves to a REAL USER and publishes them
// as `req.user`. Every tool on those two surfaces therefore has an identity to
// answer to, and this module is where that identity turns into a decision.
//
// It deliberately does NOT implement any access rule. Each helper below calls
// the very same function the matching REST route calls —
// `checkBoardAccess`, `checkProjectAccess`, `checkAgentAccess` — so an MCP tool
// and its REST twin cannot drift apart. What this module adds is the two things
// the REST routes do not need:
//
//  1. MCP envelopes. Tools return `{ content: [...] }`, not HTTP statuses.
//
//  2. A uniform NOT-FOUND answer. The REST routes distinguish 403 ("this
//     exists, you may not touch it") from 404 ("no such thing"), which is fine
//     behind a session where the caller already knows their own tenancy. On a
//     key-authenticated, machine-driven surface that difference is an oracle:
//     an attacker holding any valid key could enumerate another tenant's board
//     and agent ids by watching 403s. `denied()` collapses both into the same
//     "not found", so a resource outside the caller's scope is indistinguishable
//     from one that never existed.

import { checkBoardAccess, checkProjectAccess, type Permission } from '../../middleware/authz.js';
import { checkAgentAccess } from '../../lib/agentAccess.js';
import { getUserBoardIdSet } from '../../lib/boardAccess.js';
import { jsonError } from '../mcpResponses.js';
import type { SessionClaims } from '../../middleware/session.js';

/**
 * A board / project / agent / task record that this layer only RESOLVES and
 * FORWARDS — it never interprets one.
 *
 * These records are genuinely untyped upstream: `middleware/authz.ts` declares
 * `board?: any`, agentManager keeps its agents as plain objects, and the task
 * rows arrive from `queryTasks`. Declaring the honest `any` ONCE, here, with
 * this explanation, is better than sprinkling it across three files — and it
 * gives a single place to tighten when those upstream types land.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type McpRecord = any;

/**
 * Who a tool call runs as. Structurally a `SessionClaims`, so it can be passed
 * straight to the shared authorization helpers.
 */
export type McpActor = SessionClaims;

/** The MCP envelope for "this resource is not yours, or is not there". */
export function notFound(kind: string): ReturnType<typeof jsonError> {
  return jsonError(`${kind} not found`);
}

/**
 * Result of a scoped lookup. One interface rather than a discriminated union,
 * matching `AgentAccessResult` in lib/agentAccess.ts — this project's tsc does
 * not narrow the negative branch of such a union.
 */
export interface ScopedLookup<T> {
  ok: boolean;
  value?: T;
  /** Ready-to-return MCP error envelope when `ok` is false. */
  error?: ReturnType<typeof jsonError>;
}

/**
 * Resolve a board the actor may use at `required` level.
 *
 * A missing board, a board belonging to somebody else, and a board shared at
 * too low a permission all produce the identical "Board not found" — see the
 * module header.
 */
export async function scopedBoard(
  actor: McpActor,
  boardId: string | null | undefined,
  required: Permission = 'read'
): Promise<ScopedLookup<McpRecord>> {
  if (!boardId) return { ok: false, error: jsonError('board_id is required') };
  const access = await checkBoardAccess(boardId, actor.userId, actor.role, required);
  if (!access.ok) return { ok: false, error: notFound('Board') };
  return { ok: true, value: access.board };
}

/** Same contract as `scopedBoard`, for projects. */
export async function scopedProject(
  actor: McpActor,
  projectId: string | null | undefined,
  required: Permission = 'read'
): Promise<ScopedLookup<McpRecord>> {
  if (!projectId) return { ok: false, error: jsonError('project_id is required') };
  const access = await checkProjectAccess(projectId, actor.userId, actor.role, required);
  if (!access.ok) return { ok: false, error: notFound('Project') };
  return { ok: true, value: access.project };
}

/**
 * Same contract as `scopedBoard`, for agents.
 *
 * `checkAgentAccess` already answers 404 for a missing agent and 403 for one
 * out of reach; both are flattened here for the reason in the module header.
 */
export async function scopedAgent(
  actor: McpActor,
  agent: McpRecord,
  required: 'read' | 'edit' = 'read'
): Promise<ScopedLookup<McpRecord>> {
  if (!agent) return { ok: false, error: notFound('Agent') };
  const access = await checkAgentAccess(agent, actor, required);
  if (!access.ok) return { ok: false, error: notFound('Agent') };
  return { ok: true, value: agent };
}

/**
 * Can the actor act on this task?
 *
 * Mirrors `requireTaskAccess` in routes/tasks.ts one branch at a time — board
 * task → the board decides at 'edit'; board-less task → its owning agent
 * decides; neither → admin only.
 */
export async function scopedTask(
  actor: McpActor,
  task: McpRecord,
  agents: Map<string, McpRecord>,
  required: Permission = 'edit'
): Promise<ScopedLookup<McpRecord>> {
  if (!task) return { ok: false, error: notFound('Task') };
  if (actor.role === 'admin') return { ok: true, value: task };

  if (task.boardId) {
    const access = await checkBoardAccess(task.boardId, actor.userId, actor.role, required);
    if (!access.ok) return { ok: false, error: notFound('Task') };
    return { ok: true, value: task };
  }

  const owner = task.agentId ? agents.get(task.agentId) : null;
  if (!owner) return { ok: false, error: notFound('Task') };
  const access = await checkAgentAccess(owner, actor, required === 'read' ? 'read' : 'edit');
  if (!access.ok) return { ok: false, error: notFound('Task') };
  return { ok: true, value: task };
}

/**
 * The board ids the actor can reach — own boards plus boards shared with them.
 *
 * This is the tenant bound for every LISTING and SEARCH tool. It is the user's
 * own set even when `role === 'admin'`, exactly as `GET /api/boards` is: the
 * admin-wide listing is a separate, explicitly admin-only route, and an API key
 * should not quietly turn one into the other.
 */
export async function actorBoardIds(actor: McpActor): Promise<Set<string>> {
  return getUserBoardIdSet(actor.userId);
}

/**
 * Guard for the handful of tools that are genuinely instance-wide (today:
 * `list_users`). The `admin` SCOPE selects a tool set; it does not confer the
 * `admin` ROLE, so a non-admin holding an admin-scoped key still cannot read
 * the instance's user list.
 */
export function requireAdminRole(actor: McpActor, tool: string): ScopedLookup<true> {
  if (actor.role !== 'admin') {
    return {
      ok: false,
      error: jsonError(
        `${tool} requires the admin role on the key's owner. The "admin" key scope selects a tool set, not a role.`
      ),
    };
  }
  return { ok: true, value: true };
}
