// ─── Agent Getters: read-only lookups ────────────────────────────────────────

import { canSeeAgent } from '../../lib/agentAccess.js';

/** @this {import('./index.js').AgentManager} */
export const gettersMethods = {
  getAll(this: any, projection = null): any[] {
    return Array.from(this.agents.values()).map((a: any) =>
      this._projectSanitizedAgent(a, projection)
    );
  },

  /**
   * Return agents visible to a user based on board access.
   * A user sees: agents on boards they own or have been shared, plus the
   * board-less agents they own themselves. See lib/agentAccess.ts.
   * @param userBoardIds - Set of board IDs the user has access to
   */
  getAllForUser(
    this: any,
    userId: string,
    role: string | null | undefined,
    userBoardIds?: Set<string>,
    projection = null
  ): any[] {
    return this._agentsForUser(userId, role, userBoardIds).map((a: any) =>
      this._projectSanitizedAgent(a, projection)
    );
  },

  /**
   * Internal: return raw (unsanitized) agents visible to a user.
   *
   * The rule itself is `canSeeAgent` in lib/agentAccess.ts — the same three
   * cases the request-time guard enforces. It replaces the previous
   * "agents without a board are visible to everyone" fallback, which on a
   * multi-tenant instance published every board-less agent (and its status,
   * project and task counts) to every account.
   *
   * @param role - The caller's user role. 'admin' sees everything, including
   *   the ownerless legacy agents nobody else can claim.
   * @param userBoardIds - Set of board IDs the user has access to. When it is
   *   missing the filter CLOSES rather than opens: a non-admin caller then sees
   *   no board-scoped agent at all. The unscoped swarm-leader routes
   *   (routes/lib/agentStatusHandlers.ts) are the callers that omit it.
   */
  _agentsForUser(
    this: any,
    userId: string,
    role: string | null | undefined,
    userBoardIds?: Set<string>
  ): any[] {
    return Array.from(this.agents.values()).filter((a: any) =>
      canSeeAgent(a, { userId, role }, userBoardIds)
    );
  },

  getById(this: any, id: string, projection = null): any {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._projectSanitizedAgent(agent, projection);
  },

  getLastMessages(this: any, agentId: string, limit: number = 1): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 1;
    const history = Array.isArray(agent.conversationHistory) ? agent.conversationHistory : [];
    const startIndex = Math.max(0, history.length - safeLimit);

    const messages = history.slice(-safeLimit).map((m: any, idx: number) => ({
      index: startIndex + idx,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || null,
      type: m.type || null,
    }));

    return {
      agentId: agent.id,
      agentName: agent.name,
      project: agent.project || null,
      status: agent.status,
      totalMessages: history.length,
      returned: messages.length,
      limit: safeLimit,
      messages,
    };
  },

  getLastMessagesByName(this: any, agentName: string, limit: number = 1): any {
    if (!agentName) return null;
    const target = Array.from(this.agents.values()).find(
      (a: any) => (a.name || '').toLowerCase() === String(agentName).toLowerCase()
    );
    if (!target) return null;
    return this.getLastMessages((target as any).id, limit);
  },
};
