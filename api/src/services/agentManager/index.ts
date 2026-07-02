// ─── AgentManager: class shell + constructor + mixin assembly ─────────────────
import { getAllAgents, setAgentOwner, setAgentBoard, getAllLlmConfigs, recordTokenUsage, getTaskByIdPrefix } from '../database.js';
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
  createBatch(config: any, size: number): Promise<any[]>;
  convertToBatch(id: string, size: number): Promise<any[] | null>;
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
  _tasksByAgentMap(): Promise<Map<string, any[]>>;
  _buildAgentStatus(agent: any, todoList: any[]): any;
  getAgentStatus(id: string): Promise<any | null>;
  getAllStatuses(userId?: string | null, role?: string | null, userBoardIds?: Set<string>): Promise<any[]>;
  getAgentsByProject(projectName: string, userId?: string | null, role?: string | null, userBoardIds?: Set<string>): Promise<any[]>;
  getProjectSummary(userId?: string | null, role?: string | null, userBoardIds?: Set<string>): any;
  getSwarmStatus(userId?: string | null, role?: string | null, userBoardIds?: Set<string>): Promise<any>;
  setStatus(id: string, status: string, detail?: string | null): void;
  _markTaskStopped(t: any, ownerAgentId: string | null, stopTimestamp: string): void;
  _haltAgentTasks(id: string, stopTimestamp: string): Promise<void>;
  stopAgent(id: string): boolean;
  beginStream(agentId: string, opts?: { userMessage?: string | null; userMessageId?: string | null }): void;
  appendStreamChunk(agentId: string, chunk: string): void;
  endStream(agentId: string, extra?: Record<string, any>): void;
  errorStream(agentId: string, error: string): void;
  getActiveStream(agentId: string): ActiveStream | null;
  getActiveStreamsForUser(userId: string, role: string | null, userBoardIds: Set<string>): ActiveStream[];

  // ── taskStats.ts ──
  _collectTasks(projectFilter?: string | null, allowedBoardIds?: Set<string> | null): Promise<any[]>;
  getTaskStats(projectFilter?: string | null, allowedBoardIds?: Set<string> | null): Promise<any>;
  getTaskTimeSeries(projectFilter?: string | null, days?: number, allowedBoardIds?: Set<string> | null): Promise<any>;
  getAgentTimeSeries(projectFilter?: string | null, days?: number, allowedBoardIds?: Set<string> | null): Promise<any>;

  // ── broadcast.ts ──
  broadcastMessage(message: string, streamCallback: any, agentIdFilter?: Set<string> | null): Promise<any[]>;
  handoff(fromId: string, toId: string, context: string, streamCallback: any): Promise<any>;

  // ── actionLogs.ts ──
  addActionLog(agentId: string, type: string, message: string, errorDetail?: string | null): Promise<any | null>;
  clearActionLogs(agentId: string): boolean;
  _saveExecutionLog(creatorAgentId: string, taskId: string, executorId: string, startMsgIdx: number, startedAt: string, success?: boolean, actionMode?: string): Promise<void>;

  // ── agentFeatures.ts ──
  addRagDocument(agentId: string, name: string, content: string): any | null;
  deleteRagDocument(agentId: string, docId: string): boolean;
  assignSkill(agentId: string, skillId: string): string[] | null;
  removeSkill(agentId: string, skillId: string): boolean;

  // ── conversation.ts ──
  _teardownRuntimeConnections(agentId: string, agent: any, logTag: string): Promise<boolean>;
  clearHistory(agentId: string): Promise<boolean>;
  reloadContext(agentId: string): Promise<boolean>;
  restartRuntime(agentId: string): Promise<boolean>;
  truncateHistory(agentId: string, afterIndex: number): any[] | null;
  _switchProjectContext(agent: any, oldProject: string | null, newProject: string | null): void;
  buildVoiceInstructions(agentId: string): Promise<string>;

  // ── chat.ts ──
  _releaseChat(id: string, isTopLevel: boolean, status?: 'idle' | null): void;
  _failChat(agent: any, id: string, isTopLevel: boolean, errMessage: string, finalStatus?: 'error' | 'idle'): void;
  sendMessage(id: string, userMessage: string, streamCallback: any, delegationDepth?: number, messageMeta?: any): Promise<any>;
  _cleanMarkdown(response: string): string;
  _buildSystemPrompt(agent: any, id: string, delegationDepth: number): Promise<string>;
  buildRunnerInstructions(id: string): Promise<string>;
  _assembleMessages(agent: any, messages: any[], systemContent: string, userMessage: string, delegationDepth: number, messageMeta: any, streamCallback: any): Promise<{ managesContext: boolean; isTaskExecution: boolean; activeTaskId: string | null }>;
  _consumeStream(provider: any, messages: any[], ctx: { agent: any; id: string; useCliRunner: boolean; streamCallback: any; abortController: AbortController; contextTokens: number; activeTaskId: string | null; sessionKey: string; runnerSessionId: string | undefined; maxTokens: number; llmConfig: any; isContinuation: boolean }): Promise<{ text: string; thinking: string; finishReason: string | null; outputTokens: number }>;
  _streamAndContinue(agent: any, id: string, messages: any[], llmConfig: any, streamCallback: any, abortController: AbortController, delegationDepth: number, activeTaskId?: string | null): Promise<{ fullResponse: string; thinkingBuffer: string; finishReason: string | null }>;
  _processPostResponseActions(agent: any, id: string, responseForParsing: string, fullResponse: string, streamCallback: any, delegationDepth: number, messageMeta: any): Promise<{ earlyReturn?: any }>;

  // ── tools.ts ──
  recordTaskCompletion(agentId: string, args?: { comment?: string; explicitTaskId?: string; commitsArg?: string; streamCallback?: any }): Promise<{ success: boolean; result: string; isTerminal?: boolean; taskId?: string }>;
  _processToolCalls(agentId: string, response: string, streamCallback: any, depth?: number): Promise<any[]>;

  // ── parsing.ts ──
  _parseAskCommands(text: string): Array<{ agentName: string; question: string }>;
  _listAvailableProjects(): Promise<string[]>;

  // ── tasks.ts ──
  addTask(agentId: string | null, text: string, source: any, initialStatus?: string, options?: { boardId?: string; repoFullName?: string | null; repoProvider?: string | null; secondaryRepos?: any; storagePath?: string | null; storageProvider?: string | null; skipAutoRefine?: boolean; recurrence?: any; taskType?: string; isManual?: boolean; environment?: string | null }): Promise<any | null>;
  toggleTask(agentId: string, taskId: string): Promise<any | null>;
  setTaskStatus(agentId: string, taskId: string, status: string, options?: { skipAutoRefine?: boolean; by?: string | null }): Promise<any | null>;
  _editTaskField(agentId: string, taskId: string, field: string, value: any, options?: { by?: string; applyExtra?: (task: any) => void }): Promise<any | null>;
  updateTaskTitle(agentId: string, taskId: string, title: string): Promise<any | null>;
  updateTaskText(agentId: string, taskId: string, text: string): Promise<any | null>;
  updateTaskRepo(agentId: string, taskId: string, repoFullName: string | null, repoProvider?: string | null): Promise<any | null>;
  updateTaskSecondaryRepos(agentId: string, taskId: string, secondaryRepos: any): Promise<any | null>;
  updateTaskStorage(agentId: string, taskId: string, storagePath: string | null, storageProvider?: string | null): Promise<any | null>;
  updateTaskType(agentId: string, taskId: string, taskType: string, by?: string): Promise<any | null>;
  updateTaskRecurrence(agentId: string, taskId: string, recurrence: any): Promise<any | null>;
  _isActiveTaskStatus(status: string): boolean;
  _getFirstColumnStatus(boardId: string): Promise<string>;
  _findTaskForCommitLink(agentId: string): Promise<{ task: any; ownerAgentId: string } | null>;
  addTaskCommit(agentId: string, taskId: string, hash: string, message: string): Promise<any | null>;
  removeTaskCommit(agentId: string, taskId: string, hash: string): Promise<any | null>;
  setTaskAssignee(agentId: string, taskId: string, assigneeId: string): Promise<any | null>;
  deleteTask(agentId: string | null, taskId: string): Promise<boolean>;
  restoreTask(taskId: string): Promise<any | null>;
  hardDeleteTask(taskId: string): Promise<any>;
  getDeletedTasks(): Promise<any[]>;
  clearTasks(agentId: string): boolean;
  transferTask(fromAgentId: string, taskId: string, toAgentId: string): Promise<any | null>;
  executeTask(agentId: string, taskId: string, streamCallback: any): Promise<{ taskId: string; response: null }>;
  executeAllTasks(agentId: string, streamCallback: any): Promise<any[]>;
  startTaskLoop(intervalMs?: number): void;
  _refreshWorkflowManagedStatuses(): void;
  stopTaskLoop(): void;
  _processRecurringTasks(): Promise<void>;
  _processNextPendingTasks(): void;
  _waitForExecutionComplete(creatorAgentId: string, taskId: string, executorId: string, executorName: string, taskText: string, options?: any): Promise<string>;
  _resumeActiveTask(agentId: string, agent: any, task: any): Promise<void>;
  getTask(taskId: string): Promise<any | null>;
  saveTaskDirectly(task: any): any;
  _enqueueAgentTask(agentId: string, taskFn: () => Promise<any>): Promise<any>;
  _resolveTaskRef(idOrPrefix: string): Promise<{ task: any; agentId: string | null } | null>;

  // ── workflow.ts ──
  _evaluateCondition(cond: any, task: any): boolean;
  agentHasActiveTask(agentId: string, excludeTaskId?: string | null): Promise<boolean>;
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
  mcpManager: any;
  codeIndexService: any;
  _updateTimers: Map<string, ReturnType<typeof setTimeout>>;
  _updatePending: Map<string, boolean>;
  _conditionProcessing: Map<string, any>;
  _onEnterRetry: Map<string, { ts: number; count: number }>;
  /** Consecutive "decide produced no decision" attempts, keyed by taskId.
   * Relocated off the task object (Phase 2 of the task-store DB refactor) so the
   * fail-fast guard works for board-level tasks too — they have no in-memory
   * task object to hang the counter on, so it never accumulated. Replica-local
   * and transient: a retry counter that is fine to lose on restart. Purged in
   * _processNextPendingTasks alongside the task signals. */
  _decideNoDecisionCounts: Map<string, number>;
  llmConfigs: Map<string, any>;
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
  _reassigningStatuses: Set<string> | undefined;
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
    this.mcpManager = mcpManager;
    this.codeIndexService = codeIndexService;
    this._updateTimers = new Map();
    this._updatePending = new Map();
    this.wsEmitter = new WsEmitter(io, this.agents, this._sanitize.bind(this));
    this._conditionProcessing = new Map();
    this._decideNoDecisionCounts = new Map();
    this.llmConfigs = new Map();

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
        if (agent.projectChangedAt === undefined) {
          agent.projectChangedAt = agent.project ? (agent.updatedAt || agent.createdAt || null) : null;
        }
        // Tasks are no longer cached in memory — the DB is the single source of
        // truth and every reader/mutator goes through the task accessors directly.
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
          endpoint: config.endpoint || '',
          apiKey: config.apiKey || '',
          isReasoning: config.isReasoning || false,
          temperature: config.temperature ?? null,
          managesContext: config.managesContext || false,
          supportsImages: config.supportsImages || false,
          maxTokens: config.maxOutputTokens || agent.maxTokens || 4096,
          contextLength: config.contextSize || 0,
          costPerInputToken: config.costPerInputToken ?? null,
          costPerOutputToken: config.costPerOutputToken ?? null,
          configName: config.name,
        };
      }
      console.warn(`[LLM] Agent ${agent.name} references unknown llmConfigId: ${agent.llmConfigId} — using an empty config`);
    }
    return {
      provider: '',
      model: '',
      endpoint: '',
      apiKey: '',
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
    const { mcpAuth, credentials, ...rest } = agent;
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
    const sanitized: any = { ...rest, mcpAuth: sanitizedMcpAuth, credentials: sanitizedCredentials };
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

  /**
   * DB-backed resolution of a task by id or unique id prefix. Returns
   * `{ task, agentId }` (agentId is the task's OWNER — null for board-level
   * tasks created unassigned via MCP add_task / external API) or null. The DB
   * is the single source of truth, so this is a thin wrapper over the
   * prefix-capable accessor, resolving tasks regardless of owner.
   */
  async _resolveTaskRef(idOrPrefix: string): Promise<{ task: any; agentId: string | null } | null> {
    const dbTask = await getTaskByIdPrefix(idOrPrefix);
    if (!dbTask) return null;
    return { task: dbTask, agentId: dbTask.agentId ?? null };
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
