// ─── Agent CRUD: create, update, delete, resetInstructionsByRole ─────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent, deleteAgentFromDb, setAgentOwner, setAgentBoard } from '../database.js';
import { AGENT_TEMPLATES } from '../../data/templates.js';

/** @this {import('./index.js').AgentManager} */
export const crudMethods = {

  async create(this: any, config: any): Promise<any> {
    const id = uuidv4();
    const agent = {
      id,
      name: config.name || 'Unnamed Agent',
      role: config.role || 'general',
      description: config.description || '',
      provider: config.provider,
      model: config.model,
      endpoint: config.endpoint || '',
      apiKey: config.apiKey || (config.copyApiKeyFromAgent && this.agents.get(config.copyApiKeyFromAgent)?.apiKey) || '',
      instructions: config.instructions || 'You are a helpful AI assistant.',
      status: 'idle',
      currentTask: null,
      temperature: config.temperature !== undefined ? config.temperature : 0.7,
      maxTokens: config.maxTokens ?? 128000,
      contextLength: config.contextLength ?? 0,
      ragDocuments: config.ragDocuments || [],
      skills: config.skills || [],
      mcpServers: config.mcpServers || [],
      conversationHistory: [],
      runnerSessions: {},
      actionLogs: [],
      currentThinking: '',
      metrics: {
        totalMessages: 0,
        totalTokensIn: 0,
        totalTokensOut: 0,
        lastActiveAt: null,
        errors: 0
      },
      handoffTargets: config.handoffTargets || [],
      project: config.project || null,
      projectChangedAt: config.project ? new Date().toISOString() : null,
      projectContexts: {},
      enabled: config.enabled !== undefined ? config.enabled : true,
      isLeader: config.isLeader || config.isVoice || false,
      isVoice: config.isVoice || false,
      isReasoning: config.isReasoning || false,
      voice: config.voice || 'alloy',
      template: config.template || null,
      costPerInputToken: config.costPerInputToken ?? null,
      costPerOutputToken: config.costPerOutputToken ?? null,
      llmConfigId: config.llmConfigId || null,
      ownerId: config.ownerId || null,
      boardId: config.boardId || null,
      runner: config.runner || null,
      color: config.color || this._randomColor(),
      icon: config.icon || '🤖',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.agents.set(id, agent);
    this._tasks.set(id, config.todoList || []);
    await saveAgent(agent);
    if (config.ownerId) {
      await setAgentOwner(id, config.ownerId);
    }
    if (config.boardId) {
      await setAgentBoard(id, config.boardId);
    }
    this._emit('agent:created', this._sanitize(agent));
    return this._sanitize(agent);
  },

  async update(this: any, id: string, updates: any): Promise<any> {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const allowed = [
      'name', 'role', 'description', 'instructions', 'temperature',
      'maxTokens', 'contextLength', 'ragDocuments', 'skills', 'mcpServers', 'mcpAuth', 'handoffTargets',
      'color', 'icon', 'provider', 'model', 'endpoint', 'apiKey', 'project', 'isLeader', 'isVoice', 'isReasoning', 'voice', 'enabled',
      'costPerInputToken', 'costPerOutputToken', 'llmConfigId', 'ownerId', 'boardId', 'credentials', 'runner', 'toolHooks'
    ];

    const llmFields = ['provider', 'model', 'llmConfigId', 'endpoint'];
    const llmChanged = llmFields.some(f => updates[f] !== undefined && updates[f] !== agent[f]);

    if (llmChanged) {
      agent.conversationHistory = [];
      agent.runnerSessions = {};
      agent.currentThinking = '';
      delete agent._compactionArmed;
      console.log(`🔄 [LLM Change] Reset session and history for "${agent.name}" — LLM config changed`);
    }

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        if (key === 'apiKey' && !updates[key] && agent[key]) continue;
        if (key === 'ownerId' && updates[key] !== agent[key]) {
          agent[key] = updates[key];
          setAgentOwner(agent.id, updates[key]);
          continue;
        }
        if (key === 'boardId' && updates[key] !== agent[key]) {
          agent[key] = updates[key];
          setAgentBoard(agent.id, updates[key]);
          continue;
        }
        if (key === 'mcpAuth') {
          if (!agent.mcpAuth) agent.mcpAuth = {};
          for (const [serverId, conf] of Object.entries(updates.mcpAuth || {})) {
            if ((conf as any)?.apiKey) {
              agent.mcpAuth[serverId] = { apiKey: (conf as any).apiKey };
            } else {
              delete agent.mcpAuth[serverId];
            }
          }
          if (this.mcpManager) {
            this.mcpManager.disconnectAgent(id).catch(() => {});
          }
          continue;
        }
        if (key === 'credentials') {
          if (!agent.credentials) agent.credentials = {};
          for (const [name, value] of Object.entries(updates.credentials || {})) {
            if (value) {
              agent.credentials[name] = value;
            } else {
              delete agent.credentials[name];
            }
          }
          continue;
        }
        if (key === 'project' && updates[key] !== agent[key]) {
          this._switchProjectContext(agent, agent.project, updates[key]);
          agent.projectChangedAt = updates[key] ? new Date().toISOString() : null;
        }
        agent[key] = updates[key];
      }
    }
    agent.updatedAt = new Date().toISOString();

    await saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return this._sanitize(agent);
  },

  /**
   * Reset instructions of all agents matching a role to their default template.
   * Returns the list of agent ids that were reset.
   */
  async resetInstructionsByRole(this: any, role: string): Promise<{ error: string | null; reset: string[] }> {
    const template = (AGENT_TEMPLATES as any[]).find((t: any) => t.role === role);
    if (!template) return { error: 'no_template', reset: [] };

    const reset: string[] = [];
    for (const [id, agent] of this.agents) {
      if ((agent as any).role !== role) continue;
      (agent as any).instructions = template.instructions;
      (agent as any).updatedAt = new Date().toISOString();
      await saveAgent(agent);
      this._emit('agent:updated', this._sanitize(agent));
      reset.push(id);
    }
    return { error: null, reset };
  },

  async delete(this: any, id: string): Promise<boolean> {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const ownerId = this.agents.get(id)?.ownerId || null;
    if (this.executionManager) {
      this.executionManager.destroySandbox(id).catch((err: any) => {
        console.error(`Failed to destroy execution environment for agent ${id}:`, err.message);
      });
    }
    if (this.mcpManager) {
      this.mcpManager.disconnectAgent(id).catch((err: any) => {
        console.error(`Failed to disconnect MCP for agent ${id}:`, err.message);
      });
    }
    // Clean up all in-memory state for this agent
    this._tasks.delete(id);
    this._taskQueues.delete(id);
    this._chatLocks.delete(id);
    const pendingTimer = this._updateTimers.get(id);
    if (pendingTimer) clearTimeout(pendingTimer);
    this._updateTimers.delete(id);
    this._updatePending.delete(id);
    this._conditionProcessing.delete(id);
    this.abortControllers.delete(id);
    this.agents.delete(id);
    await deleteAgentFromDb(id);
    this._emit('agent:deleted', { id, ownerId });
    return true;
  },

  async updateAllProjects(this: any, project: string | null, agentIdFilter: Set<string> | null = null): Promise<any[]> {
    const updated: any[] = [];
    for (const agent of this.agents.values()) {
      if (agentIdFilter && !agentIdFilter.has((agent as any).id)) continue;
      if (project !== (agent as any).project) {
        this._switchProjectContext(agent, (agent as any).project, project);
        (agent as any).projectChangedAt = project ? new Date().toISOString() : null;
      }
      (agent as any).project = project;
      (agent as any).updatedAt = new Date().toISOString();
      await saveAgent(agent);
      updated.push(this._sanitize(agent));
      this._emit('agent:updated', this._sanitize(agent));
    }
    return updated;
  },
};
