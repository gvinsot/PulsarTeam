// ─── Agent CRUD: create, update, delete, resetInstructionsByRole ─────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent, deleteAgentFromDb, setAgentOwner, setAgentBoard } from '../database.js';
import { AGENT_TEMPLATES } from '../../data/templates.js';

const AGENT_UPDATE_FIELDS = [
  'name', 'role', 'description', 'instructions', 'temperature',
  'maxTokens', 'contextLength', 'ragDocuments', 'skills', 'mcpServers', 'mcpAuth', 'handoffTargets',
  'color', 'icon', 'provider', 'model', 'endpoint', 'apiKey', 'project', 'isLeader', 'isVoice', 'isReasoning', 'voice', 'voiceMode', 'ttsVoiceId', 'ttsEnabled', 'enabled',
  'costPerInputToken', 'costPerOutputToken', 'llmConfigId', 'ownerId', 'boardId', 'permissions', 'credentials', 'runner', 'toolHooks'
];

const LLM_FIELDS = ['provider', 'model', 'llmConfigId', 'endpoint'];

// Fields that define how a batch member runs. These are propagated to every
// member in the same batch; runtime state (history, sessions, metrics, tasks)
// remains per-agent.
const BATCH_SHARED_FIELDS = new Set(AGENT_UPDATE_FIELDS);

function _batchBaseName(name: string): string {
  return (name || 'Unnamed Agent').replace(/\s+#\d+$/, '');
}

/** @this {import('./index.js').AgentManager} */
export const crudMethods = {

  async create(this: any, config: any): Promise<any> {
    const id = uuidv4();
    const agent = {
      id,
      batchId: config.batchId || null,
      batchIndex: config.batchIndex ?? null,
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
      voiceMode: config.voiceMode || (config.isVoice ? 'realtime' : null),
      ttsVoiceId: config.ttsVoiceId || null,
      ttsEnabled: config.ttsEnabled || false,
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

  /**
   * Create N agents sharing the same configuration and a common batchId.
   * Names get suffixed with `#1`, `#2`, … so each agent stays addressable
   * individually (chat, tasks, runner sessions are all per-agent). The UI
   * collapses a batch into a single card with a member dropdown.
   */
  async createBatch(this: any, config: any, size: number): Promise<any[]> {
    const batchId = uuidv4();
    const baseName = (config.name || 'Unnamed Agent').replace(/\s+#\d+$/, '');
    const created: any[] = [];
    for (let i = 1; i <= size; i++) {
      const memberConfig = {
        ...config,
        name: `${baseName} #${i}`,
        batchId,
        batchIndex: i,
      };
      // Avoid the route layer re-triggering batch creation when create() is
      // called for each member.
      delete memberConfig.batchSize;
      const agent = await this.create(memberConfig);
      created.push(agent);
    }
    return created;
  },

  async update(this: any, id: string, updates: any): Promise<any> {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const targets = agent.batchId
      ? Array.from(this.agents.values())
          .filter((candidate: any) => candidate.batchId === agent.batchId)
          .sort((a: any, b: any) => (a.batchIndex || 0) - (b.batchIndex || 0))
      : [agent];
    const batchBaseName = updates.name !== undefined ? _batchBaseName(updates.name) : null;
    let selectedResult: any = null;

    for (const target of targets) {
      const effectiveUpdates: any = agent.batchId
        ? Object.fromEntries(
            Object.entries(updates).filter(([key]) => BATCH_SHARED_FIELDS.has(key))
          )
        : updates;

      const llmChanged = LLM_FIELDS.some(f => effectiveUpdates[f] !== undefined && effectiveUpdates[f] !== target[f]);

      if (llmChanged) {
        target.conversationHistory = [];
        target.runnerSessions = {};
        target.currentThinking = '';
        delete target._compactionArmed;
        console.log(`🔄 [LLM Change] Reset session and history for "${target.name}" — LLM config changed`);
      }

      for (const key of AGENT_UPDATE_FIELDS) {
        if (effectiveUpdates[key] === undefined) continue;

        if (key === 'name' && agent.batchId) {
          target.name = `${batchBaseName} #${target.batchIndex ?? 1}`;
          continue;
        }
        if (key === 'apiKey' && !effectiveUpdates[key] && target[key]) continue;
        if (key === 'ownerId' && effectiveUpdates[key] !== target[key]) {
          target[key] = effectiveUpdates[key];
          await setAgentOwner(target.id, effectiveUpdates[key]);
          continue;
        }
        if (key === 'boardId' && effectiveUpdates[key] !== target[key]) {
          target[key] = effectiveUpdates[key];
          await setAgentBoard(target.id, effectiveUpdates[key]);
          continue;
        }
        if (key === 'mcpAuth') {
          if (!target.mcpAuth) target.mcpAuth = {};
          for (const [serverId, conf] of Object.entries(effectiveUpdates.mcpAuth || {})) {
            if ((conf as any)?.apiKey) {
              target.mcpAuth[serverId] = { apiKey: (conf as any).apiKey };
            } else {
              delete target.mcpAuth[serverId];
            }
          }
          if (this.mcpManager) {
            this.mcpManager.disconnectAgent(target.id).catch(() => {});
          }
          continue;
        }
        if (key === 'credentials') {
          if (!target.credentials) target.credentials = {};
          for (const [name, value] of Object.entries(effectiveUpdates.credentials || {})) {
            if (value) {
              target.credentials[name] = value;
            } else {
              delete target.credentials[name];
            }
          }
          continue;
        }
        if (key === 'project' && effectiveUpdates[key] !== target[key]) {
          this._switchProjectContext(target, target.project, effectiveUpdates[key]);
          target.projectChangedAt = effectiveUpdates[key] ? new Date().toISOString() : null;
        }
        target[key] = effectiveUpdates[key];
      }

      target.updatedAt = new Date().toISOString();
      await saveAgent(target);
      const sanitized = this._sanitize(target);
      this._emit('agent:updated', sanitized);
      if (target.id === id) selectedResult = sanitized;
    }

    return selectedResult || this._sanitize(this.agents.get(id));
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
