// ── Agent authorization: the single passage point ────────────────────────────
//
// PulsarTeam is multi-tenant — several organizations share one instance — and
// the API is routed publicly (devops/docker-compose.swarm.yml). "Acting as an
// agent" is therefore a privilege, not a routing detail: an agent holds its
// owner's Google / Microsoft / GitHub / Slack OAuth tokens and, through
// /api/local-folder/mcp, a bridge to their physical machine.
//
// Every surface that accepts a CALLER-SUPPLIED agent id resolves the decision
// here, so there is one rule to read and one rule to change:
//   • services/mcpHttpHandler.ts   — the X-Agent-Id / X-Board-Id headers on the
//                                    16 internal MCP endpoints
//   • routes/oauthProviderRoutes.ts — ?agentId= / body.agentId on the shared
//                                    /status, /auth-url and /disconnect routes
//   • routes/realtime.ts           — body.agentId on the voice token mint
//   • routes/externalVoice.ts      — :agentId / ?agentId on the voice config
//   • routes/agents.ts             — requireAgentAccess / requireAgentEditAccess
//   • services/agentManager/getters.ts — the visible-agents listing filter
//
// ── The visibility rule ─────────────────────────────────────────────────────
//   1. Agent attached to a board → whoever has access to that board decides
//      (middleware/authz.ts checkBoardAccess, at the requested level).
//   2. Agent with NO board but an owner → that owner only.
//   3. Agent with no board AND no owner → `role === 'admin'` only.
//
// Case 3 is real, not theoretical: `agents.owner_id` is
// `UUID REFERENCES users(id) ON DELETE SET NULL` (services/database/baseSchema.ts,
// and the migration in database/migrations.ts), so it drops back to NULL when a
// user is deleted, and agents created before the column existed never had one.
// Those records are deliberately closed to everyone but an admin rather than
// left visible to the whole instance, which is what the previous
// "agents without a board are visible to everyone" fallback did.
//
// ── Internal service sessions ───────────────────────────────────────────────
// The agent execution loop is NOT a user request. `resolveInternalMcpConfig`
// (services/mcpManager.ts) mints a JWT `{ username: 'internal-mcp',
// role: 'admin', internal: true }` signed with JWT_SECRET, and
// `_callToolWithAgentContext` calls the internal MCP endpoints with it plus the
// X-Agent-Id header. That token carries no `userId`, so it can be recognized
// but never scoped to a tenant: it is a SERVICE credential the API mints for
// itself. It is accepted as-is so the execution loop keeps working.
//
// Residual risk, deliberately left for a separate pass because it lives in the
// token MINT rather than in this check: the same internal token is written into
// each CLI runner's MCP config file at spawn (mcpManager.getClaudeMcpConfigForAgent,
// 24h TTL), so a runner that reads its own config could replay it with another
// agent's id. Binding that token to the agent it was minted for — an `agentId`
// claim this function would then enforce — is the fix, and it belongs in
// mcpManager.ts.

import type { NextFunction, Request, Response } from 'express';
import { checkBoardAccess } from '../middleware/authz.js';
import { sessionUser } from '../middleware/auth.js';
import type { SessionClaims } from '../middleware/session.js';
import { getAgentById } from '../services/database.js';

/**
 * 'read' is the permissive level (see an agent, read its status); 'edit' is
 * required to act AS the agent or to mutate anything it owns. Mirrors the
 * board permission levels one-to-one.
 */
export type AgentAccessLevel = 'read' | 'edit';

/**
 * The only fields the decision reads off an agent. Declared structurally so
 * both the in-memory `agentManager.agents` records and the DB-loaded `Agent`
 * rows satisfy it without a cast.
 */
export interface AgentAccessSubject {
  boardId?: string | null;
  ownerId?: string | null;
}

/**
 * Same shape as `BoardAccessResult` (middleware/authz.ts) so call sites read
 * identically. `reason` names which of the four grants applied — it is for
 * logging and tests, never for a second decision.
 *
 * Kept as one interface rather than a discriminated union on purpose: this
 * project's tsc does not narrow the negative branch of such a union, so
 * `if (!access.ok) …` would leave `status`/`error` unreachable.
 */
export interface AgentAccessResult {
  ok: boolean;
  status?: number;
  error?: string;
  reason?: 'internal' | 'admin' | 'board' | 'owner';
}

/**
 * True for the service token the API mints for its own agent execution loop.
 *
 * `internal` is not declared on `SessionClaims` because no user session ever
 * carries it; widening to a structural type with an optional `unknown` member
 * reads it without an assertion.
 */
export function isInternalServiceSession(user: SessionClaims): boolean {
  const claims: SessionClaims & { internal?: unknown } = user;
  return claims.internal === true;
}

/**
 * The rule, applied to an already-resolved agent. Async because case 1 goes to
 * the DB for the board share.
 */
export async function checkAgentAccess(
  agent: AgentAccessSubject | null | undefined,
  user: SessionClaims,
  level: AgentAccessLevel = 'read'
): Promise<AgentAccessResult> {
  if (!agent) return { ok: false, status: 404, error: 'Agent not found' };

  // The API acting for itself — see the module header.
  if (isInternalServiceSession(user)) return { ok: true, reason: 'internal' };

  if (user.role === 'admin') return { ok: true, reason: 'admin' };

  // 1. Board-scoped agent: the board decides, at the requested level.
  if (agent.boardId) {
    const access = await checkBoardAccess(agent.boardId, user.userId, user.role, level);
    if (!access.ok) {
      return { ok: false, status: access.status || 403, error: access.error || 'Access denied' };
    }
    return { ok: true, reason: 'board' };
  }

  // 2. No board, but an owner: that owner only. `user.userId` is checked
  // explicitly because a non-user session reaches this with no id, and
  // `undefined === null` must never read as a match.
  if (agent.ownerId) {
    if (user.userId && agent.ownerId === user.userId) return { ok: true, reason: 'owner' };
    return { ok: false, status: 403, error: 'Access denied' };
  }

  // 3. No board and no owner: admin only, and admin already returned above.
  return { ok: false, status: 403, error: 'Access denied' };
}

/**
 * Same rule, starting from an id the caller supplied. Loads the agent from the
 * DB, so it works in the MCP handlers, which have no `agentManager` in hand.
 */
export async function checkAgentIdAccess(
  agentId: string | null | undefined,
  user: SessionClaims,
  level: AgentAccessLevel = 'read'
): Promise<AgentAccessResult> {
  if (!agentId) return { ok: false, status: 400, error: 'agentId required' };
  // Short-circuited ahead of the lookup: the agent execution loop reaches the
  // MCP endpoints on every tool call, and a service session is granted whatever
  // the row says, so the round-trip would buy nothing.
  if (isInternalServiceSession(user)) return { ok: true, reason: 'internal' };
  const agent = await getAgentById(agentId);
  return checkAgentAccess(agent, user, level);
}

/**
 * The board half of the same guard, for surfaces that accept a caller-supplied
 * board id alongside (or instead of) an agent id. Thin wrapper over
 * `checkBoardAccess` that normalises the result to `AgentAccessResult` and
 * lets an internal service session through for the same reason as above.
 */
export async function checkBoardIdAccess(
  boardId: string | null | undefined,
  user: SessionClaims,
  level: AgentAccessLevel = 'read'
): Promise<AgentAccessResult> {
  if (!boardId) return { ok: false, status: 400, error: 'boardId required' };
  if (isInternalServiceSession(user)) return { ok: true, reason: 'internal' };
  const access = await checkBoardAccess(boardId, user.userId, user.role, level);
  if (!access.ok) {
    return { ok: false, status: access.status || 403, error: access.error || 'Access denied' };
  }
  return { ok: true, reason: access.isOwner ? 'owner' : 'board' };
}

/**
 * Synchronous form of the same rule, for LISTINGS that filter thousands of
 * agents and cannot await a board query per row. The caller resolves the
 * board set once (lib/boardAccess.ts getUserBoardIdSet) and passes it in.
 *
 * @param userBoardIds - Boards the caller can see. When it is missing the
 *   filter CLOSES rather than opens: a non-admin caller then sees no
 *   board-scoped agent at all. The unscoped swarm-leader routes
 *   (routes/lib/agentStatusHandlers.ts) are the callers that omit it.
 */
export function canSeeAgent(
  agent: AgentAccessSubject,
  user: { userId?: string | null; role?: string | null },
  userBoardIds?: ReadonlySet<string>
): boolean {
  if (user.role === 'admin') return true;
  // 1. Board-scoped: membership decides.
  if (agent.boardId) return userBoardIds ? userBoardIds.has(agent.boardId) : false;
  // 2. Unscoped but owned: the owner only.
  if (agent.ownerId) return !!user.userId && agent.ownerId === user.userId;
  // 3. Neither board nor owner: admin only, and admin already returned above.
  return false;
}

/**
 * Express adapter for `checkAgentAccess`, for routers mounted on an ':id'
 * param. `resolve` keeps the lookup with the caller so `routes/agents.ts` goes
 * on reading its in-memory `agentManager.agents` map — the 404-before-401
 * ordering below is the one that router had before this helper existed.
 */
export function agentAccessMiddleware(
  resolve: (agentId: string) => AgentAccessSubject | null | undefined,
  level: AgentAccessLevel
) {
  const guard = async (
    req: Request<{ id: string }>,
    res: Response,
    next: NextFunction
  ): Promise<Response | void> => {
    const agent = resolve(req.params.id);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    const user = sessionUser(req, res);
    if (!user) return;
    const access = await checkAgentAccess(agent, user, level);
    if (!access.ok) return res.status(access.status || 403).json({ error: access.error });
    next();
  };
  // Express keeps only the function reference in its routing stack, so the
  // guard carries its own name — access level included, which is what lets the
  // route inventory (services/__tests__/routeInventory.test.ts) tell a
  // mutating route's 'edit' guard from a read-only one. Naming only.
  Object.defineProperty(guard, 'name', { value: `agentAccess(${level})` });
  return guard;
}
