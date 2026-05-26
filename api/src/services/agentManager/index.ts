// ─── AgentManager: class shell + constructor + mixin assembly ─────────────────
import { getAllAgents, saveAgent, setAgentOwner, setAgentBoard, getAllLlmConfigs, recordTokenUsage, getTasksByAgent, getTaskById } from '../database.js';
import { WsEmitter } from '../../ws/emitter.js';

import { lifecycleMethods } from './lifecycle.js';
import { chatMethods } from './chat.js';
import { toolsMethods } from './tools.js';
import { parsingMethods } from './parsing.js';
import { tasksMethods } from './tasks.js';
import { workflowMethods } from './workflow.js';
import { compactionMethods } from './compaction.js';

// ─── Interface merging: declare all mixin methods on AgentManager ─────────────
export interface AgentManager {
  // ── crud.ts ──
  create(config: any): Promise<any>;
  update(id: string, updates: any): Promise<any>;
  delete(id: string): Promise<boolean>;
  resetInstructionsByRole(role: string): Promise<{ error: string | null; reset: string[] }>;
  updateAllProjects(project: string | null, agentIdFilter?: Set<string> | null): Promise<any[]>;

  // ── getters.ts ──
  getAll(): any[];
  getAllForUser(userId: string, role?: string, userBoardIds?: Set<string>): any[];
  _agentsForUser(userId: string, role?: string, userBoardIds?: Set<string>): any[];
  getById(id: string): any | null;
  getLastMessages(agentId: string, limit?: number): any | null;
  getLastMessagesByName(agentName: string, limit?: number): any | null;

  // ── status.ts ──
  getAgentStatus(id: string): any | null;
  getAllStatuses(userId?: string | null, role?: string | null, userBoardIds?: Set<string>): any[];
  getAgentsByProject(projectName: string, userId?: string | null, role?: string | null, userBoardIds?: Set<string>): any[];
  getProjectSummary(userId?: string | null, role?: string | null, userBoardIds?: Set<string>): any;
  getSwarmStatus(userId?: string | null, role?: string | null, userBoardIds?: Set<string>): any;
  setStatus(id: string, status: string, detail?: string | null): void;
  stopAgent(id: string): boolean;
  beginStream(agentId: string, opts?: { userMessage?: string | null; userMessageId?: string | null }): void;
  appendStreamChunk(agentId: string, chunk: string): void;
  endStream(agentId: string, extra?: Record<string, any>): void;
  errorStream(agentId: string, error: string): void;
  getActiveStream(agentId: string): ActiveStream | null;
  getActiveStreamsForUser(userId: string, role: string | null, userBoardIds: Set<string>): ActiveStream[];

  // ── taskStats.ts ──
  _collectTasks(projectFilter?: string | null): any[];
  getTaskStats(projectFilter?: string | null): any;
  getTaskTimeSeries(projectFilter?: string | null, days?: number): any;
  getAgentTimeSeries(projectFilter?: string | null, days?: number): any;

  // ── broadcast.ts ──
  broadcastMessage(message: string, streamCallback: any, agentIdFilter?: Set<string> | null): Promise<any[]>;
  handoff(fromId: string, toId: string, context: string, streamCallback: any): Promise<any>;

  // ── actionLogs.ts ──
  addActionLog(agentId: string, type: string, message: string, errorDetail?: string | null): any | null;
  clearActionLogs(agentId: string): boolean;
  _saveExecutionLog(creatorAgentId: string, taskId: string, executorId: string, startMsgIdx: number, startedAt: string, success?: boolean, actionMode?: string): void;

  // ── agentFeatures.ts ──
  addRagDocument(agentId: string, name: string, content: string): any | null;
  deleteRagDocument(agentId: string, docId: string): boolean;
  assignSkill(agentId: string, skillId: string): string[] | null;
  removeSkill(agentId: string, skillId: string): boolean;
  assignMcpServer(agentId: string, serverId: string): string[] | null;
  removeMcpServer(agentId: string, serverId: string): boolean;

  // ── conversation.ts ──
  clearHistory(agentId: string): Promise<boolean>;
  reloadContext(agentId: string): Promise<boolean>;
  truncateHistory(agentId: string, afterIndex: number): any[] | null;
  _switchProjectContext(agent: any, oldProject: string | null, newProject: string | null): void;
  buildVoiceInstructions(agentId: string): string;

  // ── chat.ts ──
  sendMessage(id: string, userMessage: string, streamCallback: any, delegationDepth?: number, messageMeta?: any): Promise<any>;
  _cleanMarkdown(response: string): string;
  _buildSystemPrompt(agent: any, id: string, delegationDepth: number): Promise<string>;
  _assembleMessages(agent: any, messages: any[], systemContent: string, userMessage: string, delegationDepth: number, messageMeta: any, streamCallback: any): Promise<{ managesContext: boolean; isTaskExecution: boolean; activeTaskId: string | null }>;
  _streamAndContinue(agent: any, id: string, messages: any[], llmConfig: any, streamCallback: any, abortController: AbortController, delegationDepth: number, activeTaskId?: string | null): Promise<{ fullResponse: string; thinkingBuffer: string; finishReason: string | null }>;
  _processPostResponseActions(agent: any, id: string, responseForParsing: string, fullResponse: string, streamCallback: any, delegationDepth: number, messageMeta: any): Promise<{ earlyReturn?: any }>;

  // ── tools.ts ──
  _processToolCalls(agentId: string, response: string, streamCallback: any, depth?: number): Promise<any[]>;

  // ── parsing.ts ──
  _parseAskCommands(text: string): Array<{ agentName: string; question: string }>;
  _listAvailableProjects(): Promise<string[]>;

  // ── tasks.ts ──
  addTask(agentId: string, text: string, source: any, initialStatus?: string, options?: { boardId?: string; repoFullName?: string | null; repoProvider?: string | null; storagePath?: string | null; storageProvider?: string | null; skipAutoRefine?: boolean; recurrence?: any; taskType?: string; isManual?: boolean }): any | null;
  toggleTask(agentId: string, taskId: string): any | null;
  setTaskStatus(agentId: string, taskId: string, status: string, options?: { skipAutoRefine?: boolean; by?: string | null }): any | null;
  updateTaskTitle(agentId: string, taskId: string, title: string): any | null;
  updateTaskText(agentId: string, taskId: string, text: string): any | null;
  updateTaskRepo(agentId: string, taskId: string, repoFullName: string | null, repoProvider?: string | null): any | null;
  updateTaskStorage(agentId: string, taskId: string, storagePath: string | null, storageProvider?: string | null): any | null;
  updateTaskType(agentId: string, taskId: string, taskType: string, by?: string): any | null;
  updateTaskRecurrence(agentId: string, taskId: string, recurrence: any): any | null;
  _isActiveTaskStatus(status: string): boolean;
  _getFirstColumnStatus(boardId: string): Promise<string>;
  _findTaskForCommitLink(agentId: string): Promise<{ task: any; ownerAgentId: string } | null>;
  addTaskCommit(agentId: string, taskId: string, hash: string, message: string): any | null;
  removeTaskCommit(agentId: string, taskId: string, hash: string): any | null;
  setTaskAssignee(agentId: string, taskId: string, assigneeId: string): any | null;
  deleteTask(agentId: string, taskId: string): boolean;
  restoreTask(taskId: string): Promise<any | null>;
  hardDeleteTask(taskId: string): Promise<any>;
  getDeletedTasks(): Promise<any[]>;
  clearTasks(agentId: string): boolean;
  transferTask(fromAgentId: string, taskId: string, toAgentId: string): any | null;
  executeTask(agentId: string, taskId: string, streamCallback: any): Promise<{ taskId: string; response: null }>;
  executeAllTasks(agentId: string, streamCallback: any): Promise<any[]>;
  startTaskLoop(intervalMs?: number): void;
  _refreshWorkflowManagedStatuses(): void;
  stopTaskLoop(): void;
  _processRecurringTasks(): Promise<void>;
  _processNextPendingTasks(): void;
  _waitForExecutionComplete(creatorAgentId: string, taskId: string, executorId: string, executorName: string, taskText: string): Promise<string>;
  _resumeActiveTask(agentId: string, agent: any, task: any): Promise<void>;
  getTask(taskId: string): any | null;
  saveTaskDirectly(task: any): any;
  _enqueueAgentTask(agentId: string, taskFn: () => Promise<any>): Promise<any>;
  _ensureTaskInMemory(agentId: string, taskId: string): Promise<boolean>;

  // ── workflow.ts ──
  _evaluateCondition(cond: any, task: any): boolean;
  agentHasActiveTask(agentId: string, excludeTaskId?: string | null): boolean;
  _validTransition(t: any): boolean;
  _columnExists(workflow: any, columnId: string): boolean;
  _checkAutoRefine(task: any, options?: { by?: string | null }): void;
  _recheckConditionalTransitions(): void;

  // ── compaction.ts ──
  _compactionThresholds(contextLimit: number): { maxRecent: number; compactTrigger: number; compactReset: number; safetyRatio: number };
  _estimateTokens(messages: any[]): number;
  _safeMaxTokens(messages: any[], agent: any, llmConfig?: any): number;
  _isContextExceededError(errMsg: string): boolean;
  _parseRateLimitReset(text: string): { retryAt: number; resetLabel: string } | null;
  _truncateMessagesToFit(messages: any[], contextLimit: number, reserveOutputTokens?: number): boolean;
  _compactHistory(agent: any, keepRecent?: number): Promise<void>;
}

/** Active stream snapshot kept in memory so that reconnecting / late-joining
 * sockets can resume rendering the chunks that already flew by. The buffer is
 * capped to avoid unbounded growth on long-running streams. */
export interface ActiveStream {
  agentId: string;
  startedAt: number;
  project: string | null;
  boardId: string | null;
  buffer: string;
  /** The user message that triggered this stream — used by the frontend to
   * verify the optimistic message it rendered is actually the one being
   * processed. */
  userMessage: string | null;
  userMessageId: string | null;
}

export class AgentManager {
  agents: Map<string, any>;
  abortControllers: Map<string, AbortController>;
  _taskQueues: Map<string, Promise<any>>;
  _chatLocks: Map<string, string>;
  _activeStreams: Map<string, ActiveStream>;
  io: any;
  wsEmitter: WsEmitter;
  skillManager: any;
  executionManager: any;
  sandboxManager: any;
  mcpManager: any;
  codeIndexService: any;
  _updateTimers: Map<string, ReturnType<typeof setTimeout>>;
  _updatePending: Map<string, boolean>;
  _conditionProcessing: Map<string, any>;
  llmConfigs: Map<string, any>;
  _tasks: Map<string, any[]>;
  _codeIndexPending: Map<string, Map<string, string | null>>;
  _codeIndexTimers: Map<string, ReturnType<typeof setTimeout>>;
  // Cache fields used in _getLlmConfigsCached
  _llmConfigsCache: any[] | undefined;
  _llmConfigsCacheTime: number | undefined;
  // Task loop fields used in startTaskLoop / stopTaskLoop
  _taskLoopInterval: ReturnType<typeof setInterval> | null | undefined;
  _recurrenceInterval: ReturnType<typeof setInterval> | null | undefined;
  _workflowRefreshInterval: ReturnType<typeof setInterval> | null | undefined;
  _loopProcessing: Set<string> | undefined;
  _taskResumeFailures: Map<string, { count: number; lastFailedAt: number }> | undefined;
  _workflowManagedStatuses: Set<string> | undefined;
  _staleActionCleanupDone: boolean | undefined;

  constructor(io: any, skillManager: any, executionManager: any, mcpManager: any = null, codeIndexService: any = null) {
    this.agents = new Map();
    this.abortControllers = new Map();
    this._taskQueues = new Map();
    this._chatLocks = new Map();
    this._activeStreams = new Map();
    this.io = io;
    this.skillManager = skillManager;
    this.executionManager = executionManager;
    // Backward compatibility alias
    this.sandboxManager = executionManager;
    this.mcpManager = mcpManager;
    this.codeIndexService = codeIndexService;
    this._updateTimers = new Map();
    this._updatePending = new Map();
    this.wsEmitter = new WsEmitter(io, this.agents, this._sanitize.bind(this));
    this._conditionProcessing = new Map();
    this.llmConfigs = new Map();
    /** Centralized task store: Map<agentId, Task[]> — source of truth is the tasks DB table */
    this._tasks = new Map();

    // Debounced code index re-indexation
    this._codeIndexPending = new Map(); // repoId -> Set<filePath>
    this._codeIndexTimers = new Map();  // repoId -> timer
  }

  async loadFromDatabase() {
    try {
      const agents = await getAllAgents();
      for (const agent of agents) {
        agent.status = 'idle';
        agent.currentTask = null;
        agent.currentThinking = '';
        agent.actionLogs = agent.actionLogs || [];
        agent.skills = agent.skills || [];
        agent.mcpServers = agent.mcpServers || [];
        agent.mcpAuth = agent.mcpAuth || {};
        agent.credentials = agent.credentials || {};
        agent.isVoice = agent.isVoice || false;
        agent.voice = agent.voice || 'alloy';
        agent.ttsEnabled = agent.ttsEnabled || false;
        agent.projectContexts = agent.projectContexts || {};
        agent.runnerSessions = agent.runnerSessions || {};
        let needsSave = false;
        if (agent.projectChangedAt === undefined) {
          agent.projectChangedAt = agent.project ? (agent.updatedAt || agent.createdAt || null) : null;
        }
        // Load tasks from the dedicated tasks table into centralized store
        this._tasks.set(agent.id, await getTasksByAgent(agent.id));
        if (agent.mcpServers.includes('mcp-swarm-manager')) {
          agent.mcpServers = agent.mcpServers.filter((id: string) => id !== 'mcp-swarm-manager');
          if (!agent.mcpServers.includes('mcp-pulsarcd-read')) agent.mcpServers.push('mcp-pulsarcd-read');
          if (!agent.mcpServers.includes('mcp-pulsarcd-actions')) agent.mcpServers.push('mcp-pulsarcd-actions');
          needsSave = true;
        }
        if (agent.skills.includes('skill-swarm-devops')) {
          agent.skills = agent.skills.filter((id: string) => id !== 'skill-swarm-devops');
          if (!agent.skills.includes('skill-swarm-reader')) agent.skills.push('skill-swarm-reader');
          if (!agent.skills.includes('skill-swarm-actions')) agent.skills.push('skill-swarm-actions');
          needsSave = true;
        }
        if (needsSave) await saveAgent(agent);
        this.agents.set(agent.id, agent);
      }
      console.log(`📂 Loaded ${agents.length} agents from database`);

      const llmConfigs = await getAllLlmConfigs();
      for (const config of llmConfigs) {
        this.llmConfigs.set(config.id, config);
      }
      console.log(`📂 Loaded ${llmConfigs.length} LLM configurations`);

      // Service restart recovery: stale action_running flag cleanup is deferred
      // to the first task loop tick (see _processNextPendingTasks), so the
      // current environment is known and we don't clear a sibling replica's
      // locks when several deployments share the database.
    } catch (err: any) {
      console.error('Failed to load agents from database:', err.message);
    }
  }

  resolveLlmConfig(agent: any) {
    if (agent.llmConfigId) {
      const config = this.llmConfigs.get(agent.llmConfigId);
      if (config) {
        return {
          provider: config.provider,
          model: config.model,
          endpoint: config.endpoint || agent.endpoint || '',
          apiKey: config.apiKey || agent.apiKey || '',
          isReasoning: config.isReasoning || false,
          temperature: config.temperature ?? null,
          managesContext: config.managesContext || false,
          supportsImages: config.supportsImages || false,
          maxTokens: config.maxOutputTokens || agent.maxTokens || 4096,
          contextLength: config.contextSize || agent.contextLength || 0,
          costPerInputToken: config.costPerInputToken ?? agent.costPerInputToken ?? null,
          costPerOutputToken: config.costPerOutputToken ?? agent.costPerOutputToken ?? null,
          configName: config.name,
        };
      }
      console.warn(`[LLM] Agent ${agent.name} references unknown llmConfigId: ${agent.llmConfigId}, falling back to legacy fields`);
    }
    return {
      provider: agent.provider || '',
      model: agent.model || '',
      endpoint: agent.endpoint || '',
      apiKey: agent.apiKey || '',
      isReasoning: agent.isReasoning || false,
      temperature: agent.temperature ?? null,
      maxTokens: agent.maxTokens || 4096,
      managesContext: false,
      supportsImages: false,
      contextLength: agent.contextLength || 0,
      costPerInputToken: agent.costPerInputToken ?? null,
      costPerOutputToken: agent.costPerOutputToken ?? null,
      configName: null,
    };
  }

  async refreshLlmConfigs() {
    const configs = await getAllLlmConfigs();
    this.llmConfigs.clear();
    for (const config of configs) {
      this.llmConfigs.set(config.id, config);
    }
    for (const agent of this.agents.values()) {
      if (agent.llmConfigId) {
        this._emit('agent:updated', this._sanitize(agent));
      }
    }
  }

  getLlmConfigs() {
    return Array.from(this.llmConfigs.values());
  }

  _recordUsage(agent: any, inputTokens: number, outputTokens: number, contextTokens: number = 0) {
    if (!inputTokens && !outputTokens) return;
    const userId = agent.ownerId || null;
    const resolved = this.resolveLlmConfig(agent);
    const provider = resolved.configName || resolved.provider || 'unknown';
    const model = resolved.model || 'unknown';
    try {
      if (resolved.costPerInputToken != null && resolved.costPerOutputToken != null) {
        const cost = (inputTokens / 1e6) * resolved.costPerInputToken
                   + (outputTokens / 1e6) * resolved.costPerOutputToken;
        recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId, contextTokens);
        return;
      }
      const configs = this._getLlmConfigsCached();
      if (agent.llmConfigId) {
        const cfg = configs.find((c: any) => c.id === agent.llmConfigId);
        if (cfg && (cfg.costPerInputToken != null || cfg.costPerOutputToken != null)) {
          const cost = (inputTokens / 1e6) * (cfg.costPerInputToken || 0)
                     + (outputTokens / 1e6) * (cfg.costPerOutputToken || 0);
          recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId, contextTokens);
          return;
        }
      }
      const cfgByModel = configs.find((c: any) => c.model === model);
      if (cfgByModel && (cfgByModel.costPerInputToken != null || cfgByModel.costPerOutputToken != null)) {
        const cost = (inputTokens / 1e6) * (cfgByModel.costPerInputToken || 0)
                   + (outputTokens / 1e6) * (cfgByModel.costPerOutputToken || 0);
        recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId, contextTokens);
        return;
      }
      const cost = (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15;
      recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId, contextTokens);
    } catch (err: any) {
      console.warn("Failed to record token usage:", err.message);
    }
  }

  _recordUsageDirect(agent: any, inputTokens: number, outputTokens: number, costUsd: number, contextTokens: number = 0) {
    // Record usage with the actual cost reported by the provider (e.g. Claude Paid Plan via coder-service).
    // This bypasses the token-based cost calculation used by _recordUsage.
    const userId = agent.ownerId || null;
    const resolved = this.resolveLlmConfig(agent);
    const provider = resolved.configName || resolved.provider || 'unknown';
    const model = resolved.model || 'unknown';
    try {
      recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, costUsd, userId, contextTokens);
    } catch (err: any) {
      console.warn("Failed to record direct token usage:", err.message);
    }
  }

  _getLlmConfigsCached() {
    if (this._llmConfigsCache && Date.now() - (this._llmConfigsCacheTime as number) < 60000) {
      return this._llmConfigsCache;
    }
    this._llmConfigsCache = this.getLlmConfigs();
    this._llmConfigsCacheTime = Date.now();
    return this._llmConfigsCache;
  }

  // ─── Utility methods ────────────────────────────────────────────────

  _sanitize(agent: any) {
    const { apiKey, mcpAuth, credentials, ...rest } = agent;
    const sanitizedMcpAuth: Record<string, any> = {};
    if (mcpAuth && typeof mcpAuth === 'object') {
      for (const [serverId, conf] of Object.entries(mcpAuth)) {
        sanitizedMcpAuth[serverId] = { hasApiKey: !!(conf as any)?.apiKey };
      }
    }
    const sanitizedCredentials: Record<string, { hasValue: boolean }> = {};
    if (credentials && typeof credentials === 'object') {
      for (const [name, value] of Object.entries(credentials)) {
        sanitizedCredentials[name] = { hasValue: !!value };
      }
    }
    const sanitized: any = { ...rest, hasApiKey: !!apiKey, mcpAuth: sanitizedMcpAuth, credentials: sanitizedCredentials };
    if (agent.llmConfigId) {
      const config = this.llmConfigs.get(agent.llmConfigId);
      if (config) {
        sanitized.provider = config.provider;
        sanitized.model = config.model;
        sanitized.supportsImages = config.supportsImages || false;
      }
    }
    return sanitized;
  }

  _emit(event: string, data: any) {
    this.wsEmitter.emit(event, data);
  }

  _emitToBoard(event: string, data: any) {
    this.wsEmitter.emit(event, data);
  }

  _flushAgentUpdate(agentId: string) {
    this.wsEmitter.flush(agentId);
  }

  // ─── Stream cache: lets reconnecting / late-joining sockets resume ──────
  /** Begin a streaming response for an agent. Tracks an in-memory buffer of
   * chunks so that any socket that joins (or reconnects) while the stream is
   * in flight can resume from where it is via REQ_STREAM_STATE / STREAM_RESUME.
   * Always emits STREAM_START to the agent's board room. */
  beginStream(agentId: string, opts: { userMessage?: string | null; userMessageId?: string | null } = {}) {
    const agent = this.agents.get(agentId);
    const stream: ActiveStream = {
      agentId,
      startedAt: Date.now(),
      project: agent?.project || null,
      boardId: agent?.boardId || null,
      buffer: '',
      userMessage: opts.userMessage ?? null,
      userMessageId: opts.userMessageId ?? null,
    };
    this._activeStreams.set(agentId, stream);
    this.wsEmitter.streamStart(agentId, { startedAt: stream.startedAt, userMessageId: stream.userMessageId });
  }

  /** Append a chunk to the active stream buffer and broadcast it. Safe to
   * call even if no stream was registered (still emits, just doesn't cache). */
  appendStreamChunk(agentId: string, chunk: string) {
    const stream = this._activeStreams.get(agentId);
    if (stream) {
      stream.buffer += chunk;
      // Cap buffer at ~200KB to bound memory. Reconnecting clients then see
      // the tail of the response — better than losing the full state.
      const MAX_BUFFER = 200_000;
      if (stream.buffer.length > MAX_BUFFER) {
        stream.buffer = '…' + stream.buffer.slice(-(MAX_BUFFER - 1));
      }
    }
    this.wsEmitter.streamChunk(agentId, chunk);
  }

  /** Mark the stream as ended, drop the cache, and emit STREAM_END. */
  endStream(agentId: string, extra?: Record<string, any>) {
    this._activeStreams.delete(agentId);
    this.wsEmitter.streamEnd(agentId, extra);
  }

  /** Mark the stream as errored, drop the cache, and emit STREAM_ERROR. */
  errorStream(agentId: string, error: string) {
    this._activeStreams.delete(agentId);
    this.wsEmitter.streamError(agentId, error);
  }

  /** Return the live snapshot (with accumulated buffer) for an agent, or null. */
  getActiveStream(agentId: string): ActiveStream | null {
    return this._activeStreams.get(agentId) || null;
  }

  /** Return active stream snapshots for the agents accessible to a user. */
  getActiveStreamsForUser(userId: string, role: string | null, userBoardIds: Set<string>): ActiveStream[] {
    const accessible = this._agentsForUser(userId, role || undefined, userBoardIds);
    const accessibleIds = new Set(accessible.map((a: any) => a.id));
    const out: ActiveStream[] = [];
    for (const [id, stream] of this._activeStreams) {
      if (accessibleIds.has(id)) out.push(stream);
    }
    return out;
  }

  // ─── Task store helpers (replace agent.todoList) ─────────────────────
  /** Get all tasks for an agent */
  _getAgentTasks(agentId: string) {
    return this._tasks.get(agentId) || [];
  }

  /** Find a single task by predicate across all agents. Returns { task, agentId } or null */
  _findTaskAcross(predicate: (task: any) => boolean) {
    for (const [agentId, tasks] of this._tasks) {
      const task = tasks.find(predicate);
      if (task) return { task, agentId };
    }
    return null;
  }

  /** Get all tasks from all agents as a flat array (each task has agentId) */
  _getAllTasks() {
    const all: any[] = [];
    for (const [agentId, tasks] of this._tasks) {
      for (const t of tasks) all.push({ ...t, agentId });
    }
    return all;
  }

  /** Add a task to the in-memory store for an agent */
  _addTaskToStore(agentId: string, task: any) {
    if (!this._tasks.has(agentId)) this._tasks.set(agentId, []);
    this._tasks.get(agentId)!.push(task);
  }

  /** Remove a task from the in-memory store */
  _removeTaskFromStore(agentId: string, taskId: string) {
    const tasks = this._tasks.get(agentId);
    if (!tasks) return;
    this._tasks.set(agentId, tasks.filter((t: any) => t.id !== taskId));
  }

  /** Clear all tasks for an agent from the in-memory store */
  _clearAgentTasks(agentId: string) {
    this._tasks.set(agentId, []);
  }

  /**
   * Ensure a task is loaded in the in-memory `_tasks` store for the given agent.
   * Falls back to the DB if missing, and rehydrates the store under the task's
   * actual `agent_id` (which may differ from the requested `agentId`).
   * Returns true iff after this call the task is present in `_tasks.get(agentId)`.
   *
   * Why: in-memory `_tasks` is populated at startup via `getTasksByAgent` and
   * mutated by addTask/_addTaskToStore. Any drift (orphaned agent_id, manual
   * DB edit, missed in-memory insert) leaves PATCH/DELETE routes 404'ing on
   * tasks that exist in the DB. This helper is the recovery path.
   */
  async _ensureTaskInMemory(agentId: string, taskId: string): Promise<boolean> {
    const tasks = this._tasks.get(agentId) || [];
    if (tasks.some((t: any) => t.id === taskId)) return true;
    const dbTask = await getTaskById(taskId);
    if (!dbTask) return false;
    const ownerId = dbTask.agentId;
    if (ownerId) {
      if (!this._tasks.has(ownerId)) this._tasks.set(ownerId, []);
      const ownerTasks = this._tasks.get(ownerId)!;
      if (!ownerTasks.some((t: any) => t.id === taskId)) {
        ownerTasks.push(dbTask);
        console.warn(`[AgentManager] Rehydrated task ${taskId} into memory under agent ${ownerId} (requested via ${agentId})`);
      }
    }
    return ownerId === agentId;
  }

  _randomColor() {
    const colors = [
      '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
      '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  /**
   * Schedule a debounced code index update for a modified file.
   * Groups multiple rapid modifications (< 3s) into a single re-index operation.
   * @param {string} projectName - The project containing the modified file
   * @param {string} relativePath - File path relative to project root
   * @param {string} [content] - The new file content (avoids re-reading from disk)
   */
  scheduleCodeIndexUpdate(projectName: string, relativePath: string, content?: string) {
    if (!this.codeIndexService || !projectName || !relativePath) return;

    const key = projectName.toLowerCase();
    if (!this._codeIndexPending.has(key)) {
      this._codeIndexPending.set(key, new Map());
    }
    this._codeIndexPending.get(key)!.set(relativePath, content ?? null);

    // Clear existing timer for this project (debounce)
    if (this._codeIndexTimers.has(key)) {
      clearTimeout(this._codeIndexTimers.get(key)!);
    }

    // Set new timer — flush after 3 seconds of inactivity
    const timer = setTimeout(() => {
      this._codeIndexTimers.delete(key);
      this._flushCodeIndexUpdate(key);
    }, 3000);
    this._codeIndexTimers.set(key, timer);
  }

  async _flushCodeIndexUpdate(projectKey: string) {
    const pendingFiles = this._codeIndexPending.get(projectKey);
    this._codeIndexPending.delete(projectKey);
    if (!pendingFiles || pendingFiles.size === 0 || !this.codeIndexService) return;

    try {
      const repos = await this.codeIndexService.findReposByProject(projectKey);
      if (repos.length === 0) {
        console.log(`📇 [CodeIndex] No indexed repo found for project "${projectKey}" — skipping update`);
        return;
      }

      const fileEntries = Array.from(pendingFiles.entries()).map(([filePath, content]) => ({
        path: filePath,
        ...(content !== null ? { content } : {}),
      }));

      for (const repo of repos) {
        const result = await this.codeIndexService.updateFiles(repo.id, fileEntries);
        console.log(`📇 [CodeIndex] Updated index "${repo.name}" (${repo.id}): +${result.added} ~${result.updated} -${result.removed} files`);
      }
    } catch (err: any) {
      console.error(`📇 [CodeIndex] Failed to update index for "${projectKey}":`, err.message);
    }
  }

  static formatDuration(ms: number | null | undefined) {
    if (!ms || ms < 0) return 'n/a';
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    if (hours < 24) return `${hours}h ${remainingMinutes}m`;
    const days = Math.floor(hours / 24);
    const remainingHours = hours % 24;
    return `${days}d ${remainingHours}h`;
  }
}

// ─── Apply mixins to prototype ───────────────────────────────────────
Object.assign(AgentManager.prototype, lifecycleMethods);
Object.assign(AgentManager.prototype, chatMethods);
Object.assign(AgentManager.prototype, toolsMethods);
Object.assign(AgentManager.prototype, parsingMethods);
Object.assign(AgentManager.prototype, tasksMethods);
Object.assign(AgentManager.prototype, workflowMethods);
Object.assign(AgentManager.prototype, compactionMethods);
