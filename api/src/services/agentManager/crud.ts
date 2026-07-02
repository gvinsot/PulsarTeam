// ─── Agent CRUD: create, update, delete, resetInstructionsByRole ─────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent, deleteAgentFromDb, setAgentOwner, setAgentBoard } from '../database.js';
import { AGENT_TEMPLATES } from '../../data/templates.js';

const AGENT_UPDATE_FIELDS = [
  'name', 'role', 'description', 'instructions', 'temperature',
  'maxTokens', 'contextLength', 'ragDocuments', 'skills', 'mcpServers', 'mcpAuth', 'handoffTargets',
  'color', 'icon', 'project', 'isLeader', 'isVoice', 'isReasoning', 'voice', 'voiceMode', 'ttsVoiceId', 'ttsEnabled', 'enabled',
  'costPerInputToken', 'costPerOutputToken', 'llmConfigId', 'ownerId', 'boardId', 'permissions', 'credentials', 'runner', 'toolHooks'
];

const LLM_FIELDS = ['llmConfigId'];

// Fields that define how a batch member runs. These are propagated to every
// member in the same batch; runtime state (history, sessions, metrics, tasks)
// remains per-agent.
const BATCH_SHARED_FIELDS = new Set(AGENT_UPDATE_FIELDS);
const BATCH_CLONE_FIELDS = [
  ...AGENT_UPDATE_FIELDS.filter((field) => field !== 'name'),
  'template',
];

function _batchBaseName(name: string): string {
  return (name || 'Unnamed Agent').replace(/\s+#\d+$/, '');
}

function _cloneJson(value: any): any {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function _batchMemberConfigFromAgent(agent: any, batchId: string, batchIndex: number, name: string): any {
  const config: any = { name, batchId, batchIndex };
  for (const field of BATCH_CLONE_FIELDS) {
    if (agent[field] !== undefined) config[field] = _cloneJson(agent[field]);
  }
  return config;
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
      instructions: config.instructions || 'You are a helpful AI assistant.',
      status: 'idle',
      currentTask: null,
      temperature: config.temperature !== undefined ? config.temperature : 0.7,
      maxTokens: config.maxTokens ?? 128000,
      contextLength: config.contextLength ?? 0,
      ragDocuments: config.ragDocuments || [],
      skills: config.skills || [],
      mcpServers: config.mcpServers || [],
      mcpAuth: config.mcpAuth || {},
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
      permissions: config.permissions || null,
      credentials: config.credentials || {},
      runner: config.runner || null,
      toolHooks: config.toolHooks || null,
      color: config.color || this._randomColor(),
      icon: config.icon || '🤖',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.agents.set(id, agent);
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

  /**
   * Convert an existing agent into a batch while keeping the original agent
   * as member #1. Runtime state stays on that original agent; newly-created
   * members receive only the shared configuration.
   */
  async convertToBatch(this: any, id: string, size: number): Promise<any[] | null> {
    const agent = this.agents.get(id);
    if (!agent) return null;
    if (agent.isVoice) {
      throw new Error('Voice agents cannot be converted to a batch');
    }

    const totalSize = Math.max(2, Math.min(50, Number(size) || 2));
    const existingMembers = agent.batchId
      ? Array.from(this.agents.values())
          .filter((candidate: any) => candidate.batchId === agent.batchId)
          .sort((a: any, b: any) => (a.batchIndex || 0) - (b.batchIndex || 0))
      : [];

    if (existingMembers.length >= totalSize) {
      return existingMembers.map((member: any) => this._sanitize(member));
    }

    const batchId = agent.batchId || uuidv4();
    const baseName = _batchBaseName((existingMembers[0] || agent).name);
    const members = existingMembers.length > 0 ? existingMembers : [agent];

    if (!agent.batchId) {
      agent.batchId = batchId;
      agent.batchIndex = 1;
      agent.name = `${baseName} #1`;
      agent.updatedAt = new Date().toISOString();
      await saveAgent(agent);
      this._emit('agent:updated', this._sanitize(agent));
    }

    const created: any[] = members.map((member: any) => this._sanitize(member));
    const startIndex = members.length + 1;
    for (let i = startIndex; i <= totalSize; i++) {
      const memberConfig = _batchMemberConfigFromAgent(agent, batchId, i, `${baseName} #${i}`);
      const newAgent = await this.create(memberConfig);
      created.push(newAgent);
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
          const newProject = effectiveUpdates[key];
          // Stop any in-flight work before swapping the agent's repo so we
          // don't keep streaming/exec-ing against the old project's files.
          try { this.stopAgent(target.id); } catch (e: any) {
            console.warn(`⚠️  [Project Change] stopAgent(${target.id}) failed:`, e?.message);
          }
          this._switchProjectContext(target, target.project, newProject);
          target.projectChangedAt = newProject ? new Date().toISOString() : null;
          // Flag the switch as in-progress so the UI can show a dedicated
          // "switching repository" animation until the new repo is cloned and
          // the runtime has restarted in the new working directory.
          target.projectSwitching = true;
          // Re-sync the runner's working copy in the background so the agent
          // is ready to serve the next message. We don't await — cloning can
          // be slow and the HTTP update response shouldn't block on it.
          const targetIdForSync = target.id;
          const targetNameForSync = target.name;
          const boardIdForSync = target.boardId || null;
          if (this.executionManager) {
            (async () => {
              try {
                const { buildRepoCloneUrl } = await import('../repoUrl.js');
                const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
                const gitCreds = await getGitHubCredentialsForAgent(targetIdForSync, boardIdForSync).catch(() => null);
                if (newProject) {
                  const gitUrl = buildRepoCloneUrl(newProject);
                  if (gitUrl) {
                    await this.executionManager.switchProject(targetIdForSync, newProject, gitUrl, gitCreds);
                    console.log(`🔄 [Project Change] Repo synced for "${targetNameForSync}" → "${newProject}"`);
                  }
                } else {
                  await this.executionManager.ensureProject(targetIdForSync, null, null, gitCreds);
                  console.log(`🔄 [Project Change] Cleared repo for "${targetNameForSync}"`);
                }
                // The clone is now in place. Restart the live runtime so the
                // interactive CLI (tmux/PTY) is torn down and respawns with the
                // NEW repo as its working directory. Without this the agent
                // keeps running in the previous repo's cwd until it dies.
                try {
                  await this.restartRuntime(targetIdForSync);
                } catch (restartErr: any) {
                  console.warn(`🔄 [Project Change] restartRuntime failed for "${targetNameForSync}":`, restartErr?.message);
                }
              } catch (err: any) {
                console.error(`🔄 [Project Change] Repo sync failed for "${targetNameForSync}":`, err?.message);
              } finally {
                const synced = this.agents.get(targetIdForSync);
                if (synced) {
                  synced.projectSwitching = false;
                  try { await saveAgent(synced); } catch { /* best effort */ }
                  this._emit('agent:updated', this._sanitize(synced));
                }
              }
            })();
          }
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
    const toSync: Array<{ id: string; name: string; boardId: string | null }> = [];
    for (const agent of this.agents.values()) {
      if (agentIdFilter && !agentIdFilter.has((agent as any).id)) continue;
      const projectChanged = project !== (agent as any).project;
      if (projectChanged) {
        try { this.stopAgent((agent as any).id); } catch (e: any) {
          console.warn(`⚠️  [Project Change] stopAgent(${(agent as any).id}) failed:`, e?.message);
        }
        this._switchProjectContext(agent, (agent as any).project, project);
        (agent as any).projectChangedAt = project ? new Date().toISOString() : null;
        toSync.push({ id: (agent as any).id, name: (agent as any).name, boardId: (agent as any).boardId || null });
      }
      (agent as any).project = project;
      (agent as any).updatedAt = new Date().toISOString();
      await saveAgent(agent);
      updated.push(this._sanitize(agent));
      this._emit('agent:updated', this._sanitize(agent));
    }
    if (toSync.length > 0 && this.executionManager) {
      (async () => {
        try {
          const { buildRepoCloneUrl } = await import('../repoUrl.js');
          const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
          for (const t of toSync) {
            try {
              const gitCreds = await getGitHubCredentialsForAgent(t.id, t.boardId).catch(() => null);
              if (project) {
                const gitUrl = buildRepoCloneUrl(project);
                if (gitUrl) {
                  await this.executionManager.switchProject(t.id, project, gitUrl, gitCreds);
                  console.log(`🔄 [Project Change] Repo synced for "${t.name}" → "${project}"`);
                }
              } else {
                await this.executionManager.ensureProject(t.id, null, null, gitCreds);
                console.log(`🔄 [Project Change] Cleared repo for "${t.name}"`);
              }
              this._emit('agent:updated', this._sanitize(this.agents.get(t.id)));
            } catch (err: any) {
              console.error(`🔄 [Project Change] Repo sync failed for "${t.name}":`, err?.message);
            }
          }
        } catch (err: any) {
          console.error(`🔄 [Project Change] Bulk sync failed:`, err?.message);
        }
      })();
    }
    return updated;
  },
};
