// ─── Agent Getters: read-only lookups ────────────────────────────────────────

/** @this {import('./index.js').AgentManager} */
export const gettersMethods = {
  getAll(this: any): any[] {
    return Array.from(this.agents.values()).map((a: any) => this._sanitize(a));
  },

  /**
   * Return agents visible to a user based on board access.
   * A user sees: agents on boards they own or have been shared + agents with no board.
   * @param userBoardIds - Set of board IDs the user has access to
   */
  getAllForUser(
    this: any,
    userId: string,
    role: string | null | undefined,
    userBoardIds?: Set<string>
  ): any[] {
    return this._agentsForUser(userId, role, userBoardIds).map((a: any) => this._sanitize(a));
  },

  /**
   * Internal: return raw (unsanitized) agents visible to a user.
   *
   * @param role - The caller's user role. It is read only when no board set is
   *   supplied: 'admin' is then the one role allowed to see board-scoped agents.
   * @param userBoardIds - Set of board IDs the user has access to. When it is
   *   missing the filter CLOSES rather than opens: a non-admin caller sees only
   *   the agents that carry no board at all. The unscoped swarm-leader routes
   *   (routes/lib/agentStatusHandlers.ts) are the callers that omit it.
   */
  _agentsForUser(
    this: any,
    _userId: string,
    role: string | null | undefined,
    userBoardIds?: Set<string>
  ): any[] {
    const isAdmin = role === 'admin';
    return Array.from(this.agents.values()).filter((a: any) => {
      // Agents without a board are visible to everyone
      if (!a.boardId) return true;
      // If we have board IDs, check membership
      if (userBoardIds) return userBoardIds.has(a.boardId);
      // No board info: only an admin may see agents that belong to a board
      return isAdmin;
    });
  },

  getById(this: any, id: string): any {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._sanitize(agent);
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
