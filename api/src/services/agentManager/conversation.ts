// ─── Conversation: history management, context switching, voice ───────────────
import { saveAgent, clearTaskExecutionFlags } from '../database.js';

/** @this {import('./index.js').AgentManager} */
export const conversationMethods = {

  async clearHistory(this: any, agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.conversationHistory = [];
    agent.currentThinking = '';
    delete agent._compactionArmed;
    // Invalidate every runner session: the DB history is now empty so any
    // --resume on the runner side would replay a stale JSONL. The next call
    // mints a fresh session UUID and the runner records it in
    // agent.runnerSessions for us.
    agent.runnerSessions = {};
    // Stop all active reminder loops for tasks involving this agent
    for (const [ownerId] of this.agents) {
      for (const task of this._getAgentTasks(ownerId)) {
        if (task.assignee === agentId || ownerId === agentId) {
          if (task._executionWatching) {
            task._executionStopped = true;
            delete task._executionWatching;
          }
          delete task.startedAt;
          delete task._completedActionIdx;
          task.completedActionIdx = null;
          task.executionStatus = null;
          delete task.actionRunning;
          delete task.actionRunningAgentId;
        }
      }
    }
    // Persist the cleared execution flags to DB
    clearTaskExecutionFlags(agentId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  /** Invalidate every per-agent cache so the next chat starts from a clean
   * slate that picks up any pending config change (plugins, MCP servers,
   * LLM config, instructions, project files). What gets cleared:
   *
   *  - In-flight stream + abort controller   (via stopAgent)
   *  - Conversation history + thinking buffer + compaction state +
   *    runner session UUIDs + per-task execution flags  (via clearHistory)
   *  - Stream resume cache (so a stale buffer doesn't get replayed)
   *  - Chat lock (so a stuck in-flight flag doesn't block the next send)
   *  - Retry/compaction-retry counters
   *  - LLM configs cache (reload from DB so model/endpoint edits land)
   *  - Per-agent MCP client connections (reconnect with current auth)
   *  - Project file tree (re-read so file additions/deletions show up)
   *  - Shared CLI terminal session (next terminal attach starts a fresh CLI)
   *
   * Returns true on success, false if the agent doesn't exist.
   */
  async reloadContext(this: any, agentId: string): Promise<boolean> {
    const agent = this.agents.get(agentId);
    if (!agent) return false;

    // 1. Abort any in-flight stream so we don't fight it.
    try { this.stopAgent(agentId); } catch { /* ignore */ }

    // 2. Drop the stream resume cache for this agent.
    if (this._activeStreams) this._activeStreams.delete(agentId);

    // 3. Drop the chat lock (if stopAgent didn't already).
    if (this._chatLocks) this._chatLocks.delete(agentId);

    // 4. Reset transient retry flags so the next call starts fresh.
    delete agent._streamRetryCount;
    delete agent._compactionRetried;

    // 5. Wipe conversation state (history, runner sessions, task flags…).
    await this.clearHistory(agentId);

    // 6. Force-refresh LLM configs from DB (global 60s cache).
    try { await this.refreshLlmConfigs(); } catch (err: any) {
      console.warn(`⚠️  [ReloadContext] refreshLlmConfigs failed: ${err.message}`);
    }

    // 7. Drop per-agent MCP client connections so the next tool call
    //    reconnects with the current auth / server config.
    if (this.mcpManager?.disconnectAgent) {
      try { await this.mcpManager.disconnectAgent(agentId); } catch (err: any) {
        console.warn(`⚠️  [ReloadContext] mcp.disconnectAgent failed: ${err.message}`);
      }
    }

    // 8. Refresh the project file tree so any new/deleted files are visible
    //    in the next system prompt. Skip if the agent has no project bound.
    if (agent.project && this.executionManager?.refreshFileTree) {
      try { await this.executionManager.refreshFileTree(agentId); } catch (err: any) {
        console.warn(`⚠️  [ReloadContext] refreshFileTree failed: ${err.message}`);
      }
    }

    // 9. Restart shared CLI terminal sessions. Close all CLI runner services
    //    because reload can run before this API replica has bound the agent,
    //    or after the runner setting changed.
    let terminalClosed = false;
    if (this.executionManager?.closeCliTerminalSessions) {
      try {
        terminalClosed = await this.executionManager.closeCliTerminalSessions(agentId);
      } catch (err: any) {
        console.warn(`⚠️  [ReloadContext] closeCliTerminalSessions failed: ${err.message}`);
      }
    } else if (this.executionManager?.closeTerminalSession) {
      try {
        terminalClosed = await this.executionManager.closeTerminalSession(agentId);
      } catch (err: any) {
        console.warn(`⚠️  [ReloadContext] closeTerminalSession failed: ${err.message}`);
      }
    }

    this.addActionLog(
      agentId,
      'info',
      terminalClosed
        ? 'Context reloaded — caches invalidated and CLI restarted'
        : 'Context reloaded — caches invalidated'
    );
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  truncateHistory(this: any, agentId: string, afterIndex: any): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const idx = parseInt(afterIndex, 10);
    if (isNaN(idx) || idx < 0) return null;
    agent.conversationHistory = agent.conversationHistory.slice(0, idx + 1);
    agent.conversationHistory = agent.conversationHistory.filter((m: any) => m.type !== 'compaction-summary');
    delete agent._compactionArmed;
    // History diverged from whatever the runner's JSONL holds — force a
    // fresh CLI session on next call so the model sees the truncated
    // history instead of the original one.
    agent.runnerSessions = {};
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.conversationHistory;
  },

  // ─── Project Context Switching ──────────────────────────────────────
  _switchProjectContext(this: any, agent: any, oldProject: string | null, newProject: string | null): void {
    if (!agent.projectContexts) agent.projectContexts = {};

    if (oldProject) {
      agent.projectContexts[oldProject] = {
        conversationHistory: [...agent.conversationHistory],
        _compactionArmed: agent._compactionArmed,
        runnerSessions: { ...(agent.runnerSessions || {}) },
        savedAt: new Date().toISOString()
      };
      console.log(`💾 [Context Switch] Saved context for "${agent.name}" on project "${oldProject}" (${agent.conversationHistory.length} messages)`);
    }

    if (newProject && agent.projectContexts[newProject]) {
      const saved = agent.projectContexts[newProject];
      agent.conversationHistory = [...saved.conversationHistory];
      agent._compactionArmed = saved._compactionArmed;
      agent.runnerSessions = { ...(saved.runnerSessions || {}) };
      delete agent.projectContexts[newProject];
      console.log(`📂 [Context Switch] Restored context for "${agent.name}" on project "${newProject}" (${agent.conversationHistory.length} messages)`);
    } else {
      agent.conversationHistory = [];
      agent.currentThinking = '';
      agent.runnerSessions = {};
      delete agent._compactionArmed;
      console.log(`🆕 [Context Switch] Clean slate for "${agent.name}" on project "${newProject || '(none)'}"`);
    }
  },

  // ─── Voice Agent Instructions ────────────────────────────────────
  buildVoiceInstructions(this: any, agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    let instructions = agent.instructions || 'You are a helpful voice assistant.';

    const availableAgents = Array.from(this.agents.values())
      .filter((a: any) => a.id !== agentId && a.enabled !== false)
      .map((a: any) => `- ${a.name} (${a.role}): ${a.description || 'No description'}`);

    if (availableAgents.length > 0) {
      instructions += `\n\n--- Available Swarm Agents ---\nYou can delegate tasks to these agents using the "delegate" function. Call it with the agent's name and a detailed task description.\n${availableAgents.join('\n')}\n\nWhen you need an agent to work on something, use the delegate function. The result will be provided back to you and you should summarize it vocally.`;
    }

    if (agent.ragDocuments && agent.ragDocuments.length > 0) {
      instructions += '\n\n--- Reference Documents ---\n';
      for (const doc of agent.ragDocuments) {
        instructions += `\n[${doc.name}]:\n${doc.content}\n`;
      }
    }

    const agentSkills = agent.skills || [];
    if (agentSkills.length > 0 && this.skillManager) {
      const resolvedSkills = agentSkills.map((sid: string) => this.skillManager.getById(sid)).filter(Boolean);
      if (resolvedSkills.length > 0) {
        instructions += '\n\n--- Active Skills ---\n';
        for (const skill of resolvedSkills) {
          instructions += `\n[${(skill as any).name}]:\n${(skill as any).instructions}\n`;
        }
      }
    }

    const voiceTasks = this._getAgentTasks(agentId);
    if (voiceTasks.length > 0) {
      instructions += '\n\n--- Current Task List ---\n';
      for (const task of voiceTasks) {
        const mark = task.status === 'done' ? 'x' : this._isActiveTaskStatus(task.status) ? '~' : task.status === 'error' ? '!' : ' ';
        instructions += `- [${mark}] ${task.text}\n`;
      }
    }

    return instructions;
  },
};
