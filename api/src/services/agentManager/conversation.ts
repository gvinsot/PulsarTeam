// ─── Conversation: history management, context switching, voice, coder reset ─
import { saveAgent, clearTaskExecutionFlags } from '../database.js';
import { readSecret } from '../../secrets.js';

/** @this {import('./index.js').AgentManager} */
export const conversationMethods = {

  clearHistory(this: any, agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.conversationHistory = [];
    agent.currentThinking = '';
    delete agent._compactionArmed;
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
    // Reset Claude Code CLI session if this is a claude-paid agent
    this._resetCoderSession(agentId, agent);
    saveAgent(agent);
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
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.conversationHistory;
  },

  // ─── Session Reset ─────────────────────────────────────────────────
  _resetCoderSession(this: any, agentId: string, agent: any): void {
    if (this.executionManager) {
      const provider = this.executionManager._providerFor(agentId);
      if (provider?.resetSession) {
        provider.resetSession(agentId).catch((err: any) => {
          console.warn(`⚠️  [Session] Failed to reset runner session: ${err.message}`);
        });
        return;
      }
    }
    const llmConfig = this.resolveLlmConfig(agent);
    if (llmConfig.provider !== 'claude-paid') return;
    const endpoint = process.env.CLAUDECODE_SERVICE_URL || process.env.CODER_SERVICE_URL || 'http://claudecode-service:8000';
    const apiKey = llmConfig.apiKey || readSecret('CODER_API_KEY');
    fetch(`${endpoint}/reset`, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'X-Agent-Id': agentId,
      },
    }).then(res => {
      if (res.ok) console.log(`🔄 [Session] Reset claudecode-service session for "${agent.name}"`);
      else console.warn(`⚠️  [Session] Failed to reset claudecode-service session: ${res.status}`);
    }).catch((err: any) => {
      console.warn(`⚠️  [Session] Failed to reset claudecode-service session: ${err.message}`);
    });
  },

  // ─── Project Context Switching ──────────────────────────────────────
  _switchProjectContext(this: any, agent: any, oldProject: string | null, newProject: string | null): void {
    if (!agent.projectContexts) agent.projectContexts = {};

    if (oldProject) {
      agent.projectContexts[oldProject] = {
        conversationHistory: [...agent.conversationHistory],
        _compactionArmed: agent._compactionArmed,
        savedAt: new Date().toISOString()
      };
      console.log(`💾 [Context Switch] Saved context for "${agent.name}" on project "${oldProject}" (${agent.conversationHistory.length} messages)`);
    }

    if (newProject && agent.projectContexts[newProject]) {
      const saved = agent.projectContexts[newProject];
      agent.conversationHistory = [...saved.conversationHistory];
      agent._compactionArmed = saved._compactionArmed;
      delete agent.projectContexts[newProject];
      console.log(`📂 [Context Switch] Restored context for "${agent.name}" on project "${newProject}" (${agent.conversationHistory.length} messages)`);
    } else {
      agent.conversationHistory = [];
      agent.currentThinking = '';
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
