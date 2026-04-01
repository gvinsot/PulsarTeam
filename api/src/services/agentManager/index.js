// ─── AgentManager: class shell + constructor + mixin assembly ─────────────────
import { getAllAgents, saveAgent, setAgentOwner, getAllLlmConfigs, recordTokenUsage, getTasksByAgent } from '../database.js';

import { lifecycleMethods } from './lifecycle.js';
import { chatMethods } from './chat.js';
import { toolsMethods } from './tools.js';
import { parsingMethods } from './parsing.js';
import { tasksMethods } from './tasks.js';
import { workflowMethods } from './workflow.js';
import { compactionMethods } from './compaction.js';

export class AgentManager {
  constructor(io, skillManager, sandboxManager, mcpManager = null) {
    this.agents = new Map();
    this.abortControllers = new Map();
    this._taskQueues = new Map();
    this._chatLocks = new Map();
    this.io = io;
    this.skillManager = skillManager;
    this.sandboxManager = sandboxManager;
    this.mcpManager = mcpManager;
    this._updateTimers = new Map();
    this._updatePending = new Map();
    this._conditionProcessing = new Map();
    this.llmConfigs = new Map();

    // ─── Agent execution locking ─────────────────────────────────────
    // Maps agentId → { taskId, creatorAgentId, lockedAt }
    // An agent can only execute one task at a time.
    this._agentExecLocks = new Map();
    // Maps agentId → Array<{ task, resolve, reject }> — pending tasks waiting for the agent
    this._agentPendingQueues = new Map();
    // Timeout for stuck agent locks (15 minutes)
    this.AGENT_LOCK_TIMEOUT_MS = 15 * 60 * 1000;
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
        agent.isVoice = agent.isVoice || false;
        agent.voice = agent.voice || 'alloy';
        agent.projectContexts = agent.projectContexts || {};
        let needsSave = false;
        if (agent.projectChangedAt === undefined) {
          agent.projectChangedAt = agent.project ? (agent.updatedAt || agent.createdAt || null) : null;
        }
        // Load tasks from the dedicated tasks table
        agent.todoList = await getTasksByAgent(agent.id);
        if (agent.mcpServers.includes('mcp-swarm-manager')) {
          agent.mcpServers = agent.mcpServers.filter(id => id !== 'mcp-swarm-manager');
          if (!agent.mcpServers.includes('mcp-pulsarcd-read')) agent.mcpServers.push('mcp-pulsarcd-read');
          if (!agent.mcpServers.includes('mcp-pulsarcd-actions')) agent.mcpServers.push('mcp-pulsarcd-actions');
          needsSave = true;
        }
        if (agent.skills.includes('skill-swarm-devops')) {
          agent.skills = agent.skills.filter(id => id !== 'skill-swarm-devops');
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
    } catch (err) {
      console.error('Failed to load agents from database:', err.message);
    }
  }

  resolveLlmConfig(agent) {
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

  _recordUsage(agent, inputTokens, outputTokens) {
    if (!inputTokens && !outputTokens) return;
    const userId = agent.ownerId || null;
    const resolved = this.resolveLlmConfig(agent);
    const provider = resolved.configName || resolved.provider || 'unknown';
    const model = resolved.model || 'unknown';
    try {
      if (resolved.costPerInputToken != null && resolved.costPerOutputToken != null) {
        const cost = (inputTokens / 1e6) * resolved.costPerInputToken
                   + (outputTokens / 1e6) * resolved.costPerOutputToken;
        recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId);
        return;
      }
      const configs = this._getLlmConfigsCached();
      if (agent.llmConfigId) {
        const cfg = configs.find(c => c.id === agent.llmConfigId);
        if (cfg && (cfg.costPerInputToken != null || cfg.costPerOutputToken != null)) {
          const cost = (inputTokens / 1e6) * (cfg.costPerInputToken || 0)
                     + (outputTokens / 1e6) * (cfg.costPerOutputToken || 0);
          recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId);
          return;
        }
      }
      const cfgByModel = configs.find(c => c.model === model);
      if (cfgByModel && (cfgByModel.costPerInputToken != null || cfgByModel.costPerOutputToken != null)) {
        const cost = (inputTokens / 1e6) * (cfgByModel.costPerInputToken || 0)
                   + (outputTokens / 1e6) * (cfgByModel.costPerOutputToken || 0);
        recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId);
        return;
      }
      const cost = (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15;
      recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, cost, userId);
    } catch (err) {
      console.warn("Failed to record token usage:", err.message);
    }
  }

  _recordUsageDirect(agent, inputTokens, outputTokens, costUsd) {
    // Record usage with the actual cost reported by the provider (e.g. Claude Paid Plan via coder-service).
    // This bypasses the token-based cost calculation used by _recordUsage.
    const userId = agent.ownerId || null;
    const resolved = this.resolveLlmConfig(agent);
    const provider = resolved.configName || resolved.provider || 'unknown';
    const model = resolved.model || 'unknown';
    try {
      recordTokenUsage(agent.id, agent.name, provider, model, inputTokens, outputTokens, costUsd, userId);
    } catch (err) {
      console.warn("Failed to record direct token usage:", err.message);
    }
  }

  _getLlmConfigsCached() {
    if (this._llmConfigsCache && Date.now() - this._llmConfigsCacheTime < 60000) {
      return this._llmConfigsCache;
    }
    this._llmConfigsCache = this.getLlmConfigs();
    this._llmConfigsCacheTime = Date.now();
    return this._llmConfigsCache;
  }

  // ─── Agent Execution Locking ─────────────────────────────────────────
  // Ensures an agent can only execute one task at a time.
  // Returns true if the lock was acquired, false if the agent is already busy.

  acquireAgentLock(agentId, taskId, creatorAgentId) {
    this._evictStaleAgentLocks();
    const existing = this._agentExecLocks.get(agentId);
    if (existing) {
      console.log(`[AgentLock] CONFLICT: agent "${agentId}" already locked by task "${existing.taskId}" (locked ${Math.round((Date.now() - existing.lockedAt) / 1000)}s ago) — rejecting task "${taskId}"`);
      return false;
    }
    this._agentExecLocks.set(agentId, {
      taskId,
      creatorAgentId,
      lockedAt: Date.now(),
    });
    const agent = this.agents.get(agentId);
    console.log(`[AgentLock] Acquired: agent "${agent?.name || agentId}" locked for task "${taskId}"`);
    return true;
  }

  releaseAgentLock(agentId, taskId = null) {
    const existing = this._agentExecLocks.get(agentId);
    if (!existing) return;
    // If taskId is specified, only release if it matches (prevents accidental release)
    if (taskId && existing.taskId !== taskId) {
      console.log(`[AgentLock] Skip release: agent "${agentId}" locked by task "${existing.taskId}", not "${taskId}"`);
      return;
    }
    this._agentExecLocks.delete(agentId);
    const agent = this.agents.get(agentId);
    console.log(`[AgentLock] Released: agent "${agent?.name || agentId}" (was locked for task "${existing.taskId}")`);
    // Process next queued task for this agent
    this._processAgentQueue(agentId);
  }

  isAgentLocked(agentId) {
    this._evictStaleAgentLocks();
    return this._agentExecLocks.has(agentId);
  }

  getAgentLockInfo(agentId) {
    this._evictStaleAgentLocks();
    return this._agentExecLocks.get(agentId) || null;
  }

  _evictStaleAgentLocks() {
    const now = Date.now();
    for (const [agentId, lock] of this._agentExecLocks) {
      if (now - lock.lockedAt > this.AGENT_LOCK_TIMEOUT_MS) {
        const agent = this.agents.get(agentId);
        console.warn(`[AgentLock] TIMEOUT: evicting stale lock for agent "${agent?.name || agentId}" task "${lock.taskId}" (age: ${Math.round((now - lock.lockedAt) / 1000)}s)`);
        this._agentExecLocks.delete(agentId);
        this._processAgentQueue(agentId);
      }
    }
  }

  // ─── Agent Task Queue ──────────────────────────────────────────────
  // When an agent is busy, tasks are queued and processed in order.

  enqueueForAgent(agentId, taskInfo) {
    if (!this._agentPendingQueues.has(agentId)) {
      this._agentPendingQueues.set(agentId, []);
    }
    const queue = this._agentPendingQueues.get(agentId);
    // Avoid duplicate entries for the same task
    if (queue.some(q => q.task.id === taskInfo.task.id)) {
      console.log(`[AgentQueue] Task "${taskInfo.task.id}" already in queue for agent "${agentId}" — skipping`);
      return;
    }
    queue.push(taskInfo);
    const agent = this.agents.get(agentId);
    console.log(`[AgentQueue] Enqueued task "${taskInfo.task.text?.slice(0, 60)}" for agent "${agent?.name || agentId}" (queue size: ${queue.length})`);
  }

  _processAgentQueue(agentId) {
    const queue = this._agentPendingQueues.get(agentId);
    if (!queue || queue.length === 0) return;

    const agent = this.agents.get(agentId);
    if (!agent || agent.enabled === false) {
      // Agent disabled — clear queue
      this._agentPendingQueues.delete(agentId);
      return;
    }

    const next = queue.shift();
    if (queue.length === 0) {
      this._agentPendingQueues.delete(agentId);
    }

    console.log(`[AgentQueue] Dequeuing next task "${next.task.text?.slice(0, 60)}" for agent "${agent.name}" (remaining: ${queue?.length || 0})`);

    // Re-trigger the transition for the queued task
    if (next.retrigger) {
      // Use setImmediate to avoid deep call stacks
      setImmediate(() => next.retrigger());
    }
  }

  getAgentQueueLength(agentId) {
    return this._agentPendingQueues.get(agentId)?.length || 0;
  }

  getAgentAvailability() {
    const result = [];
    for (const [agentId, agent] of this.agents) {
      if (agent.enabled === false) continue;
      const lockInfo = this._agentExecLocks.get(agentId);
      const queueLength = this.getAgentQueueLength(agentId);
      result.push({
        id: agentId,
        name: agent.name,
        role: agent.role || 'general',
        status: agent.status,
        project: agent.project || null,
        locked: !!lockInfo,
        currentTaskId: lockInfo?.taskId || null,
        lockedSince: lockInfo?.lockedAt ? new Date(lockInfo.lockedAt).toISOString() : null,
        lockDurationMs: lockInfo ? Date.now() - lockInfo.lockedAt : null,
        queuedTasks: queueLength,
        available: !lockInfo && agent.status === 'idle',
      });
    }
    return result;
  }

  // ─── Utility methods ────────────────────────────────────────────────

  _sanitize(agent) {
    const { apiKey, mcpAuth, ...rest } = agent;
    const sanitizedMcpAuth = {};
    if (mcpAuth && typeof mcpAuth === 'object') {
      for (const [serverId, conf] of Object.entries(mcpAuth)) {
        sanitizedMcpAuth[serverId] = { hasApiKey: !!conf?.apiKey };
      }
    }
    const sanitized = { ...rest, hasApiKey: !!apiKey, mcpAuth: sanitizedMcpAuth };
    if (agent.llmConfigId) {
      const config = this.llmConfigs.get(agent.llmConfigId);
      if (config) {
        sanitized.provider = config.provider;
        sanitized.model = config.model;
      }
    }
    return sanitized;
  }

  _emit(event, data) {
    if (!this.io) return;

    if (event === 'agent:updated' && data?.id) {
      const agentId = data.id;
      this._updatePending.set(agentId, data);
      if (this._updateTimers.has(agentId)) return;

      const timer = setTimeout(() => {
        this._updateTimers.delete(agentId);
        const pendingData = this._updatePending.get(agentId);
        this._updatePending.delete(agentId);
        if (pendingData) {
          this._emitToOwner(event, pendingData);
        }
      }, 300);
      this._updateTimers.set(agentId, timer);
      return;
    }

    if ((event === 'agent:created' || event === 'agent:deleted') && data?.ownerId) {
      this.io.to(`user:${data.ownerId}`).emit(event, data);
      return;
    }

    const agentId = data?.id || data?.agentId;
    if (agentId) {
      const agent = this.agents.get(agentId);
      if (agent?.ownerId) {
        this.io.to(`user:${agent.ownerId}`).emit(event, data);
        return;
      }
    }

    this.io.emit(event, data);
  }

  _emitToOwner(event, data) {
    if (!this.io) return;
    const ownerId = data?.ownerId;
    if (ownerId) {
      this.io.to(`user:${ownerId}`).emit(event, data);
    } else {
      this.io.emit(event, data);
    }
  }

  _flushAgentUpdate(agentId) {
    const timer = this._updateTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this._updateTimers.delete(agentId);
    }
    const pendingData = this._updatePending.get(agentId);
    this._updatePending.delete(agentId);
    if (pendingData && this.io) {
      this._emitToOwner('agent:updated', pendingData);
    }
  }

  _randomColor() {
    const colors = [
      '#6366f1', '#8b5cf6', '#ec4899', '#ef4444', '#f97316',
      '#eab308', '#22c55e', '#14b8a6', '#06b6d4', '#3b82f6'
    ];
    return colors[Math.floor(Math.random() * colors.length)];
  }

  static formatDuration(ms) {
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
