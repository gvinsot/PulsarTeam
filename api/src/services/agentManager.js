import { v4 as uuidv4 } from 'uuid';
import { createProvider, createLoggingProvider } from './llmProviders.js';
import { getAllAgents, saveAgent, deleteAgentFromDb, recordTokenUsage, getSetting, setAgentOwner, getAllLlmConfigs, getLlmConfig } from './database.js';
import { TOOL_DEFINITIONS, parseToolCalls, executeTool } from './agentTools.js';
import { listStarredRepos, getProjectGitUrl } from './githubProjects.js';
import { processTransition } from './transitionProcessor.js';
import { getWorkflow, getWorkflowForBoard, getAllBoardWorkflows } from './configManager.js';
import { onTaskStatusChanged } from './jiraSync.js';
import fs from 'fs/promises';
import path from 'path';

// ─── File System Handoff ────────────────────────────────────────────────────────
async function transferUserFiles(fromId, toId) {
  const tempDir = path.join('/tmp', `handoff-${uuidv4()}`);
  const fromHomeDir = `/home/${fromId}`;
  const toHomeDir = `/home/${toId}`;

  try {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.cp(fromHomeDir, tempDir, { recursive: true });
    await fs.chmod(tempDir, 0o755);
    await fs.rename(tempDir, toHomeDir);
    return { success: true, message: 'File system handoff completed successfully' };
  } catch (error) {
    console.error('File system handoff failed:', error);
    try { await fs.rm(tempDir, { recursive: true, force: true }); } catch {}
    return { success: false, message: error.message };
  }
}

// ─── MCP Schema Simplification ──────────────────────────────────────────────
// Convert JSON Schema properties to a simple {"param": "type"} format for LLM prompts
function _simplifyMcpSchema(inputSchema) {
  if (!inputSchema?.properties) return '{}';
  const props = inputSchema.properties;
  const required = new Set(inputSchema.required || []);
  const simplified = {};

  for (const [key, def] of Object.entries(props)) {
    let typeStr = '';
    // Handle anyOf (e.g. nullable types)
    if (def.anyOf) {
      const types = def.anyOf.map(t => t.type).filter(Boolean);
      typeStr = types.join('|');
    } else {
      typeStr = def.type || 'string';
    }
    // Add default value info
    if (def.default !== undefined && def.default !== null) {
      typeStr += `, default: ${def.default}`;
    } else if (def.default === null) {
      typeStr += ', optional';
    }
    // Mark required
    if (required.has(key)) {
      typeStr += ', required';
    }
    simplified[key] = `<${typeStr}>`;
  }
  return JSON.stringify(simplified);
}

export class AgentManager {
  constructor(io, skillManager, sandboxManager, mcpManager = null) {
    this.agents = new Map();
    this.abortControllers = new Map(); // Track ongoing requests by agentId
    this._taskQueues = new Map();       // Per-agent sequential task queue
    this._chatLocks = new Map();        // Per-agent lock: agentId → current message being processed
    this.io = io;
    this.skillManager = skillManager;
    this.sandboxManager = sandboxManager;
    this.mcpManager = mcpManager;
    // Throttle state for agent:updated emissions (per agentId)
    this._updateTimers = new Map();   // agentId → setTimeout handle
    this._updatePending = new Map();  // agentId → latest data to emit
    // TTL-based lock map for condition re-check deduplication (lockKey → timestamp)
    this._conditionProcessing = new Map();
    // LLM configs cache (id → config)
    this.llmConfigs = new Map();
  }

  async loadFromDatabase() {
    try {
      const agents = await getAllAgents();
      for (const agent of agents) {
        // Reset runtime state
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
        // Migration: initialize projectChangedAt for existing agents
        if (agent.projectChangedAt === undefined) {
          agent.projectChangedAt = agent.project ? (agent.updatedAt || agent.createdAt || null) : null;
        }
        // Migration: done boolean → status string
        if (agent.todoList) {
          for (const task of agent.todoList) {
            if (task.status === undefined) {
              task.status = task.done ? 'done' : 'pending';
              delete task.done;
            }
            // Reset in_progress tasks to pending on server restart
            if (task.status === 'in_progress') {
              task.status = 'pending';
            }
          }
        }
        // Migration: mcp-swarm-manager → mcp-pulsarcd-read + mcp-pulsarcd-actions
        if (agent.mcpServers.includes('mcp-swarm-manager')) {
          agent.mcpServers = agent.mcpServers.filter(id => id !== 'mcp-swarm-manager');
          if (!agent.mcpServers.includes('mcp-pulsarcd-read')) agent.mcpServers.push('mcp-pulsarcd-read');
          if (!agent.mcpServers.includes('mcp-pulsarcd-actions')) agent.mcpServers.push('mcp-pulsarcd-actions');
          needsSave = true;
        }
        // Migration: skill-swarm-devops → skill-swarm-reader + skill-swarm-actions
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

      // Load LLM configs
      const llmConfigs = await getAllLlmConfigs();
      for (const config of llmConfigs) {
        this.llmConfigs.set(config.id, config);
      }
      console.log(`📂 Loaded ${llmConfigs.length} LLM configurations`);
    } catch (err) {
      console.error('Failed to load agents from database:', err.message);
    }
  }

  /**
   * Resolve LLM provider/model/endpoint/apiKey for an agent.
   * If the agent has a llmConfigId, look up the LLM config.
   * Otherwise fall back to legacy agent.provider/agent.model fields.
   */
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
    // Legacy: provider/model stored directly on agent
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
    // Emit agent:updated for all agents referencing an LLM config so cards refresh
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
    try {
      // 1) Agent-level explicit costs
      if (agent.costPerInputToken != null && agent.costPerOutputToken != null) {
        const cost = (inputTokens / 1e6) * agent.costPerInputToken
                   + (outputTokens / 1e6) * agent.costPerOutputToken;
        recordTokenUsage(agent.id, agent.name, agent.provider, agent.model, inputTokens, outputTokens, cost, userId);
        return;
      }
      // 2) LLM config by llmConfigId
      const configs = this._getLlmConfigsCached();
      if (agent.llmConfigId) {
        const cfg = configs.find(c => c.id === agent.llmConfigId);
        if (cfg && (cfg.inputCostPer1M != null || cfg.outputCostPer1M != null)) {
          const cost = (inputTokens / 1e6) * (cfg.inputCostPer1M || 0)
                     + (outputTokens / 1e6) * (cfg.outputCostPer1M || 0);
          recordTokenUsage(agent.id, agent.name, agent.provider, agent.model, inputTokens, outputTokens, cost, userId);
          return;
        }
      }
      // 3) LLM config by model name match
      const cfgByModel = configs.find(c => c.model === agent.model);
      if (cfgByModel && (cfgByModel.inputCostPer1M != null || cfgByModel.outputCostPer1M != null)) {
        const cost = (inputTokens / 1e6) * (cfgByModel.inputCostPer1M || 0)
                   + (outputTokens / 1e6) * (cfgByModel.outputCostPer1M || 0);
        recordTokenUsage(agent.id, agent.name, agent.provider, agent.model, inputTokens, outputTokens, cost, userId);
        return;
      }
      // 4) Fallback: hardcoded defaults
      const cost = (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15;
      recordTokenUsage(agent.id, agent.name, agent.provider, agent.model, inputTokens, outputTokens, cost, userId);
    } catch (err) {
      console.warn("Failed to record token usage:", err.message);
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

  async create(config) {
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
      todoList: config.todoList || [],
      ragDocuments: config.ragDocuments || [],
      skills: config.skills || [],
      mcpServers: config.mcpServers || [],
      conversationHistory: [],
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
      color: config.color || this._randomColor(),
      icon: config.icon || '🤖',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.agents.set(id, agent);
    await saveAgent(agent); // Persist to database
    if (config.ownerId) {
      await setAgentOwner(id, config.ownerId);
    }
    this._emit('agent:created', this._sanitize(agent));
    return this._sanitize(agent);
  }

  getAll() {
    return Array.from(this.agents.values()).map(a => this._sanitize(a));
  }

  getAllForUser(userId, role) {
    return Array.from(this.agents.values())
      .filter(a => a.ownerId === userId || !a.ownerId)
      .map(a => this._sanitize(a));
  }

  /** Return raw agent objects visible to a user (own + unowned) */
  _agentsForUser(userId, role) {
    return Array.from(this.agents.values())
      .filter(a => a.ownerId === userId || !a.ownerId);
  }

  getById(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._sanitize(agent);
  }

  getLastMessages(agentId, limit = 1) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const parsedLimit = Number(limit);
    const safeLimit = Number.isFinite(parsedLimit) ? Math.max(1, Math.min(50, parsedLimit)) : 1;
    const history = Array.isArray(agent.conversationHistory) ? agent.conversationHistory : [];
    const startIndex = Math.max(0, history.length - safeLimit);

    const messages = history.slice(-safeLimit).map((m, idx) => ({
      index: startIndex + idx,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp || null,
      type: m.type || null
    }));

    return {
      agentId: agent.id,
      agentName: agent.name,
      project: agent.project || null,
      status: agent.status,
      totalMessages: history.length,
      returned: messages.length,
      limit: safeLimit,
      messages
    };
  }

  getLastMessagesByName(agentName, limit = 1) {
    if (!agentName) return null;
    const target = Array.from(this.agents.values()).find(
      a => (a.name || '').toLowerCase() === String(agentName).toLowerCase()
    );
    if (!target) return null;
    return this.getLastMessages(target.id, limit);
  }

  /**
   * Get comprehensive status of a single agent including project info.
   * Used by REST API and leader tools for detailed agent inspection.
   */
  getAgentStatus(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const todoList = agent.todoList || [];
    const pendingTasks = todoList.filter(t => t.status === 'pending').length;
    const inProgressTasks = todoList.filter(t => t.status === 'in_progress').length;
    const doneTasks = todoList.filter(t => t.status === 'done').length;
    const errorTasks = todoList.filter(t => t.status === 'error').length;
    const totalTasks = todoList.length;
    const msgCount = (agent.conversationHistory || []).length;
    const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(agent.id) : false;

    // Extract current in-progress task description from todoList
    const currentTaskEntry = todoList.find(t => t.status === 'in_progress');
    const currentTask = agent.currentTask || (currentTaskEntry ? currentTaskEntry.text : null);

    // Collect active (in-progress + pending) task descriptions for visibility
    const activeTasks = todoList
      .filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error')
      .map(t => ({ id: t.id, text: t.text, status: t.status, startedAt: t.startedAt || null }));

    // Calculate how long the agent has been on the current project
    let projectDurationMs = null;
    if (agent.project && agent.projectChangedAt) {
      projectDurationMs = Date.now() - new Date(agent.projectChangedAt).getTime();
    }

    return {
      id: agent.id,
      name: agent.name,
      status: agent.status,
      role: agent.role || 'worker',
      description: agent.description || '',
      project: agent.project || null,
      projectChangedAt: agent.projectChangedAt || null,
      projectDurationMs,
      currentTask: currentTask,
      activeTasks,
      provider: agent.provider || null,
      model: agent.model || null,
      enabled: agent.enabled !== false,
      isLeader: agent.isLeader || false,
      sandbox: hasSandbox ? 'running' : 'not running',
      tasks: {
        pending: pendingTasks,
        inProgress: inProgressTasks,
        done: doneTasks,
        error: errorTasks,
        total: totalTasks
      },
      messages: msgCount,
      metrics: {
        totalMessages: agent.metrics?.totalMessages || 0,
        totalTokensIn: agent.metrics?.totalTokensIn || 0,
        totalTokensOut: agent.metrics?.totalTokensOut || 0,
        lastActiveAt: agent.metrics?.lastActiveAt || null,
        errors: agent.metrics?.errors || 0
      },
      createdAt: agent.createdAt || null,
      updatedAt: agent.updatedAt || null
    };
  }

  /**
   * Get lightweight status for ALL agents (including project info).
   * Unlike getAll() which returns full agent data (heavy), this returns
   * only the essential status fields for each agent — ideal for dashboards,
   * management tools, and leader queries that need a quick overview.
   */
  getAllStatuses(userId = null, role = null) {
    const agents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    return agents
      .filter(a => a.enabled !== false)
      .map(a => this.getAgentStatus(a.id))
      .filter(Boolean);
  }

  /**
   * Get lightweight statuses for agents assigned to a specific project.
   * Used by REST API for project-filtered queries.

      // Set repo-level git config as fallback (in case global config is not found)
      await this._execInSandbox(agentId, `cd ${cloneDir} && git config user.name "${gitName}" && git config user.email "${gitEmail}"`);
      if (gitToken) {
        await this._execInSandbox(agentId, `cd ${cloneDir} && git config url."https://${gitToken}@github.com/".insteadOf "https://github.com/"`);
      }
   */
  getAgentsByProject(projectName, userId = null, role = null) {
    if (!projectName) return [];
    const agents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    return agents
      .filter(a => a.enabled !== false && (a.project || '').toLowerCase() === projectName.toLowerCase())
      .map(a => this.getAgentStatus(a.id))
      .filter(Boolean);
  }

  /**
   * Get a high-level summary of all projects and their agent assignments.
   * Useful for management dashboards and leader tools that need to quickly
   * see how agents are distributed across projects.
   */
  getProjectSummary(userId = null, role = null) {
    const agents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    const enabled = agents.filter(a => a.enabled !== false);
    const projectMap = {};
    const unassigned = [];

    for (const agent of enabled) {
      if (agent.project) {
        if (!projectMap[agent.project]) {
          projectMap[agent.project] = { agents: [], busy: 0, idle: 0, error: 0, total: 0 };
        }
        const entry = projectMap[agent.project];
        entry.total++;
        if (agent.status === 'busy') entry.busy++;
        else if (agent.status === 'error') entry.error++;
        else entry.idle++;
        entry.agents.push({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          role: agent.role || 'worker',
          currentTask: agent.currentTask || null
        });
      } else {
        unassigned.push({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          role: agent.role || 'worker',
          currentTask: agent.currentTask || null
        });
      }
    }

    return {
      projects: Object.entries(projectMap).map(([name, data]) => ({
        name,
        ...data
      })),
      unassigned,
      totalAgents: enabled.length,
      totalProjects: Object.keys(projectMap).length
    };
  }

  /**
   * Collect all tasks across all agents, optionally filtered by project.
   */
  _collectTasks(projectFilter = null) {
    const tasks = [];
    for (const agent of this.agents.values()) {
      if (!agent.todoList) continue;
      for (const t of agent.todoList) {
        const proj = t.project || agent.project || null;
        if (projectFilter && proj !== projectFilter) continue;
        tasks.push({ ...t, _agentId: agent.id, _project: proj });
      }
    }
    return tasks;
  }

  /**
   * Compute task statistics from agent todoLists.
   */
  getTaskStats(projectFilter = null) {
    const tasks = this._collectTasks(projectFilter);
    const total = tasks.length;
    const byType = {};
    const byStatus = {};
    const resolutionTimes = [];
    const resolutionByType = {};
    const stateDurations = {};

    for (const t of tasks) {
      const typ = t.taskType || 'untyped';
      byType[typ] = (byType[typ] || 0) + 1;
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;

      if (t.status === 'done' && t.history?.length) {
        const doneEntry = [...t.history].reverse().find(h => h.status === 'done' || h.to === 'done');
        if (doneEntry) {
          const created = new Date(t.createdAt).getTime();
          const resolved = new Date(doneEntry.at).getTime();
          const resMs = resolved - created;
          if (resMs > 0) {
            resolutionTimes.push(resMs);
            if (!resolutionByType[typ]) resolutionByType[typ] = [];
            resolutionByType[typ].push(resMs);
          }
        }
      }

      if (t.history?.length > 1) {
        for (let i = 0; i < t.history.length - 1; i++) {
          const state = t.history[i].status || t.history[i].to;
          const enterTime = new Date(t.history[i].at).getTime();
          const exitTime = new Date(t.history[i + 1].at).getTime();
          const dur = exitTime - enterTime;
          if (dur > 0 && state) {
            if (!stateDurations[state]) stateDurations[state] = [];
            stateDurations[state].push(dur);
          }
        }
      }
    }

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const median = arr => {
      if (!arr.length) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    };

    const avgStateDurations = {};
    for (const [state, durations] of Object.entries(stateDurations)) {
      avgStateDurations[state] = {
        avg: Math.round(avg(durations)),
        median: Math.round(median(durations)),
        count: durations.length,
      };
    }

    const resolutionByTypeStats = {};
    for (const [typ, arr] of Object.entries(resolutionByType)) {
      resolutionByTypeStats[typ] = { count: arr.length, avg: Math.round(avg(arr)), median: Math.round(median(arr)) };
    }

    return {
      total,
      byType,
      byStatus,
      resolution: {
        count: resolutionTimes.length,
        avg: Math.round(avg(resolutionTimes)),
        median: Math.round(median(resolutionTimes)),
      },
      resolutionByType: resolutionByTypeStats,
      avgStateDurations,
    };
  }

  /**
   * Compute time series data from agent todoLists.
   */
  getTaskTimeSeries(projectFilter = null, days = 30) {
    const tasks = this._collectTasks(projectFilter);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const toDay = (iso) => iso ? new Date(iso).toISOString().slice(0, 10) : null;

    const createdByDay = {};
    const resolvedByDay = {};
    const resolutionTimesByDay = {};

    for (const t of tasks) {
      const createdDay = toDay(t.createdAt);
      if (createdDay && new Date(t.createdAt) >= cutoff) {
        createdByDay[createdDay] = (createdByDay[createdDay] || 0) + 1;
      }

      if (t.history?.length) {
        for (const h of t.history) {
          const target = h.status || h.to;
          if (target === 'done' && h.at && new Date(h.at) >= cutoff) {
            const resolvedDay = toDay(h.at);
            resolvedByDay[resolvedDay] = (resolvedByDay[resolvedDay] || 0) + 1;
            const created = new Date(t.createdAt).getTime();
            const resolved = new Date(h.at).getTime();
            const resMs = resolved - created;
            if (resMs > 0) {
              if (!resolutionTimesByDay[resolvedDay]) resolutionTimesByDay[resolvedDay] = [];
              resolutionTimesByDay[resolvedDay].push(resMs);
            }
            break;
          }
        }
      }
    }

    const allDays = [];
    for (let d = new Date(cutoff); d <= now; d.setDate(d.getDate() + 1)) {
      allDays.push(d.toISOString().slice(0, 10));
    }

    const avg = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

    const createdVsResolved = allDays.map(day => ({
      date: day,
      created: createdByDay[day] || 0,
      resolved: resolvedByDay[day] || 0,
    }));

    const resolutionTimeEvolution = allDays
      .filter(day => resolutionTimesByDay[day]?.length > 0)
      .map(day => ({
        date: day,
        avgMs: Math.round(avg(resolutionTimesByDay[day])),
        count: resolutionTimesByDay[day].length,
      }));

    let cumOpen = 0;
    for (const t of tasks) {
      if (new Date(t.createdAt) < cutoff && t.status !== 'done') cumOpen++;
      if (new Date(t.createdAt) < cutoff && t.status === 'done') {
        const doneEntry = t.history?.find(h => (h.status || h.to) === 'done');
        if (doneEntry && new Date(doneEntry.at) >= cutoff) cumOpen++;
      }
    }
    const openOverTime = createdVsResolved.map(d => {
      cumOpen += d.created - d.resolved;
      return { date: d.date, open: Math.max(0, cumOpen) };
    });

    return { createdVsResolved, resolutionTimeEvolution, openOverTime };
  }

  /**
   * Get comprehensive swarm status: all agents with their current project assignments.
   * Used by REST API and @swarm_status() leader command.
   */
  getSwarmStatus(userId = null, role = null) {
    const allAgents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    const enabled = allAgents.filter(a => a.enabled !== false);
    const disabled = allAgents.filter(a => a.enabled === false);

    // Group agents by project
    const projectMap = {};
    const unassigned = [];
    for (const agent of enabled) {
      const status = this.getAgentStatus(agent.id);
      if (agent.project) {
        if (!projectMap[agent.project]) projectMap[agent.project] = [];
        projectMap[agent.project].push(status);
      } else {
        unassigned.push(status);
      }
    }

    // Build per-project summary with busy/idle counts and per-agent task details
    const projectSummaries = {};
    for (const [project, agents] of Object.entries(projectMap)) {
      projectSummaries[project] = {
        total: agents.length,
        busy: agents.filter(a => a.status === 'busy').length,
        idle: agents.filter(a => a.status === 'idle').length,
        error: agents.filter(a => a.status === 'error').length,
        agents: agents.map(a => ({
          name: a.name,
          status: a.status,
          role: a.role,
          currentTask: a.currentTask || null,
          activeTasks: (a.activeTasks || []).length,
          projectChangedAt: a.projectChangedAt || null
        }))
      };
    }

    return {
      summary: {
        total: allAgents.length,
        enabled: enabled.length,
        disabled: disabled.length,
        busy: enabled.filter(a => a.status === 'busy').length,
        idle: enabled.filter(a => a.status === 'idle').length,
        error: enabled.filter(a => a.status === 'error').length,
        withProject: enabled.filter(a => a.project).length,
        withoutProject: enabled.filter(a => !a.project).length,
        activeProjects: Object.keys(projectMap)
      },
      projectSummaries,
      projectAssignments: projectMap,
      unassignedAgents: unassigned,
      agents: enabled.map(a => this.getAgentStatus(a.id))
    };
  }

  async update(id, updates) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const allowed = [
      'name', 'role', 'description', 'instructions', 'temperature',
      'maxTokens', 'contextLength', 'todoList', 'ragDocuments', 'skills', 'mcpServers', 'mcpAuth', 'handoffTargets',
      'color', 'icon', 'provider', 'model', 'endpoint', 'apiKey', 'project', 'isLeader', 'isVoice', 'isReasoning', 'voice', 'enabled',
      'costPerInputToken', 'costPerOutputToken', 'llmConfigId', 'ownerId'
    ];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        // Don't overwrite existing apiKey with empty string
        if (key === 'apiKey' && !updates[key] && agent[key]) continue;
        // Ownership change — also update DB column
        if (key === 'ownerId' && updates[key] !== agent[key]) {
          agent[key] = updates[key];
          setAgentOwner(agent.id, updates[key]);
          continue;
        }
        // MCP auth: merge per-server keys, remove entries with empty apiKey
        if (key === 'mcpAuth') {
          if (!agent.mcpAuth) agent.mcpAuth = {};
          for (const [serverId, conf] of Object.entries(updates.mcpAuth || {})) {
            if (conf?.apiKey) {
              agent.mcpAuth[serverId] = { apiKey: conf.apiKey };
            } else {
              // Empty apiKey → remove per-agent override (fall back to global)
              delete agent.mcpAuth[serverId];
            }
          }
          // Disconnect stale per-agent connections so they reconnect with new auth
          if (this.mcpManager) {
            this.mcpManager.disconnectAgent(id).catch(() => {});
          }
          continue;
        }
        // Context switching when project changes
        if (key === 'project' && updates[key] !== agent[key]) {
          this._switchProjectContext(agent, agent.project, updates[key]);
          agent.projectChangedAt = updates[key] ? new Date().toISOString() : null;
        }
        agent[key] = updates[key];
      }
    }
    agent.updatedAt = new Date().toISOString();

    await saveAgent(agent); // Persist to database
    this._emit('agent:updated', this._sanitize(agent));
    return this._sanitize(agent);
  }

  async delete(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;
    // Destroy sandbox container
    const ownerId = this.agents.get(id)?.ownerId || null;
    if (this.sandboxManager) {
      this.sandboxManager.destroySandbox(id).catch(err => {
        console.error(`Failed to destroy sandbox for agent ${id}:`, err.message);
      });
    }
    // Disconnect per-agent MCP connections
    if (this.mcpManager) {
      this.mcpManager.disconnectAgent(id).catch(err => {
        console.error(`Failed to disconnect MCP for agent ${id}:`, err.message);
      });
    }
    this.agents.delete(id);
    await deleteAgentFromDb(id); // Remove from database
    this._emit('agent:deleted', { id, ownerId });
    return true;
  }

  async updateAllProjects(project, agentIdFilter = null) {
    const updated = [];
    for (const agent of this.agents.values()) {
      if (agentIdFilter && !agentIdFilter.has(agent.id)) continue;
      if (project !== agent.project) {
        this._switchProjectContext(agent, agent.project, project);
        agent.projectChangedAt = project ? new Date().toISOString() : null;
      }
      agent.project = project;
      agent.updatedAt = new Date().toISOString();
      await saveAgent(agent);
      updated.push(this._sanitize(agent));
      this._emit('agent:updated', this._sanitize(agent));
    }
    return updated;
  }

  setStatus(id, status, detail = null) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const prev = agent.status;
    agent.status = status;

    // Clear currentTask when agent goes idle or errors out
    if (status === 'idle' || status === 'error') {
      agent.currentTask = null;
    }

    this._emit('agent:status', {
      id,
      name: agent.name,
      status,
      role: agent.role || 'worker',
      project: agent.project || null,
      currentTask: agent.currentTask || null,
      isLeader: agent.isLeader || false
    });

    // Flush any pending throttled agent:updated when reaching a terminal state
    // so the client gets the final state immediately
    if (status === 'idle' || status === 'error') {
      this._flushAgentUpdate(id);
    }

    // Log meaningful status transitions
    if (status === 'busy' && prev !== 'busy') {
      this.addActionLog(id, 'busy', detail || 'Agent started working');
    } else if (status === 'idle' && prev !== 'idle') {
      this.addActionLog(id, 'idle', detail || 'Agent finished working');
      // Agent became idle — re-check conditional transitions that might depend on agent status
      this._recheckConditionalTransitions();
    } else if (status === 'error') {
      this.addActionLog(id, 'error', 'Agent encountered an error', detail);
      // Agent errored — re-check conditional transitions so tasks waiting on
      // this agent's status are re-evaluated (e.g. to reassign or unblock)
      this._recheckConditionalTransitions();
    }
  }

  // ─── Stop Agent ─────────────────────────────────────────────────────
  stopAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;

    // Abort any in-progress request
    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    // Clear the task queue so pending delegations don't start
    this._taskQueues.delete(id);

    // If this is a leader, also stop all other busy agents (delegated work)
    if (agent.isLeader) {
      for (const [subId, subAgent] of this.agents) {
        if (subId !== id && subAgent.status === 'busy') {
          const subCtrl = this.abortControllers.get(subId);
          if (subCtrl) {
            subCtrl.abort();
            this.abortControllers.delete(subId);
          }
          this._taskQueues.delete(subId);
          subAgent.currentThinking = '';
          subAgent.currentTask = null;
          this._chatLocks.delete(subId);
          this.setStatus(subId, 'idle', 'Stopped by leader');
          saveAgent(subAgent);
          this._emit('agent:stopped', { id: subId, name: subAgent.name, project: subAgent.project || null });
        }
      }
    }

    // Mark any in_progress task as stopped so the reminder loop won't restart it
    if (agent.todoList) {
      for (const t of agent.todoList) {
        if (t.status === 'in_progress') {
          t._executionStopped = true;
        }
      }
    }

    // Clear actionRunning flag on any task executed by this agent (across all creators)
    // so the UI immediately reflects the stop
    for (const [, creatorAgent] of this.agents) {
      if (!creatorAgent.todoList) continue;
      for (const t of creatorAgent.todoList) {
        if (t.actionRunning && t.actionRunningAgentId === id) {
          t.actionRunning = false;
          delete t.actionRunningAgentId;
          saveAgent(creatorAgent);
          this.io?.to(`agent:${creatorAgent.id}`)?.emit('task:updated', { agentId: creatorAgent.id, task: t });
        }
      }
    }

    // Reset agent state
    agent.currentThinking = '';
    agent.currentTask = null;
    this._chatLocks.delete(id); // Release lock immediately so new messages can be sent right away
    this.setStatus(id, 'idle', 'Agent stopped by user');
    saveAgent(agent);

    console.log(`🛑 Agent ${agent.name} stopped`);
    this._emit('agent:stopped', { id, name: agent.name, project: agent.project || null });
    return true;
  }

  // ─── Chat ───────────────────────────────────────────────────────────
  async sendMessage(id, userMessage, streamCallback, delegationDepth = 0, messageMeta = null) {
    // Prevent duplicate concurrent top-level chat for the same agent
    const isTopLevel = delegationDepth === 0 && !messageMeta;
    if (isTopLevel) {
      if (this._chatLocks.has(id)) {
        const agent = this.agents.get(id);
        const lockedMessage = this._chatLocks.get(id);
        // Stale lock: agent is no longer busy — clear it and proceed
        if (!agent || agent.status !== 'busy') {
          console.warn(`⚠️ Stale chat lock for agent ${id} (status: ${agent?.status}) — auto-clearing`);
          this._chatLocks.delete(id);
        } else if (lockedMessage === userMessage) {
          // Same message already being processed — silently ignore the duplicate
          return null;
        } else {
          // Different message while genuinely busy — reject
          throw new Error('Agent is already processing a message');
        }
      }
      this._chatLocks.set(id, userMessage);
    }

    // Create abort controller for this request
    const abortController = new AbortController();
    this.abortControllers.set(id, abortController);

    const agent = this.agents.get(id);
    if (!agent) {
      if (isTopLevel) this._chatLocks.delete(id);
      throw new Error('Agent not found');
    }

    this.setStatus(id, 'busy');
    agent.currentThinking = '';

    // Track the current task for status reporting
    if (messageMeta?.type === 'delegation-task') {
      agent.currentTask = (userMessage || '').replace(/^\[TASK from [^\]]+\]:\s*/i, '').slice(0, 200) || null;
    } else if (delegationDepth === 0 && !messageMeta) {
      agent.currentTask = (userMessage || '').slice(0, 200) || null;
    }
    this._emit('agent:status', { id, status: 'busy', project: agent.project || null, currentTask: agent.currentTask || null });

    // Early sandbox init so file tree is available for prompt injection
    if (this.sandboxManager && agent.project && !this.sandboxManager.getFileTree(id)) {
      try {
        const gitUrl = await getProjectGitUrl(agent.project);
        if (gitUrl) {
          await this.sandboxManager.ensureSandbox(id, agent.project, gitUrl);
          // Wait briefly for tree generation to complete (it was triggered in ensureSandbox)
          if (!this.sandboxManager.getFileTree(id)) {
            await this.sandboxManager.refreshFileTree(id);
          }
        }
      } catch (err) {
        // Non-blocking: tree will be available on next message
        console.warn(`⚠️  [Sandbox] Early init for file tree failed: ${err.message}`);
      }
    }

    // Build messages array
    const messages = [];
    const systemContent = await this._buildSystemPrompt(agent, id, delegationDepth);
    messages.push({ role: 'system', content: systemContent });

    // Assemble messages with compaction
    const { managesContext } = await this._assembleMessages(agent, messages, systemContent, userMessage, delegationDepth, messageMeta, streamCallback);

    // Store user message (with optional metadata for tool/delegation results)
    const historyEntry = {
      role: 'user',
      content: userMessage,
      timestamp: new Date().toISOString()
    };
    if (messageMeta) {
      historyEntry.type = messageMeta.type;
      if (messageMeta.toolResults) historyEntry.toolResults = messageMeta.toolResults;
      if (messageMeta.delegationResults) historyEntry.delegationResults = messageMeta.delegationResults;
      if (messageMeta.fromAgent) historyEntry.fromAgent = messageMeta.fromAgent;
    }
    agent.conversationHistory.push(historyEntry);

    let fullResponse = '';

    try {
      // Stream LLM response with auto-continuation
      const llmConfig = this.resolveLlmConfig(agent);
      const streamResult = await this._streamAndContinue(agent, id, messages, llmConfig, streamCallback, abortController, delegationDepth);
      fullResponse = streamResult.fullResponse;
      const { delegationPromises, detectedCount } = streamResult;

      // Store assistant message
      agent.conversationHistory.push({
        role: 'assistant',
        content: fullResponse,
        timestamp: new Date().toISOString()
      });

      agent.metrics.totalMessages += 1;
      agent.metrics.lastActiveAt = new Date().toISOString();
      agent.currentThinking = '';
      saveAgent(agent); // Persist conversation and metrics

      // Process post-response actions (tool calls, delegations, leader commands, rate limits)
      const responseForParsing = this._cleanMarkdown(fullResponse);
      const actionResult = await this._processPostResponseActions(agent, id, responseForParsing, fullResponse, streamCallback, delegationDepth, messageMeta, delegationPromises, detectedCount);
      if (actionResult.earlyReturn !== null) {
        this.setStatus(id, 'idle');
        return actionResult.earlyReturn;
      }

      this.setStatus(id, 'idle');
      this.abortControllers.delete(id); // Clean up abort controller
      if (isTopLevel) this._chatLocks.delete(id);
      return fullResponse;
    } catch (err) {
      // ── Rate limit: mark task as error and schedule retry ──
      if (err.isRateLimit) {
        const delayMs = Math.max(0, err.retryAt - Date.now());
        console.log(`🕐 [Rate Limit] "${agent.name}": ${err.message} — retry in ${Math.round(delayMs / 60000)}min`);
        if (streamCallback) streamCallback(`\n⏸️ *${err.message}. Task will auto-retry at ${err.resetLabel} + 5min.*\n`);
        this.addActionLog(id, 'error', `Rate limit reached — resets at ${err.resetLabel}`, err.message);

        // Find the in_progress task for this agent and mark it as error
        const inProgressTask = agent.todoList?.find(t => t.status === 'in_progress');
        if (inProgressTask) {
          // Set the error message BEFORE changing status so it's persisted in the same save
          inProgressTask.error = `Rate limit reached — resets at ${err.resetLabel}`;
          this.setTaskStatus(id, inProgressTask.id, 'error', { skipAutoRefine: true, by: 'rate-limit' });
          console.log(`🕐 [Rate Limit] Task "${inProgressTask.text.slice(0, 60)}" set to error`);
        }

        // Schedule re-check after reset time + 5min
        setTimeout(() => {
          console.log(`🕐 [Rate Limit] Retry timer fired for "${agent.name}" — triggering re-check`);
          this._recheckConditionalTransitions();
        }, delayMs);

        // Don't let the error propagate further — we've handled it
        this.setStatus(id, 'idle');
        this.abortControllers.delete(id);
        if (isTopLevel) this._chatLocks.delete(id);
        return fullResponse;
      }

      // ── Reactive compaction: context exceeded → compact and retry once ──
      if (this._isContextExceededError(err.message) && !agent._compactionRetried && !managesContext) {
        console.log(`🗜️  [Reactive Compact] "${agent.name}": context exceeded — compacting and retrying`);
        agent._compactionRetried = true;  // Prevent infinite retry loop
        this.addActionLog(id, 'warning', 'Context limit exceeded — compacting conversation and retrying');
        // Release the chat lock BEFORE recursive retry so it can re-acquire it
        if (isTopLevel) this._chatLocks.delete(id);
        try {
          if (streamCallback) streamCallback(`\n⚠️ *Context limit exceeded — compacting conversation and retrying...*\n`);
          const reactiveCtxLimit = agent.contextLength || 8192;
          const reactiveKeep = Math.max(6, Math.floor(this._compactionThresholds(reactiveCtxLimit).maxRecent * 0.5));
          await this._compactHistory(agent, reactiveKeep);
          agent._compactionArmed = false;
          // Retry the same message (it's already in conversationHistory, so remove the last entry to avoid duplication)
          agent.conversationHistory.pop();
          const retryResult = await this.sendMessage(id, userMessage, streamCallback, delegationDepth, messageMeta);
          delete agent._compactionRetried;
          return retryResult;
        } catch (retryErr) {
          delete agent._compactionRetried;
          // Retry also failed — fall through to normal error handling
          console.error(`🗜️  [Reactive Compact] "${agent.name}": retry after compaction also failed: ${retryErr.message}`);
          this.abortControllers.delete(id);
          agent.metrics.errors += 1;
          agent.currentThinking = '';
          this.setStatus(id, 'error', retryErr.message);
          saveAgent(agent);
          if (isTopLevel) this._chatLocks.delete(id);
          throw retryErr;
        }
      }

      // ── Transient stream error → retry with backoff ──
      // Covers: network drops, LLM stream timeouts, server-side 5xx, idle timeouts.
      // Do NOT retry on: user abort, context exceeded (handled above), auth errors.
      const isUserStop = err.message === 'Agent stopped by user';
      const isAuthError = err.status === 401 || err.status === 403;
      const isTransient = !isUserStop && !isAuthError && !err.isRateLimit && !this._isContextExceededError(err.message);
      const MAX_STREAM_RETRIES = 3;
      const retryCount = agent._streamRetryCount || 0;

      if (isTransient && retryCount < MAX_STREAM_RETRIES && !abortController.signal.aborted) {
        agent._streamRetryCount = retryCount + 1;
        const delay = 2000 * Math.pow(2, retryCount); // 2s, 4s, 8s
        console.log(`🔄 [Stream Retry] "${agent.name}": ${err.message} — retry ${retryCount + 1}/${MAX_STREAM_RETRIES} in ${delay}ms`);
        this.addActionLog(id, 'warning', `Connection lost, retrying (${retryCount + 1}/${MAX_STREAM_RETRIES})`, err.message);
        if (streamCallback) streamCallback(`\n⚠️ *Connection lost, retrying (${retryCount + 1}/${MAX_STREAM_RETRIES})...*\n`);
        await new Promise(r => setTimeout(r, delay));
        // Remove the user message we already pushed to avoid duplication
        agent.conversationHistory.pop();
        // Release the chat lock BEFORE recursive retry so it can re-acquire it
        if (isTopLevel) this._chatLocks.delete(id);
        try {
          const retryResult = await this.sendMessage(id, userMessage, streamCallback, delegationDepth, messageMeta);
          delete agent._streamRetryCount;
          return retryResult;
        } catch (retryErr) {
          delete agent._streamRetryCount;
          this.abortControllers.delete(id);
          agent.metrics.errors += 1;
          agent.currentThinking = '';
          const isRetryUserStop = retryErr.message === 'Agent stopped by user';
          this.setStatus(id, isRetryUserStop ? 'idle' : 'error', retryErr.message);
          saveAgent(agent);
          if (isTopLevel) this._chatLocks.delete(id);
          throw retryErr;
        }
      }
      delete agent._streamRetryCount;

      this.abortControllers.delete(id); // Clean up abort controller
      agent.metrics.errors += 1;
      agent.currentThinking = '';
      this.setStatus(id, isUserStop ? 'idle' : 'error', err.message);
      saveAgent(agent); // Persist error count
      if (isTopLevel) this._chatLocks.delete(id);
      throw err;
    }
  }

  /**
   * Strip <think>...</think> blocks (including unclosed ones) and trim whitespace.
   */
  _cleanMarkdown(response) {
    return (response || '').replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
  }

  /**
   * Build the full system prompt for an agent, including plugins, MCP tools, project context, etc.
   * Returns the systemContent string.
   */
  async _buildSystemPrompt(agent, id, delegationDepth) {
    let systemContent = `Your name is "${agent.name}".${agent.role ? ` Your role: ${agent.role}.` : ''}\n\n${agent.instructions || 'You are a helpful AI assistant.'}`;

    // For leader agents, inject available agents context (only at top level to avoid confusion)
    if (agent.isLeader && delegationDepth === 0) {
      const availableAgents = Array.from(this.agents.values())
        .filter(a => a.id !== id && a.enabled !== false) // Exclude self and disabled agents
        .map(a => {
          const statusTag = ` [${a.status}]`;
          const projectTag = a.project ? ` [project: ${a.project}]` : ' [no project]';
          const taskInfo = a.currentTask ? ` (working on: "${a.currentTask.slice(0, 60)}${a.currentTask.length > 60 ? '...' : ''}")` : '';
          return `- ${a.name} (${a.role})${statusTag}${projectTag}${taskInfo}: ${a.description || 'No description'}`;
        });

      if (availableAgents.length > 0) {
        systemContent += `\n\n--- Available Swarm Agents ---\nYou can delegate tasks to these agents using the format: @delegate(AgentName, "task description")\n${availableAgents.join('\n')}\n\nWhen you need an agent to work on something, use the @delegate command. The agent's response will be provided back to you.\n\nIMPORTANT: Agents may report errors using @report_error(). When you receive delegation results containing errors, analyze the problem and decide whether to retry the task, reassign it to another agent, provide additional guidance, or escalate to the user.`;
      } else {
        systemContent += `\n\n--- Available Swarm Agents ---\nNo other agents are currently available in the swarm. You will need to complete tasks yourself or ask the user to create specialist agents.`;
      }

      // Inject leader management tools and available projects
      const projectNames = await this._listAvailableProjects();
      systemContent += `\n\n--- Agent Management Tools ---`;
      systemContent += `\nYou have the following management commands available:`;
      systemContent += `\n- @assign_project(AgentName, "project_name") — Assign an agent to a project. This sets their working directory so they can use file and command tools. When an agent's project changes, their conversation context is automatically saved and restored per-project.`;
      systemContent += `\n- @get_project(AgentName) — Check which project an agent is currently assigned to.`;
      systemContent += `\n- @clear_context(AgentName) — Clear an agent's entire conversation history, giving them a fresh start.`;
      systemContent += `\n- @rollback(AgentName, X) — Remove the last X messages from an agent's conversation history.`;
      systemContent += `\n- @stop_agent(AgentName) — Stop an agent's current task immediately.`;
      systemContent += `\n- @list_projects() — List all available projects.`;
      systemContent += `\n- @clear_all_chats() — Clear ALL agents' conversation histories at once, giving every agent a fresh start.`;
      systemContent += `\n- @clear_all_action_logs() — Clear ALL agents' action logs at once.`;
      systemContent += `\n- @list_agents() — List all enabled agents with their current status, project assignment, role, active tasks, and current task. Includes a project summary header showing agent distribution across projects.`;
      systemContent += `\n- @agent_status(AgentName) — Check a specific agent's detailed status: busy/idle/error, current project, current task, active task descriptions, sandbox state, message count, provider/model, and error count.`;
      systemContent += `\n- @get_available_agent(role) — Find all idle agents with the specified role (e.g. "developer"). Returns each agent's name, project assignment, and pending task count. If none are idle, shows busy agents with that role as a hint.`;
      systemContent += `\n- @swarm_status() — Get a comprehensive overview of the entire swarm: all agents grouped by their current project, with per-agent status, role, current task descriptions, and task counts.`;
      systemContent += `\n- @agents_on_project(projectName) — List all agents currently assigned to a specific project with their status, role, current task, and task counts. Useful for checking who is working on a particular project.`;
      if (projectNames.length > 0) {
        systemContent += `\nAvailable projects: ${projectNames.join(', ')}`;
      }
      systemContent += `\n\n⚠️ IMPORTANT: Before delegating tasks, ensure each agent has a project assigned. Agents without a project work at the workspace root and cannot access project files correctly. Use @assign_project(AgentName, "project_name") for any agent marked [no project] above before delegating code-related tasks to them. The system will auto-assign when possible, but explicit assignment is preferred.`;
    }

    // Append RAG context if available
    if (agent.ragDocuments.length > 0) {
      systemContent += '\n\n--- Reference Documents ---\n';
      for (const doc of agent.ragDocuments) {
        systemContent += `\n[${doc.name}]:\n${doc.content}\n`;
      }
    }
    // Append Plugins context and collect MCP server IDs from plugins
    const agentSkills = agent.skills || [];
    const pluginMcpIds = new Set();
    if (agentSkills.length > 0 && this.skillManager) {
      const resolvedPlugins = agentSkills.map(sid => this.skillManager.getById(sid)).filter(Boolean);
      if (resolvedPlugins.length > 0) {
        systemContent += '\n\n--- Active Plugins ---\n';
        for (const plugin of resolvedPlugins) {
          systemContent += `\n[${plugin.name}]:\n${plugin.instructions}\n`;
          // Collect MCP server IDs from plugin associations
          if (Array.isArray(plugin.mcpServerIds)) {
            plugin.mcpServerIds.forEach(id => pluginMcpIds.add(id));
          }
        }
      }
    }

    // Inject available agents list for agents with the direct-access skill
    if (agentSkills.includes('skill-agents-direct-access')) {
      const askableAgents = Array.from(this.agents.values())
        .filter(a => a.id !== id && a.enabled !== false)
        .map(a => `- ${a.name} (${a.role})${a.project ? ` [project: ${a.project}]` : ''}`);
      if (askableAgents.length > 0) {
        systemContent += `\n\n--- Agents You Can Ask ---\n`;
        systemContent += `Use @ask(AgentName, "question") for quick questions.\n`;
        systemContent += askableAgents.join('\n');
      }
    }

    // Merge MCP server IDs: from plugins + direct agent assignments (backward compat)
    const directMcpIds = agent.mcpServers || [];
    const allMcpIds = [...new Set([...pluginMcpIds, ...directMcpIds])];
    if (allMcpIds.length > 0 && this.mcpManager) {
      const { tools: mcpTools, unavailable: mcpUnavailable } = await this.mcpManager.getToolsForAgent(allMcpIds, id, agent.mcpAuth || {});
      if (mcpTools.length > 0) {
        systemContent += '\n\n--- MCP Tools ---\n';
        systemContent += 'These are NOT shell commands. Do NOT use @run_command or any bash tool to call them.\n';
        systemContent += 'Call them using ONLY the @mcp_call(server, tool, {"arg": "value"}) syntax — this is the ONLY valid way.\n';
        systemContent += 'IMPORTANT: Replace <type> placeholders with ACTUAL values. Do NOT copy the type descriptions.\n';
        systemContent += 'Example: @mcp_call(MyServer, my_tool, {"name": "my-actual-value", "count": 5})\n\n';
        for (const t of mcpTools) {
          const schema = _simplifyMcpSchema(t.inputSchema);
          systemContent += `@mcp_call(${t.serverName}, ${t.name}, ${schema}) — ${t.description || ''}\n`;
        }
      }
      // Warn agent about MCP servers that are expected but not connected
      if (mcpUnavailable.length > 0) {
        systemContent += '\n\n--- MCP Servers Unavailable ---\n';
        systemContent += 'The following MCP servers are configured but currently NOT connected.\n';
        systemContent += 'Do NOT attempt to call tools on these servers — they will fail.\n';
        systemContent += 'If the user asks you to use these tools, inform them that the MCP server is disconnected.\n\n';
        for (const u of mcpUnavailable) {
          systemContent += `- ${u.serverName}: ${u.reason}\n`;
        }
      }
    }

    // Append task list context
    if (agent.todoList.length > 0) {
      systemContent += '\n\n--- Current Task List ---\n';
      for (const task of agent.todoList) {
        const mark = task.status === 'done' ? 'x' : task.status === 'in_progress' ? '~' : task.status === 'error' ? '!' : ' ';
        systemContent += `- [${mark}] (${task.id.slice(0, 8)}) ${task.text}\n`;
      }
    }

    // Inject tool definitions and project working directory
    if (agent.project) {
      const fileTree = this.sandboxManager?.getFileTree(id);
      let projectCtx = `\n\n--- PROJECT CONTEXT ---\nYou are working on project: ${agent.project}\nYour current working directory is already the project root.\nAll file paths are relative to this root (e.g. @read_file(src/index.js), NOT @read_file(/projects/${agent.project}/src/index.js)).\nDo NOT use absolute paths or /projects/ prefixes — they will not work.`;
      if (fileTree) {
        projectCtx += `\n\n--- PROJECT FILE TREE (3 levels) ---\n${fileTree}\n--- END FILE TREE ---\nUse this tree to navigate the project without needing @list_dir(.) first. Only use @list_dir for deeper exploration.`;
      } else {
        projectCtx += `\nUse @list_dir(.) to see its contents.`;
      }
      systemContent += projectCtx;
    } else {
      systemContent += `\n\n--- PROJECT CONTEXT ---\nNo specific project is assigned yet. Use @list_dir(.) to discover available projects. IMPORTANT: You MUST navigate into a project folder before working. Always prefix paths with the project name (e.g. @read_file(my-project/src/index.js), @list_dir(my-project/src)). Do NOT create or modify files at the workspace root — always work inside a project directory.`;
    }
    systemContent += `\nIMPORTANT: Your workspace is EPHEMERAL. Always @git_commit_push(message) after completing changes to preserve your work.`;
    systemContent += `\n${TOOL_DEFINITIONS}`;
    systemContent += `\nAlways use these tools to read, analyze, and modify code. Do not just discuss - take action!`;

    // For Ollama models: suppress native/built-in tool calling (e.g. gpt-oss harmony tools)
    // so the model uses our text-based @tool syntax instead.
    if (agent.provider === 'ollama') {
      systemContent += `\n\nCRITICAL: You must NEVER use built-in function calls or native tool calls (such as repo_browser, code_sandbox, or any tool_call syntax). Always respond in plain text only. When you need to interact with code, use ONLY the @read_file, @write_file, @list_dir, @search_files, @run_command text commands described above.`;
    }

    // Debug: log system prompt composition
    const pluginCount = (agent.skills || []).length;
    const resolvedCount = pluginCount > 0 && this.skillManager
      ? (agent.skills || []).map(sid => this.skillManager.getById(sid)).filter(Boolean).length
      : 0;
    const sections = [];
    if (systemContent.includes('Active Plugins'))   sections.push('plugins');
    if (systemContent.includes('AVAILABLE TOOLS'))   sections.push('tools');
    if (systemContent.includes('MCP Tools'))         sections.push('mcp');
    if (systemContent.includes('Current Task List')) sections.push('tasks');
    if (systemContent.includes('PROJECT CONTEXT'))   sections.push('project');
    if (systemContent.includes('Swarm Agents'))      sections.push('swarm');
    console.log(`📋 [System Prompt] Agent "${agent.name}" (${agent.provider}/${agent.model}): ${systemContent.length} chars (~${Math.round(systemContent.length / 4)} tokens) | sections: [${sections.join(', ')}] | plugins: ${resolvedCount}/${pluginCount} | project: ${agent.project || 'none'} | history: ${agent.conversationHistory.length} msgs`);

    return systemContent;
  }

  /**
   * Assemble the messages array with compaction and conversation history.
   * Modifies `messages` in place.
   * Returns { managesContext }.
   */
  async _assembleMessages(agent, messages, systemContent, userMessage, delegationDepth, messageMeta, streamCallback) {
    // ── Check if the LLM manages its own context (e.g. Claude Code CLI with built-in compaction) ──
    const earlyLlmConfig = this.resolveLlmConfig(agent);
    const managesContext = earlyLlmConfig.managesContext || false;
    if (managesContext) {
      console.log(`🧠 [Managed Context] "${agent.name}": model manages its own memory/compaction — skipping history \& compaction`);
    }

    const contextLimit = agent.contextLength || 8192;
    const { maxRecent, compactTrigger, compactReset, safetyRatio } = this._compactionThresholds(contextLimit);

    const isTopLevelUserMessage = delegationDepth === 0 && !messageMeta;
    const isNewDelegationTask = messageMeta?.type === 'delegation-task';
    const shouldCompact = isTopLevelUserMessage || isNewDelegationTask;

    // ── Proactive compaction (only on top-level or new delegation messages) ──
    if (shouldCompact && !managesContext) {
      const nonSummaryMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');

      if (agent._compactionArmed === undefined) {
        agent._compactionArmed = true;
      }
      if (!agent._compactionArmed && nonSummaryMessages.length <= compactReset) {
        agent._compactionArmed = true;
      }

      if (agent._compactionArmed && nonSummaryMessages.length > compactTrigger) {
        console.log(`🗜️  [Proactive Compact] "${agent.name}": ${nonSummaryMessages.length} messages — compacting to keep ${maxRecent} recent (context: ${contextLimit})`);
        if (streamCallback) streamCallback(`\n⏳ *Compacting conversation history (${nonSummaryMessages.length} messages)...*\n`);
        await this._compactHistory(agent, maxRecent);
        agent._compactionArmed = false;
      }
    }

    // Add conversation history (skip for managesContext — Claude Code CLI handles its own memory)
    if (!managesContext) {
      const summary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
      const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
      if (summary) messages.push(summary);
      messages.push(...realMessages.slice(-maxRecent));
    }

    // Add user message (always — required for all providers)
    messages.push({ role: 'user', content: userMessage });

    // ── Safety net: also compact if token budget is exceeded ──
    if (shouldCompact && !managesContext) {
      const realMessages = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
      const estimatedTokens = this._estimateTokens(messages);
      // For large contexts, allow up to 80% usage before triggering; smaller contexts stay at 75%
      if (estimatedTokens > contextLimit * safetyRatio && realMessages.length > maxRecent) {
        // Emergency compact: keep fewer messages (scaled down)
        const emergencyKeep = Math.max(6, Math.floor(maxRecent * 0.6));
        console.log(`🗜️  [Token Compact] "${agent.name}": estimated ${estimatedTokens} tokens vs ${contextLimit} limit — compacting to keep ${emergencyKeep}`);
        if (streamCallback) streamCallback(`\n⏳ *Compacting conversation history (token limit)...*\n`);
        await this._compactHistory(agent, emergencyKeep);
        agent._compactionArmed = false;
        // Rebuild messages with compacted history
        messages.length = 0;
        if (systemContent) {
          messages.push({ role: 'system', content: systemContent });
        }
        const newSummary = agent.conversationHistory.find(m => m.type === 'compaction-summary');
        const newReal = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
        if (newSummary) messages.push(newSummary);
        messages.push(...newReal.slice(-maxRecent));
        messages.push({ role: 'user', content: userMessage });
      }
    }

    return { managesContext };
  }

  /**
   * Stream the LLM response with auto-continuation and incremental delegation detection.
   * Returns { fullResponse, thinkingBuffer, finishReason, delegationPromises, detectedCount }.
   */
  async _streamAndContinue(agent, id, messages, llmConfig, streamCallback, abortController, delegationDepth) {
    const MAX_DELEGATION_DEPTH = 5;
    const provider = createProvider({
      provider: llmConfig.provider,
      model: llmConfig.model,
      endpoint: llmConfig.endpoint,
      apiKey: llmConfig.apiKey,
      agentId: id
    });

    let fullResponse = '';
    let thinkingBuffer = '';
    let finishReason = null;

    // ── Incremental delegation: detect → enqueue immediately ───────────
    let detectedCount = 0;
    const delegationPromises = [];   // Promise[] — one per enqueued task
    const isLeaderStreaming = agent.isLeader && delegationDepth < MAX_DELEGATION_DEPTH;

    // Stream response (check for abort on each chunk)
    const safeMaxTokens = this._safeMaxTokens(messages, agent, llmConfig);

    // Final safety net: truncate individual large messages if total still exceeds context
    this._truncateMessagesToFit(messages, llmConfig.contextLength || 131072, safeMaxTokens);

    for await (const chunk of provider.chatStream(messages, {
      temperature: llmConfig.temperature,
      maxTokens: safeMaxTokens,
      contextLength: llmConfig.contextLength || 0,
      isReasoning: llmConfig.isReasoning || agent.isReasoning || false,
      signal: abortController.signal
    })) {
      // Check if aborted
      if (abortController.signal.aborted) {
        throw new Error('Agent stopped by user');
      }

      if (chunk.type === 'thinking') {
        // Reasoning model thinking tokens — accumulate and show in UI but don't add to response
        thinkingBuffer += chunk.text;
        agent.currentThinking = thinkingBuffer;
        this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: thinkingBuffer });
      }

      if (chunk.type === 'text') {
        fullResponse += chunk.text;
        agent.currentThinking = fullResponse;
        if (streamCallback) streamCallback(chunk.text);

        // ── Incremental delegation detection ──────────────────────
        if (isLeaderStreaming) {
          const cleanedForParsing = fullResponse.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
          const parsed = this._parseDelegations(cleanedForParsing);
          while (detectedCount < parsed.length) {
            const delegation = parsed[detectedCount];
            detectedCount++;

            const targetAgent = Array.from(this.agents.values()).find(
              a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== id && a.enabled !== false
            );

            if (!targetAgent) {
              console.log(`⚠️  Agent "${delegation.agentName}" not found or disabled in swarm`);
              delegationPromises.push(
                Promise.resolve({ agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found or disabled in swarm` })
              );
              continue;
            }

            // ── Auto-propagate project to target agent if it has none ──
            if (!targetAgent.project) {
              // Try leader's project first, then fall back to only available project
              let projectToAssign = agent.project;
              if (!projectToAssign) {
                const availableProjects = await this._listAvailableProjects();
                if (availableProjects.length === 1) {
                  projectToAssign = availableProjects[0];
                }
              }
              if (projectToAssign) {
                this.update(targetAgent.id, { project: projectToAssign });
                console.log(`📁 [Auto-assign] ${targetAgent.name} → project "${projectToAssign}" (inherited during delegation)`);
                if (streamCallback) streamCallback(`\n📁 Auto-assigned ${targetAgent.name} to project "${projectToAssign}"\n`);
              }
            }

            console.log(`⚡ [Incremental] Detected delegation #${detectedCount}: ${delegation.agentName} — enqueuing`);

            // Notify UI immediately
            this._emit('agent:delegation', {
              from: { id, name: agent.name, project: agent.project || null },
              to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
              task: delegation.task
            });

            // Create task immediately (inherit source agent's project)
            const createdTask = this.addTask(targetAgent.id, `[From ${agent.name}] ${delegation.task}`, agent.project || null, { type: 'agent', name: agent.name, id });

            // Enqueue execution — the queue will process it when the agent is free
            const promise = this._enqueueAgentTask(targetAgent.id, async () => {
              // Mark task as in_progress
              if (createdTask) {
                const t = targetAgent.todoList.find(t => t.id === createdTask.id);
                if (t) {
                  t.status = 'in_progress';
                  t.startedAt = new Date().toISOString();
                  saveAgent(targetAgent);
                  this._emit('agent:updated', this._sanitize(targetAgent));
                }
              }

              // Notify leader's stream with a status marker (not raw sub-agent output)
              if (streamCallback) streamCallback(`\n\n--- \uD83D\uDCE8 Delegating to ${targetAgent.name} ---\n`);

              // Stream to the sub-agent's own chat via socket
              this._emit('agent:stream:start', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });

              const agentResponse = await this.sendMessage(
                targetAgent.id,
                `[TASK from ${agent.name}]: ${delegation.task}`,
                (chunk) => {
                  // Stream to the sub-agent's own chat
                  this._emit('agent:stream:chunk', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, chunk });
                },
                delegationDepth + 1,
                { type: 'delegation-task', fromAgent: agent.name }
              );

              // End sub-agent stream and notify leader
              this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });
              if (streamCallback) streamCallback(`\n--- \u2705 ${targetAgent.name} finished ---\n`);
              this._emit('agent:updated', this._sanitize(targetAgent));

              // Mark task as done
              if (createdTask) {
                const t = targetAgent.todoList.find(t => t.id === createdTask.id);
                if (t) {
                  t.status = 'done';
                  t.completedAt = new Date().toISOString();
                  saveAgent(targetAgent);
                  this._emit('agent:updated', this._sanitize(targetAgent));
                }
              }

              return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
            }).catch(err => {
              // End sub-agent stream on error too
              if (targetAgent?.id) this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent?.name || null, project: targetAgent?.project || null });
              // Mark task as error
              if (createdTask && targetAgent) {
                const t = targetAgent.todoList.find(t => t.id === createdTask.id);
                if (t) {
                  t.errorFromStatus = t.status;
                  t.status = 'error';
                  t.error = err.message;
                  t.completedAt = new Date().toISOString();
                  saveAgent(targetAgent);
                  this._emit('agent:updated', this._sanitize(targetAgent));
                }
              }
              return { agentId: targetAgent?.id, agentName: targetAgent?.name || delegation.agentName, project: targetAgent?.project || null, task: delegation.task, response: null, error: err.message };
            });

            delegationPromises.push(promise);
          }
        }
      }
      if (chunk.type === 'done') {
        if (chunk.usage) {
          agent.metrics.totalTokensIn += chunk.usage.inputTokens;
          agent.metrics.totalTokensOut += chunk.usage.outputTokens;
          this._recordUsage(agent, chunk.usage.inputTokens || 0, chunk.usage.outputTokens || 0);
        }
        if (chunk.finishReason) {
          finishReason = chunk.finishReason;
        }
      }
    }

    // ── Auto-continuation: if the model hit maxTokens, ask it to continue ──
    const MAX_CONTINUATIONS = 3;
    let continuationCount = 0;
    while (finishReason === 'length' && continuationCount < MAX_CONTINUATIONS) {
      continuationCount++;
      console.log(`🔄 [Continuation ${continuationCount}/${MAX_CONTINUATIONS}] "${agent.name}": response was truncated (finish_reason=length), requesting continuation...`);
      if (streamCallback) streamCallback(`\n⏳ *Response truncated, continuing...*\n`);

      // Add the partial response to history and ask the model to continue
      messages.push({ role: 'assistant', content: fullResponse });
      messages.push({ role: 'user', content: 'Your previous response was cut off because it exceeded the maximum output length. Continue EXACTLY from where you stopped. Do not repeat anything you already wrote — just output the remaining content.' });

      finishReason = null;
      const contMaxTokens = this._safeMaxTokens(messages, agent, llmConfig);
      this._truncateMessagesToFit(messages, llmConfig.contextLength || 131072, contMaxTokens);
      for await (const chunk of provider.chatStream(messages, {
        temperature: llmConfig.temperature,
        maxTokens: contMaxTokens,
        contextLength: llmConfig.contextLength || 0,
        isReasoning: llmConfig.isReasoning || agent.isReasoning || false,
        signal: abortController.signal
      })) {
        if (abortController.signal.aborted) {
          throw new Error('Agent stopped by user');
        }
        if (chunk.type === 'thinking') {
          thinkingBuffer += chunk.text;
          agent.currentThinking = thinkingBuffer;
          this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: thinkingBuffer });
        }
        if (chunk.type === 'text') {
          fullResponse += chunk.text;
          agent.currentThinking = fullResponse;
          if (streamCallback) streamCallback(chunk.text);
        }
        if (chunk.type === 'done') {
          if (chunk.usage) {
            agent.metrics.totalTokensIn += chunk.usage.inputTokens;
            agent.metrics.totalTokensOut += chunk.usage.outputTokens;
            this._recordUsage(agent, chunk.usage.inputTokens || 0, chunk.usage.outputTokens || 0);
          }
          if (chunk.finishReason) {
            finishReason = chunk.finishReason;
          }
        }
      }
      // Remove the temporary continuation messages from the messages array
      // so they don't pollute the stored history
      messages.pop(); // remove continuation prompt
      messages.pop(); // remove partial assistant response
    }

    if (continuationCount > 0 && finishReason === 'length') {
      console.log(`⚠️  [Continuation] "${agent.name}": still truncated after ${MAX_CONTINUATIONS} continuations`);
    }

    return { fullResponse, thinkingBuffer, finishReason, delegationPromises, detectedCount };
  }

  /**
   * Process leader-specific commands (@assign_project, @get_project, @clear_context, etc.)
   */
  async _processLeaderCommands(agent, id, responseForParsing, streamCallback) {
    const projectAssignments = this._parseProjectAssignments(responseForParsing);
    for (const assignment of projectAssignments) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === assignment.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Assign Project] Agent "${assignment.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${assignment.targetAgentName}" not found in swarm\n`);
        continue;
      }
      this.update(targetAgent.id, { project: assignment.projectName });
      console.log(`📁 [Assign Project] ${targetAgent.name} → project "${assignment.projectName}"`);
      if (streamCallback) streamCallback(`\n✓ Assigned ${targetAgent.name} to project "${assignment.projectName}"\n`);
    }

    // ── Process @get_project commands ──────────────────────────────────
    const getProjectCommands = this._parseGetProject(responseForParsing);
    for (const cmd of getProjectCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Get Project] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const projectInfo = targetAgent.project || '(no project assigned)';
      console.log(`📋 [Get Project] ${targetAgent.name} → "${projectInfo}"`);
      if (streamCallback) streamCallback(`\n📋 ${targetAgent.name} is assigned to project: ${projectInfo}\n`);
    }

    // ── Process @clear_context commands ────────────────────────────────
    const clearContextCommands = this._parseClearContext(responseForParsing);
    for (const cmd of clearContextCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Clear Context] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      this.clearHistory(targetAgent.id);
      console.log(`🧹 [Clear Context] Cleared conversation history for ${targetAgent.name}`);
      if (streamCallback) streamCallback(`\n🧹 Cleared conversation history for ${targetAgent.name}\n`);
    }

    // ── Process @rollback commands ─────────────────────────────────────
    const rollbackCommands = this._parseRollback(responseForParsing);
    for (const cmd of rollbackCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Rollback] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const historyLen = targetAgent.conversationHistory.length;
      const removeCount = Math.min(cmd.count, historyLen);
      if (removeCount === 0) {
        if (streamCallback) streamCallback(`\n⚠️ ${targetAgent.name} has no messages to rollback\n`);
        continue;
      }
      const newLength = historyLen - removeCount;
      targetAgent.conversationHistory = targetAgent.conversationHistory.slice(0, newLength);
      if (newLength === 0) {
        delete targetAgent._compactionArmed;
      }
      saveAgent(targetAgent);
      this._emit('agent:updated', this._sanitize(targetAgent));
      console.log(`⏪ [Rollback] Removed last ${removeCount} message(s) from ${targetAgent.name} (${historyLen} → ${newLength})`);
      if (streamCallback) streamCallback(`\n⏪ Rolled back ${removeCount} message(s) from ${targetAgent.name} (${historyLen} → ${newLength} messages)\n`);
    }

    // ── Process @list_projects commands ──────────────────────────────
    if (/@list_projects\s*\(\s*\)/i.test(responseForParsing)) {
      const projectNames = await this._listAvailableProjects();
      if (projectNames.length > 0) {
        console.log(`📂 [List Projects] ${projectNames.length} projects found`);
        if (streamCallback) streamCallback(`\n📂 Available projects: ${projectNames.join(', ')}\n`);
      } else {
        if (streamCallback) streamCallback(`\n📂 No projects found\n`);
      }
    }

    // ── Process @stop_agent commands ─────────────────────────────────
    const stopAgentCommands = this._parseStopAgent(responseForParsing);
    for (const cmd of stopAgentCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.id !== id && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Stop Agent] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const stopped = this.stopAgent(targetAgent.id);
      if (stopped) {
        console.log(`🛑 [Stop Agent] Stopped ${targetAgent.name}`);
        if (streamCallback) streamCallback(`\n🛑 Stopped agent ${targetAgent.name}\n`);
      } else {
        if (streamCallback) streamCallback(`\n⚠️ ${targetAgent.name} is not currently busy\n`);
      }
    }

    // ── Process @clear_all_chats commands ───────────────────────────
    if (/@clear_all_chats\s*\(\s*\)/i.test(responseForParsing)) {
      let count = 0;
      for (const a of this.agents.values()) {
        if (a.id !== id && a.enabled !== false) {
          this.clearHistory(a.id);
          count++;
        }
      }
      console.log(`🧹 [Clear All Chats] Cleared conversation history for ${count} agents`);
      if (streamCallback) streamCallback(`\n🧹 Cleared conversation history for ${count} agents\n`);
    }

    // ── Process @clear_all_action_logs commands ─────────────────────
    if (/@clear_all_action_logs\s*\(\s*\)/i.test(responseForParsing)) {
      let count = 0;
      for (const a of this.agents.values()) {
        if (a.id !== id && a.enabled !== false) {
          this.clearActionLogs(a.id);
          count++;
        }
      }
      console.log(`📋 [Clear All Action Logs] Cleared action logs for ${count} agents`);
      if (streamCallback) streamCallback(`\n📋 Cleared action logs for ${count} agents\n`);
    }

    // ── Process @agent_status commands ───────────────────────────────
    const agentStatusCommands = this._parseAgentStatus(responseForParsing);
    for (const cmd of agentStatusCommands) {
      const targetAgent = Array.from(this.agents.values()).find(
        a => a.name.toLowerCase() === cmd.targetAgentName.toLowerCase() && a.enabled !== false
      );
      if (!targetAgent) {
        console.log(`⚠️  [Agent Status] Agent "${cmd.targetAgentName}" not found`);
        if (streamCallback) streamCallback(`\n⚠️ Agent "${cmd.targetAgentName}" not found in swarm\n`);
        continue;
      }
      const todoList = targetAgent.todoList || [];
      const pendingTasks = todoList.filter(t => t.status === 'pending' || t.status === 'error').length;
      const inProgressTasks = todoList.filter(t => t.status === 'in_progress').length;
      const doneTasks = todoList.filter(t => t.status === 'done').length;
      const totalTasks = todoList.length;
      const msgCount = (targetAgent.conversationHistory || []).length;
      const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(targetAgent.id) : false;
      const inProgressTask = todoList.find(t => t.status === 'in_progress');
      const currentTaskInfo = targetAgent.currentTask
        ? targetAgent.currentTask.slice(0, 120) + (targetAgent.currentTask.length > 120 ? '...' : '')
        : inProgressTask
          ? inProgressTask.text.slice(0, 120) + (inProgressTask.text.length > 120 ? '...' : '')
          : 'none';
      const projectAssignedAt = targetAgent.projectChangedAt
        ? new Date(targetAgent.projectChangedAt).toLocaleString()
        : 'n/a';
      const targetProjectDuration = targetAgent.project && targetAgent.projectChangedAt
        ? AgentManager.formatDuration(Date.now() - new Date(targetAgent.projectChangedAt).getTime())
        : 'n/a';
      const lines = [
        `Name: ${targetAgent.name}`,
        `Status: ${targetAgent.status}`,
        `Role: ${targetAgent.role || 'worker'}`,
        `Project: ${targetAgent.project || 'none'}${targetAgent.project ? ` (assigned ${projectAssignedAt}, duration: ${targetProjectDuration})` : ''}`,
        `Current task: ${currentTaskInfo}`,
        `Provider: ${targetAgent.provider || 'unknown'}/${targetAgent.model || 'unknown'}`,
        `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
        `Tasks: ${inProgressTasks} in-progress, ${pendingTasks} pending, ${doneTasks} done / ${totalTasks} total`,
        `Messages: ${msgCount}`,
        `Last active: ${targetAgent.metrics?.lastActiveAt || 'never'}`,
        `Errors: ${targetAgent.metrics?.errors || 0}`,
      ];
      // Show active task details if any
      const activeTasks = todoList.filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error');
      if (activeTasks.length > 0) {
        lines.push(`Active tasks:`);
        for (const t of activeTasks.slice(0, 10)) {
          const mark = t.status === 'in_progress' ? '~' : t.status === 'error' ? '!' : ' ';
          lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
        }
        if (activeTasks.length > 10) lines.push(`  ... and ${activeTasks.length - 10} more`);
      }
      console.log(`📊 [Agent Status] ${targetAgent.name}: ${targetAgent.status} | project=${targetAgent.project || 'none'} | task=${currentTaskInfo}`);
      if (streamCallback) streamCallback(`\n📊 Agent status:\n${lines.join('\n')}\n`);
    }

    // ── Process @list_agents commands ────────────────────────────────
    if (/@list_agents\s*\(\s*\)/i.test(responseForParsing)) {
      const enabled = Array.from(this.agents.values()).filter(a => a.enabled !== false);

      // Build project summary header
      const projectGroups = {};
      let unassignedCount = 0;
      for (const a of enabled) {
        if (a.project) {
          if (!projectGroups[a.project]) projectGroups[a.project] = { busy: 0, idle: 0, error: 0, total: 0 };
          projectGroups[a.project].total++;
          if (a.status === 'busy') projectGroups[a.project].busy++;
          else if (a.status === 'error') projectGroups[a.project].error++;
          else projectGroups[a.project].idle++;
        } else {
          unassignedCount++;
        }
      }

      let output = `\n👥 Enabled agents (${enabled.length}):\n`;
      // Project summary
      const projectKeys = Object.keys(projectGroups);
      if (projectKeys.length > 0 || unassignedCount > 0) {
        output += `Projects: ${projectKeys.map(p => `${p} (${projectGroups[p].busy} busy, ${projectGroups[p].idle} idle)`).join(' | ')}`;
        if (unassignedCount > 0) output += ` | unassigned: ${unassignedCount}`;
        output += '\n';
      }

      // Per-agent details
      const lines = enabled.map(a => {
        const projectTag = a.project ? `project=${a.project}` : 'NO PROJECT';
        const taskCount = (a.todoList || []).filter(t => t.status !== 'done').length;
        const inProgressTask = (a.todoList || []).find(t => t.status === 'in_progress');
        const taskCountInfo = taskCount > 0 ? ` tasks=${taskCount}` : '';
        const taskInfo = a.currentTask
          ? ` working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
          : inProgressTask
            ? ` working on: "${inProgressTask.text.slice(0, 80)}${inProgressTask.text.length > 80 ? '...' : ''}"`
            : '';
        return `- ${a.name} [${a.status}] [${projectTag}] (${a.role || 'worker'})${taskCountInfo}${taskInfo}`;
      });
      output += lines.join('\n') + '\n';

      console.log(`👥 [List Agents] ${enabled.length} enabled agents across ${projectKeys.length} projects`);
      if (streamCallback) streamCallback(output);
    }

    // ── Process @get_available_agent commands ─────────────────────────
    const getAvailableCommands = this._parseGetAvailableAgent(responseForParsing);
    for (const cmd of getAvailableCommands) {
      const allMatching = Array.from(this.agents.values()).filter(
        a => a.id !== id && a.enabled !== false && a.status === 'idle' && (a.role || '').toLowerCase() === cmd.role.toLowerCase()
      );
      if (allMatching.length > 0) {
        const lines = allMatching.map(a => {
          const projectInfo = a.project ? `project=${a.project}` : 'no project';
          const todoCount = (a.todoList || []).filter(t => t.status !== 'done').length;
          const taskInfo = todoCount > 0 ? `, ${todoCount} pending tasks` : '';
          return `  - ${a.name} [idle] (${projectInfo}${taskInfo})`;
        });
        console.log(`🔍 [Get Available] Found ${allMatching.length} idle "${cmd.role}" agent(s)`);
        if (streamCallback) streamCallback(`\n🔍 Available ${cmd.role} agents (${allMatching.length} idle):\n${lines.join('\n')}\n`);
      } else {
        // Show busy agents with that role as a hint
        const busyMatching = Array.from(this.agents.values()).filter(
          a => a.id !== id && a.enabled !== false && a.status === 'busy' && (a.role || '').toLowerCase() === cmd.role.toLowerCase()
        );
        let hint = '';
        if (busyMatching.length > 0) {
          hint = ` (${busyMatching.length} busy: ${busyMatching.map(a => `${a.name} on ${a.project || 'no project'}`).join(', ')})`;
        }
        console.log(`🔍 [Get Available] No idle agent with role "${cmd.role}"`);
        if (streamCallback) streamCallback(`\n🔍 No idle agent with role "${cmd.role}" available${hint}\n`);
      }
    }

    // ── Process @swarm_status commands ──────────────────────────────
    if (/@swarm_status\s*\(\s*\)/i.test(responseForParsing)) {
      const swarmStatus = this.getSwarmStatus();
      const s = swarmStatus.summary;
      let output = `\n📊 Swarm Status: ${s.enabled} agents (${s.busy} busy, ${s.idle} idle, ${s.error} error) | ${s.activeProjects.length} active projects\n`;
      // Group by project
      for (const [project, agents] of Object.entries(swarmStatus.projectAssignments)) {
        const ps = swarmStatus.projectSummaries[project];
        output += `\n📁 Project: ${project} (${ps.total} agents: ${ps.busy} busy, ${ps.idle} idle)\n`;
        for (const a of agents) {
          const taskInfo = a.currentTask
            ? ` — working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
            : '';
          const taskCountInfo = a.tasks.inProgress > 0 || a.tasks.pending > 0
            ? ` | tasks: ${a.tasks.inProgress} in-progress, ${a.tasks.pending} pending`
            : '';
          output += `  - ${a.name} [${a.status}] (${a.role})${taskCountInfo}${taskInfo}\n`;
        }
      }
      if (swarmStatus.unassignedAgents.length > 0) {
        output += `\n⚠️ Unassigned (no project): ${swarmStatus.unassignedAgents.length} agents\n`;
        for (const a of swarmStatus.unassignedAgents) {
          const taskInfo = a.currentTask ? ` — task: "${a.currentTask.slice(0, 80)}..."` : '';
          output += `  - ${a.name} [${a.status}] (${a.role})${taskInfo}\n`;
        }
      }
      console.log(`📊 [Swarm Status] ${s.enabled} agents, ${Object.keys(swarmStatus.projectAssignments).length} projects`);
      if (streamCallback) streamCallback(output);
    }

    // ── Process @agents_on_project commands ─────────────────────────
    const agentsOnProjectCommands = this._parseAgentsOnProject(responseForParsing);
    for (const cmd of agentsOnProjectCommands) {
      const agents = this.getAgentsByProject(cmd.projectName);
      if (agents.length > 0) {
        let output = `\n📁 Agents on project "${cmd.projectName}" (${agents.length}):\n`;
        const busyCount = agents.filter(a => a.status === 'busy').length;
        const idleCount = agents.filter(a => a.status === 'idle').length;
        output += `Summary: ${busyCount} busy, ${idleCount} idle\n`;
        for (const a of agents) {
          const taskInfo = a.currentTask
            ? ` — working on: "${a.currentTask.slice(0, 80)}${a.currentTask.length > 80 ? '...' : ''}"`
            : '';
          const taskCountInfo = a.tasks.inProgress > 0 || a.tasks.pending > 0
            ? ` | tasks: ${a.tasks.inProgress} in-progress, ${a.tasks.pending} pending`
            : '';
          output += `  - ${a.name} [${a.status}] (${a.role})${taskCountInfo}${taskInfo}\n`;
        }
        console.log(`📁 [Agents On Project] ${agents.length} agents on "${cmd.projectName}"`);
        if (streamCallback) streamCallback(output);
      } else {
        console.log(`📁 [Agents On Project] No agents assigned to "${cmd.projectName}"`);
        if (streamCallback) streamCallback(`\n📁 No agents are currently assigned to project "${cmd.projectName}"\n`);
      }
    }
  }

  /**
   * Process all post-response actions: tool calls, ask commands, delegations, leader commands, rate limits.
   * Returns { earlyReturn: string|null } — if non-null, sendMessage should return that value.
   */
  async _processPostResponseActions(agent, id, responseForParsing, fullResponse, streamCallback, delegationDepth, messageMeta, delegationPromises, detectedCount) {
    const MAX_DELEGATION_DEPTH = 5;
    const isLeaderStreaming = agent.isLeader && delegationDepth < MAX_DELEGATION_DEPTH;
    const isTopLevel = delegationDepth === 0 && !messageMeta;

    // Shared nudge detection (used for both tool-using agents and leaders)
    const isNudge = messageMeta?.type === 'nudge';
    // Intent patterns: only match when the response STARTS with planning language
    // (first 200 chars), indicating the agent is planning instead of acting.
    const intentPatterns = /^[\s\S]{0,200}\b(i('ll| will| am going to|'m going to) (start|begin|proceed|now|first)|let me (start|begin|proceed|first|now|go ahead)|let's (start|begin|proceed)|je vais (commencer|d'abord|maintenant)|commençons par|je m'en occupe)\b/i;
    // Additional safeguard: only nudge short responses (< 500 chars) that look like pure planning
    const looksLikePurePlan = responseForParsing.length < 500;

    // Process tool calls — all agents can use tools (no project = access to all projects)
    {
      const toolResults = await this._processToolCalls(id, responseForParsing, streamCallback, delegationDepth);
      if (toolResults.length > 0) {
        // Feed tool results back to agent and continue
        const resultsSummary = toolResults.map(r => {
          if (r.isErrorReport) {
            return `--- ⚠️ ERROR REPORT ---\n${r.args[0] || r.result}`;
          }
          if (!r.success) {
            // Include both the error message AND the actual command output (stderr/stdout)
            const parts = [`ERROR: ${r.error}`];
            if (r.result) parts.push(`OUTPUT:\n${r.result}`);
            return `--- ${r.tool}(${r.args.join(', ')}) ---\n${parts.join('\n')}`;
          }
          return `--- ${r.tool}(${r.args.join(', ')}) ---\n${r.result}`;
        }).join('\n\n');

        // Check if there are error reports — add specific instructions for the agent
        const hasErrorReports = toolResults.some(r => r.isErrorReport);
        const hasRealErrors = toolResults.some(r => !r.success && !r.isErrorReport);
        const hasSuccessfulCommit = toolResults.some(r => r.tool === 'git_commit_push' && r.success);
        let continuationPrompt = '\n';
        if (hasErrorReports) {
          continuationPrompt = '\nYou reported an error. The error has been escalated to the manager. Summarize what you attempted and what went wrong so the manager can help.';
        } else if (hasRealErrors) {
          continuationPrompt = '\nSome tools encountered errors. Try to resolve the issues, use alternative approaches, or use @report_error(description) to escalate the problem to the manager if you cannot resolve it.';
        } else if (hasSuccessfulCommit) {
          continuationPrompt = '\n Your code has been committed, pushed, and the task has been auto-completed. Provide a brief summary of what was accomplished.';
        }

        const continuedResponse = await this.sendMessage(
          id,
          `\n${resultsSummary}\n\n${continuationPrompt}`,
          streamCallback,
          delegationDepth,  // Same depth — tool continuation is the same agent working
          { type: 'tool-result', toolResults: toolResults.map(r => ({ tool: r.tool, args: r.args, success: r.success, result: r.result || undefined, error: r.success ? undefined : r.error, isErrorReport: r.isErrorReport || false })) }
        );
        return { earlyReturn: continuedResponse };
      }

      // Nudge mechanism: if agent has tools (project or MCP), produced text but NO tool calls,
      // and this isn't already a nudge — the agent may have described intent without acting.
      // Only nudge agents that have tools available (project-based or MCP).
      const hasTools = agent.project || agent.mcpServers?.length > 0 || agent.skills?.length > 0;
      if (hasTools && !isNudge && looksLikePurePlan && responseForParsing.length > 20 && !isLeaderStreaming) {
        if (intentPatterns.test(responseForParsing)) {
          console.log(`🔄 [Nudge] Agent "${agent.name}" described intent but used no tools — nudging`);
          const nudgeMessage = agent.project || agent.skills?.length > 0
            ? '[SYSTEM] You described what you plan to do but did not use any tools. Stop describing and START ACTING NOW. Use @read_file, @write_file, @list_dir, @search_files, or @run_command to accomplish your task. Do NOT explain what you will do — just do it.'
            : '[SYSTEM] You described what you plan to do but did not use any tools. Stop describing and START ACTING NOW. Use your available @mcp_call tools to accomplish your task. Do NOT explain what you will do — just do it.';
          const nudgeResponse = await this.sendMessage(
            id,
            nudgeMessage,
            streamCallback,
            delegationDepth,
            { type: 'nudge' }
          );
          return { earlyReturn: nudgeResponse };
        }
      }
    }

    // ── Process @ask commands (any agent with direct-access skill) ────────
    {
      const agentHasDirectAccess = (agent.skills || []).includes('skill-agents-direct-access');
      if (agentHasDirectAccess && delegationDepth < MAX_DELEGATION_DEPTH) {
        const askCommands = this._parseAskCommands(responseForParsing);

        if (askCommands.length > 0) {
          const askResults = [];

          for (const askCmd of askCommands) {
            const targetAgent = Array.from(this.agents.values()).find(
              a => a.name.toLowerCase() === askCmd.agentName.toLowerCase() && a.id !== id && a.enabled !== false
            );

            if (!targetAgent) {
              console.log(`⚠️  [Ask] Agent "${askCmd.agentName}" not found or disabled`);
              askResults.push({ agentName: askCmd.agentName, answer: null, error: `Agent "${askCmd.agentName}" not found or disabled in swarm` });
              continue;
            }

            if (targetAgent.status === 'busy') {
              console.log(`⚠️  [Ask] Agent "${askCmd.agentName}" is busy`);
              askResults.push({ agentName: askCmd.agentName, answer: null, error: `Agent "${askCmd.agentName}" is currently busy. Try again later.` });
              continue;
            }

            console.log(`💬 [Ask] ${agent.name} → ${targetAgent.name}: "${askCmd.question.slice(0, 80)}"`);

            this._emit('agent:ask', {
              from: { id, name: agent.name },
              to: { id: targetAgent.id, name: targetAgent.name },
              question: askCmd.question
            });

            this._emit('agent:stream:start', { agentId: targetAgent.id });

            try {
              const answer = await this.sendMessage(
                targetAgent.id,
                `[QUESTION from ${agent.name}]: ${askCmd.question}\n\nPlease provide a concise, direct answer.`,
                (chunk) => {
                  this._emit('agent:stream:chunk', { agentId: targetAgent.id, chunk });
                },
                delegationDepth + 1,
                { type: 'ask-question', fromAgent: agent.name }
              );

              this._emit('agent:stream:end', { agentId: targetAgent.id });
              this._emit('agent:updated', this._sanitize(targetAgent));

              askResults.push({ agentName: targetAgent.name, answer, error: null });
            } catch (err) {
              this._emit('agent:stream:end', { agentId: targetAgent.id });
              console.error(`💬 [Ask] Error from ${targetAgent.name}: ${err.message}`);
              askResults.push({ agentName: targetAgent.name, answer: null, error: err.message });
            }
          }

          // Feed answers back to the asking agent
          const answersSummary = askResults.map(r => {
            if (r.error) return `--- ⚠️ ERROR asking ${r.agentName} ---\n${r.error}`;
            return `--- Answer from ${r.agentName} ---\n${r.answer}`;
          }).join('\n\n');

          if (streamCallback) streamCallback(`\n\n--- Received answers, continuing ---\n\n`);

          const continuedResponse = await this.sendMessage(
            id,
            `[ASK RESULTS]\n${answersSummary}\n\nContinue with your task based on these answers.`,
            streamCallback,
            delegationDepth,
            { type: 'ask-result', askResults: askResults.map(r => ({ agentName: r.agentName, answer: r.answer, error: r.error })) }
          );
          return { earlyReturn: continuedResponse };
        }
      }
    }

    // For leader agents, process delegation commands (with depth limit)
    if (isLeaderStreaming) {
      // Final pass: catch any delegations completed in the last chunk
      const finalParsed = this._parseDelegations(responseForParsing);
      while (detectedCount < finalParsed.length) {
        const delegation = finalParsed[detectedCount];
        detectedCount++;

        const targetAgent = Array.from(this.agents.values()).find(
          a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== id
        );

        if (!targetAgent) {
          delegationPromises.push(
            Promise.resolve({ agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found in swarm` })
          );
          continue;
        }

        this._emit('agent:delegation', {
          from: { id, name: agent.name, project: agent.project || null },
          to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
          task: delegation.task
        });
        const createdTask = this.addTask(targetAgent.id, `[From ${agent.name}] ${delegation.task}`, agent.project || null, { type: 'agent', name: agent.name, id });

        const promise = this._enqueueAgentTask(targetAgent.id, async () => {
          // Mark task as in_progress
          if (createdTask) {
            const t = targetAgent.todoList.find(t => t.id === createdTask.id);
            if (t) {
              t.status = 'in_progress';
              t.startedAt = new Date().toISOString();
              saveAgent(targetAgent);
              this._emit('agent:updated', this._sanitize(targetAgent));
            }
          }

          // Notify leader's stream with a status marker (not raw sub-agent output)
          if (streamCallback) streamCallback(`\n\n--- \uD83D\uDCE8 Delegating to ${targetAgent.name} ---\n`);

          // Stream to the sub-agent's own chat via socket
          this._emit('agent:stream:start', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });

          const agentResponse = await this.sendMessage(
            targetAgent.id,
            `[TASK from ${agent.name}]: ${delegation.task}`,
            (chunk) => {
              // Stream to the sub-agent's own chat
              this._emit('agent:stream:chunk', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, chunk });
            },
            delegationDepth + 1,
            { type: 'delegation-task', fromAgent: agent.name }
          );

          // End sub-agent stream and notify leader
          this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null });
          if (streamCallback) streamCallback(`\n--- \u2705 ${targetAgent.name} finished ---\n`);
          this._emit('agent:updated', this._sanitize(targetAgent));

          if (createdTask) {
            const t = targetAgent.todoList.find(t => t.id === createdTask.id);
            if (t) {
              t.status = 'done';
              t.completedAt = new Date().toISOString();
              saveAgent(targetAgent);
              this._emit('agent:updated', this._sanitize(targetAgent));
            }
          }
          return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
        }).catch(err => {
          // End sub-agent stream on error too
          if (targetAgent?.id) this._emit('agent:stream:end', { agentId: targetAgent.id, agentName: targetAgent?.name || null, project: targetAgent?.project || null });
          // Mark task as error
          if (createdTask && targetAgent) {
            const t = targetAgent.todoList.find(t => t.id === createdTask.id);
            if (t) {
              t.errorFromStatus = t.status;
              t.status = 'error';
              t.error = err.message;
              t.completedAt = new Date().toISOString();
              saveAgent(targetAgent);
              this._emit('agent:updated', this._sanitize(targetAgent));
            }
          }
          return { agentId: targetAgent?.id, agentName: targetAgent?.name || delegation.agentName, project: targetAgent?.project || null, task: delegation.task, response: null, error: err.message };
        });

        delegationPromises.push(promise);
      }

      if (delegationPromises.length > 0) {
        console.log(`📨 [Delegation] Waiting for ${delegationPromises.length} queued delegation(s) to complete...`);
        // Wait for all enqueued delegations to finish (they run sequentially per agent)
        const delegationResults = await Promise.all(delegationPromises);

        // Notify the stream that delegation results are being processed
        if (streamCallback) {
          streamCallback(`\n\n--- Delegation complete, synthesizing results ---\n\n`);
        }

        // Feed delegation results back to leader and get synthesis (includes project info)
        const resultsSummary = delegationResults.map(r => {
          const projectTag = r.project ? ` [project: ${r.project}]` : '';
          const header = r.error
            ? `--- ⚠️ ERROR from ${r.agentName}${projectTag} ---`
            : `--- Response from ${r.agentName}${projectTag} ---`;
          return `${header}\n${r.response || r.error}`;
        }).join('\n\n');

        const hasErrors = delegationResults.some(r => r.error);
        const synthesisHint = hasErrors
          ? 'Some agents reported errors. Decide whether to retry, reassign, or adapt your plan accordingly.'
          : 'Please synthesize these results and continue with your plan. If more delegations are needed, use @delegate() commands. If the task is complete, provide the final response.';

        // Continue conversation with delegation results (increment depth)
        const synthesisResponse = await this.sendMessage(
          id,
          `[DELEGATION RESULTS]\n${resultsSummary}\n\n${synthesisHint}`,
          streamCallback,
          delegationDepth + 1,
          { type: 'delegation-result', delegationResults: delegationResults.map(r => ({ agentName: r.agentName, project: r.project || null, task: r.task, response: r.response, error: r.error })) }
        );
        return { earlyReturn: synthesisResponse };
      }
      // Leader nudge: leader described intent but didn't use @delegate()
      if (!isNudge && looksLikePurePlan && delegationPromises.length === 0 && responseForParsing.length > 20) {
        if (intentPatterns.test(responseForParsing)) {
          console.log(`🔄 [Nudge] Leader "${agent.name}" described intent but used no @delegate — nudging`);
          const nudgeResponse = await this.sendMessage(
            id,
            '[SYSTEM] You described what you plan to do but did not actually delegate or take action. Stop planning and ACT NOW. Use @delegate(AgentName, task) to assign work to agents. Do NOT explain what you will do — just do it.',
            streamCallback,
            delegationDepth,
            { type: 'nudge' }
          );
          return { earlyReturn: nudgeResponse };
        }
      }
    } else if (agent.isLeader && delegationDepth >= MAX_DELEGATION_DEPTH) {
      console.log(`⚠️ Max delegation depth (${MAX_DELEGATION_DEPTH}) reached for leader ${agent.name}`);
    }

    // ── Process @assign_project commands (for leader agents) ──────────
    if (agent.isLeader) {
      await this._processLeaderCommands(agent, id, responseForParsing, streamCallback);
    }

    // ── Rate limit detection: "You've hit your limit · resets 6am (Europe/Paris)" ──
    const rateLimitInfo = this._parseRateLimitReset(fullResponse);
    if (rateLimitInfo) {
      // Remove the rate-limit response from conversation history (it's not useful)
      agent.conversationHistory.pop();
      this.setStatus(id, 'idle');
      this.abortControllers.delete(id);
      if (isTopLevel) this._chatLocks.delete(id);
      // Schedule retry and throw so callers (task loop, transitions) can handle it
      const err = new Error(`Rate limit reached — resets at ${rateLimitInfo.resetLabel}`);
      err.isRateLimit = true;
      err.retryAt = rateLimitInfo.retryAt;
      err.resetLabel = rateLimitInfo.resetLabel;
      throw err;
    }

    return { earlyReturn: null };
  }

  // ─── Tool Execution ────────────────────────────────────────────────
  async _processToolCalls(agentId, response, streamCallback, depth = 0) {
    const agent = this.agents.get(agentId);
    if (!agent) return [];

    const toolCalls = parseToolCalls(response);
    
    console.log(`\n🔧 [Tools] Parsing response from "${agent.name}" (depth=${depth}, length=${response.length})`);
    
    if (toolCalls.length === 0) {
      // Log if we see tool-like patterns that didn't parse
      const rawCount = (response.match(/@(read_file|write_file|list_dir|search_files|run_command|append_file)/gi) || []).length;
      const tagCount = (response.match(/<tool_call>/gi) || []).length;
      if (rawCount > 0 || tagCount > 0) {
        console.warn(`⚠️  [Tools] Agent "${agent.name}": found ${rawCount} @tool mention(s) and ${tagCount} <tool_call> tag(s) but parseToolCalls returned 0 matches`);
        // Log lines containing tool patterns for debugging
        const lines = response.split('\n');
        const toolLines = lines
          .map((line, i) => ({ line, i }))
          .filter(({ line }) => /@(read_file|write_file|list_dir|search_files|run_command|append_file)/i.test(line) || /<tool_call>/i.test(line));
        for (const { line, i } of toolLines.slice(0, 5)) {
          console.warn(`   L${i + 1}: ${line.slice(0, 200)}`);
        }
      }
      return [];
    }
    
    console.log(`🔧 Agent ${agent.name} executing ${toolCalls.length} tool(s) (project=${agent.project || 'none'}, sandbox=${this.sandboxManager ? (this.sandboxManager.hasSandbox(agentId) ? 'ready' : 'not-initialized') : 'no-manager'})`);

    // Ensure sandbox container is running with the correct project (or workspace-only)
    if (this.sandboxManager) {
      try {
        if (agent.project) {
          const gitUrl = await getProjectGitUrl(agent.project);
          if (gitUrl) {
            await this.sandboxManager.ensureSandbox(agentId, agent.project, gitUrl);
          } else {
            console.warn(`⚠️  [Sandbox] No git URL found for project "${agent.project}" — sandbox will NOT be initialized`);
          }
        } else {
          // No project — ensure sandbox exists at workspace root (access to all projects)
          await this.sandboxManager.ensureSandbox(agentId);
        }
        console.log(`📦 [Sandbox] After ensureSandbox: hasSandbox=${this.sandboxManager.hasSandbox(agentId)}`);
      } catch (err) {
        console.error(`⚠️  [Sandbox] Failed to ensure sandbox for ${agent.name}:`, err.message);
      }
    }

    const results = [];
    for (const call of toolCalls) {
      // ── Handle @task_execution_complete() — signal task completion ──
      if (call.tool === 'task_execution_complete') {
        const comment = call.args[0] || '';
        // Search across ALL agents' todoLists (task may be on creator, not executor)
        let inProgressTask = null;
        for (const [, ownerAgent] of this.agents) {
          const found = ownerAgent.todoList?.find(t => t.status === 'in_progress' && t.assignee === agentId);
          if (found) { inProgressTask = found; break; }
        }
        // Fallback: check executor's own todoList
        if (!inProgressTask) {
          inProgressTask = agent.todoList?.find(t => t.status === 'in_progress');
        }
        if (inProgressTask) {
          inProgressTask._executionCompleted = true;
          inProgressTask._executionComment = comment;
          // Save the agent that owns the task
          for (const [, ownerAgent] of this.agents) {
            if (ownerAgent.todoList?.includes(inProgressTask)) {
              saveAgent(ownerAgent);
              break;
            }
          }
          console.log(`✅ [TaskComplete] Agent "${agent.name}" signaled completion: "${comment.slice(0, 120)}"`);
          if (streamCallback) {
            streamCallback(`\n✅ Task execution complete: ${comment.slice(0, 200)}\n`);
          }
          results.push({ tool: 'task_execution_complete', args: call.args, success: true, result: `Task "${inProgressTask.text.slice(0, 80)}" marked as execution complete. Comment: ${comment}` });
        } else {
          // No in_progress task — silently succeed (agent may call this in non-execute modes)
          console.log(`[TaskComplete] Agent "${agent.name}" called task_execution_complete but no in_progress task found — ignoring.`);
          results.push({ tool: 'task_execution_complete', args: call.args, success: true, result: 'No action needed (no in_progress task).' });
        }
        continue;
      }

      // ── Handle @report_error() specially ─────────────────────────────
      if (call.tool === 'report_error') {
        const errorDescription = call.args[0] || 'Unknown error';
        console.log(`🚨 [Error Report] Agent "${agent.name}" reports: ${errorDescription.slice(0, 200)}`);
        
        // Emit error report event for UI notifications
        this._emit('agent:error:report', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          description: errorDescription,
          timestamp: new Date().toISOString()
        });

        // Also push into stream so the user can see it inline
        if (streamCallback) {
          streamCallback(`\n\n🚨 **Error reported by ${agent.name}:** ${errorDescription}\n`);
        }

        results.push({
          tool: 'report_error',
          args: call.args,
          success: true,
          result: `Error reported: ${errorDescription}`,
          isErrorReport: true
        });
        continue;
      }

      // ── Handle @update_task() — update own task status ──────────────
      if (call.tool === 'update_task') {
        const [taskId, newStatus, details] = call.args;
        // Find the task (in this agent's todoList or across all agents if assigned)
        let task = agent.todoList?.find(t => t.id === taskId);
        if (!task) task = agent.todoList?.find(t => t.id.startsWith(taskId));
        let taskAgentId = id;
        // Also search across all agents (for tasks assigned to this agent but owned by another)
        if (!task) {
          for (const [creatorId, creatorAgent] of this.agents) {
            const found = creatorAgent.todoList?.find(t => t.id === taskId || t.id.startsWith(taskId));
            if (found && (found.assignee === id || creatorId === id)) {
              task = found;
              taskAgentId = creatorId;
              break;
            }
          }
        }
        if (!task) {
          const partial = agent.todoList?.find(t => t.id.startsWith(taskId.slice(0, 8)));
          const hint = partial ? ` Maybe you meant ${partial.id.slice(0, 8)} which is currently "${partial.status}"?` : '';
          results.push({ tool: 'update_task', args: call.args, success: false, error: `Task not found: ${taskId}.${hint}` });
          continue;
        }
        // Append details to the task description if provided
        if (details && details.trim()) {
          const separator = '\n\n---\n';
          const detailBlock = `**[${agent.name}]** ${details.trim()}`;
          task.text = (task.text || '') + separator + detailBlock;
          if (!task.history) task.history = [];
          task.history.push({
            status: task.status,
            at: new Date().toISOString(),
            by: agent.name,
            type: 'edit',
            field: 'text',
            oldValue: null,
            newValue: detailBlock,
          });
        }
        // Use setTaskStatus for proper history tracking and workflow triggers
        const updated = this.setTaskStatus(taskAgentId, task.id, newStatus, { skipAutoRefine: false, by: agent.name });
        if (!updated) {
          results.push({ tool: 'update_task', args: call.args, success: false, error: `Cannot move task to "${newStatus}" (blocked by guard or same status).` });
          continue;
        }
        console.log(`📋 [Task] Agent "${agent.name}" updated task "${task.text.slice(0, 50)}" → ${newStatus}${details ? ' (with details)' : ''}`);
        results.push({ tool: 'update_task', args: call.args, success: true, result: `Task "${task.text.slice(0, 60)}" updated to ${newStatus}${details ? ' with details appended' : ''}` });
        continue;
      }

      // ── Handle @link_commit() — associate a commit with a task ─────
      if (call.tool === 'link_commit') {
        const [taskId, commitHash, commitMsg] = call.args;
        if (!taskId || !commitHash) {
          results.push({ tool: 'link_commit', args: call.args, success: false, error: 'Usage: @link_commit(taskId, commitHash, optionalMessage)' });
          continue;
        }
        // Search across ALL agents' todoLists (tasks may be in a different agent's list when auto-assigned)
        let task = null;
        let ownerAgentId = agentId;
        for (const [creatorId, creatorAgent] of this.agents) {
          if (!creatorAgent.todoList) continue;
          const found = creatorAgent.todoList.find(t => t.id === taskId) ||
                        creatorAgent.todoList.find(t => t.id.startsWith(taskId));
          if (found) { task = found; ownerAgentId = creatorId; break; }
        }
        if (!task) {
          // Partial match hint from the executing agent's own list
          const partial = agent.todoList?.find(t => t.id.startsWith(taskId.slice(0, 8)));
          const hint = partial ? ` Maybe you meant ${partial.id.slice(0, 8)} which is currently "${partial.status}"?` : '';
          results.push({ tool: 'link_commit', args: call.args, success: false, error: `Task not found: ${taskId}.${hint}` });
          continue;
        }
        this.addTaskCommit(ownerAgentId, task.id, commitHash, commitMsg || '');
        console.log(`🔗 [Commit] Agent "${agent.name}" linked ${commitHash.slice(0, 7)} to task "${task.text.slice(0, 50)}"`);
        results.push({ tool: 'link_commit', args: call.args, success: true, result: `Commit ${commitHash.slice(0, 7)} linked to task "${task.text.slice(0, 60)}"` });
        continue;
      }

      // ── Handle @list_projects() — list available projects ───────────
      if (call.tool === 'list_projects') {
        const projects = await this._listAvailableProjects();
        if (projects.length === 0) {
          results.push({ tool: 'list_projects', args: [], success: true, result: 'No projects found.' });
        } else {
          results.push({ tool: 'list_projects', args: [], success: true, result: `Available projects:\n${projects.join('\n')}` });
        }
        continue;
      }

      // ── Handle @list_my_tasks() — list agent's own tasks ────────────
      if (call.tool === 'list_my_tasks') {
        const tasks = agent.todoList || [];
        const header = `Agent: ${agent.name} | Project: ${agent.project || 'none'} | Status: ${agent.status}`;
        if (tasks.length === 0) {
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: `${header}\nNo tasks assigned.` });
        } else {
          const statusIcons = { pending: '[ ]', in_progress: '[~]', done: '[x]', error: '[!]' };
          const lines = tasks.map(t => `${statusIcons[t.status] || '[ ]'} ${t.id} — ${t.text}`);
          results.push({ tool: 'list_my_tasks', args: [], success: true, result: `${header}\n${lines.join('\n')}` });
        }
        continue;
      }

      // ── Handle @check_status() — agent checks its own detailed status ─
      if (call.tool === 'check_status') {
        const todoList = agent.todoList || [];
        const pendingTasks = todoList.filter(t => t.status === 'pending').length;
        const inProgressTasks = todoList.filter(t => t.status === 'in_progress').length;
        const doneTasks = todoList.filter(t => t.status === 'done').length;
        const errorTasks = todoList.filter(t => t.status === 'error').length;
        const totalTasks = todoList.length;
        const msgCount = (agent.conversationHistory || []).length;
        const hasSandbox = this.sandboxManager ? this.sandboxManager.hasSandbox(agent.id) : false;
        const inProgressTask = todoList.find(t => t.status === 'in_progress');
        const currentTaskInfo = agent.currentTask
          ? agent.currentTask.slice(0, 120)
          : inProgressTask
            ? inProgressTask.text.slice(0, 120)
            : 'none';
        const projectAssignedAt = agent.projectChangedAt
          ? new Date(agent.projectChangedAt).toLocaleString()
          : 'n/a';
        const projectDurationMs = agent.project && agent.projectChangedAt
          ? Date.now() - new Date(agent.projectChangedAt).getTime()
          : null;
        const projectDuration = AgentManager.formatDuration(projectDurationMs);

        const lines = [
          `Name: ${agent.name}`,
          `Status: ${agent.status}`,
          `Role: ${agent.role || 'worker'}`,
          `Project: ${agent.project || 'none'}${agent.project ? ` (assigned ${projectAssignedAt}, duration: ${projectDuration})` : ''}`,
          `Current task: ${currentTaskInfo}`,
          `Provider: ${agent.provider || 'unknown'}/${agent.model || 'unknown'}`,
          `Sandbox: ${hasSandbox ? 'running' : 'not running'}`,
          `Tasks: ${inProgressTasks} in-progress, ${pendingTasks} pending, ${doneTasks} done, ${errorTasks} error / ${totalTasks} total`,
          `Messages: ${msgCount}`,
          `Last active: ${agent.metrics?.lastActiveAt || 'never'}`,
          `Errors: ${agent.metrics?.errors || 0}`,
        ];
        // Show active task details
        const activeTasks = todoList.filter(t => t.status === 'in_progress' || t.status === 'pending' || t.status === 'error');
        if (activeTasks.length > 0) {
          lines.push(`Active tasks:`);
          for (const t of activeTasks.slice(0, 10)) {
            const mark = t.status === 'in_progress' ? '~' : t.status === 'error' ? '!' : ' ';
            lines.push(`  [${mark}] ${t.text.slice(0, 100)}${t.text.length > 100 ? '...' : ''}`);
          }
          if (activeTasks.length > 10) lines.push(`  ... and ${activeTasks.length - 10} more`);
        }

        console.log(`📊 [Check Status] Agent "${agent.name}": ${agent.status} | project=${agent.project || 'none'} | task=${currentTaskInfo}`);
        results.push({ tool: 'check_status', args: [], success: true, result: lines.join('\n') });
        continue;
      }

      // ── Handle @mcp_call() — delegate to MCP server ────────────────
      if (call.tool === 'mcp_call') {
        const [serverName, toolName, argsJson] = call.args;

        // Validate server and tool names are not empty
        if (!serverName || !serverName.trim()) {
          const errMsg = 'MCP call requires a server name. Use: @mcp_call(ServerName, tool_name, {"arg": "value"})';
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: errMsg });
          continue;
        }
        if (!toolName || !toolName.trim()) {
          const errMsg = 'MCP call requires a tool name. Use: @mcp_call(ServerName, tool_name, {"arg": "value"})';
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: errMsg });
          continue;
        }

        const mcpLabel = `MCP: ${serverName} → ${toolName}`;
        agent.currentThinking = mcpLabel;
        this._emit('agent:thinking', { agentId, thinking: mcpLabel });
        this._emit('agent:tool:start', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args });

        try {
          let parsedArgs;
          if (typeof argsJson === 'string') {
            // Pre-process: remove ellipsis patterns that LLMs sometimes add
            let raw = argsJson.trim();
            raw = raw.replace(/,?\s*\.{3}\s*/g, '');  // Remove ... or , ...

            try {
              parsedArgs = JSON.parse(raw);
            } catch {
              // Attempt to repair common JSON issues from LLM output
              let fixed = raw;
              // Fix unquoted keys: {key: "value"} → {"key": "value"}
              fixed = fixed.replace(/([{,])\s*([a-zA-Z_]\w*)\s*:/g, '$1"$2":');
              // Fix trailing commas: {"a": 1,} → {"a": 1}
              fixed = fixed.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
              // Fix single-quoted strings: {'key': 'value'} → {"key": "value"}
              fixed = fixed.replace(/'/g, '"');
              try {
                parsedArgs = JSON.parse(fixed);
                console.log(`🔧 [MCP] Repaired malformed JSON for ${toolName}: ${argsJson.slice(0, 100)}`);
              } catch (e2) {
                throw new Error(`Invalid JSON arguments for ${toolName}: ${e2.message}. Received: ${argsJson.slice(0, 200)}`);
              }
            }

            // Detect schema-as-arguments: LLM copied the schema definition instead of passing real values
            // Schema values look like {"param": {"title": "...", "type": "..."}} or {"param": "<string, required>"}
            const vals = Object.values(parsedArgs);
            const looksLikeSchema = vals.length > 0 && vals.every(v =>
              (typeof v === 'object' && v !== null && ('type' in v || 'title' in v || 'anyOf' in v)) ||
              (typeof v === 'string' && /^<[^>]+>$/.test(v))
            );
            if (looksLikeSchema) {
              // Extract just the parameter names so the agent knows what to fill in
              const paramNames = Object.keys(parsedArgs);
              throw new Error(
                `You passed the schema definition instead of actual values. ` +
                `Do NOT copy the type descriptions — pass real values. ` +
                `Example: @mcp_call(${serverName}, ${toolName}, {${paramNames.map(p => `"${p}": "actual-value-here"`).join(', ')}})`
              );
            }
          } else {
            parsedArgs = argsJson || {};
          }
          const mcpResult = await this.mcpManager.callToolByNameForAgent(serverName, toolName, parsedArgs, agentId, agent.mcpAuth || {});

          if (streamCallback) {
            const icon = mcpResult.success ? '✓' : '✗';
            streamCallback(`\n${icon} ${mcpLabel}\n`);
          }

          results.push({ tool: 'mcp_call', args: call.args, ...mcpResult });
          this._emit('agent:tool:result', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', args: call.args, success: mcpResult.success, preview: (mcpResult.result || '').slice(0, 300) });
        } catch (mcpErr) {
          console.error(`❌ [MCP] Agent "${agent.name}" mcp_call failed: ${mcpErr.message}`);
          if (streamCallback) streamCallback(`\n✗ ${mcpLabel}: ${mcpErr.message}\n`);
          results.push({ tool: 'mcp_call', args: call.args, success: false, error: mcpErr.message });
          this._emit('agent:tool:error', { agentId, agentName: agent.name, project: agent.project || null, tool: 'mcp_call', error: mcpErr.message });
        }
        continue;
      }

      try {
        // Update thinking indicator with a descriptive message showing file paths
        const toolLabels = {
          write_file: (a) => `Writing ${a[0] || ''}`,
          append_file: (a) => `Appending to ${a[0] || ''}`,
          read_file: (a) => `Reading ${a[0] || ''}`,
          list_dir: (a) => `Listing ${a[0] || '.'}`,
          search_files: (a) => `Searching ${a[0] || '*'} for "${a[1] || ''}"`,
          run_command: (a) => `Running: ${(a[0] || '').slice(0, 80)}`,
        };
        const labelFn = toolLabels[call.tool];
        const toolLabel = labelFn ? labelFn(call.args) : `@${call.tool}`;
        agent.currentThinking = toolLabel;
        this._emit('agent:thinking', { agentId, thinking: agent.currentThinking });

        // Emit structured tool-start event (not raw text into stream)
        this._emit('agent:tool:start', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          tool: call.tool,
          args: call.args
        });

        const result = await executeTool(call.tool, call.args, agent.project, this.sandboxManager, agentId);

        // Auto-capture commit hash from git_commit_push or run_command(git commit) and link to task
        if (call.tool === 'git_commit_push' || (call.tool === 'run_command' && result.success)) {
          let commitHash = null;
          let commitMsg = '';

          if (call.tool === 'git_commit_push') {
            commitHash = result.meta?.commitHash || null;
            commitMsg = call.args[0] || '';
          }
          // Extract hash from output (works for both git_commit_push and run_command)
          if (!commitHash && typeof result.result === 'string') {
            const rawCmd = (call.args[0] || '').toLowerCase();
            const isGitCommit = call.tool === 'git_commit_push' ||
              (rawCmd.includes('git') && (rawCmd.includes('commit') || rawCmd.includes('push')));
            if (isGitCommit) {
              const commitMatch = result.result.match(/\[[^\]]*\s([a-f0-9]{7,40})\]/);
              if (commitMatch) commitHash = commitMatch[1];
              if (!commitMsg) commitMsg = call.args[0] || '';
            }
          }

          if (commitHash) {
            // Search ALL agents' todoLists for tasks assigned to or owned by this agent.
            // Tasks may live in a different agent's list when auto-assigned via workflow boards.
            const found = this._findTaskForCommitLink(agentId);
            let targetTask = found?.task || null;
            let ownerAgentId = found?.ownerAgentId || agentId;

            if (!targetTask) {
              // No task found anywhere — create one from agent.currentTask
              const taskText = agent.currentTask || commitMsg || 'Commit without task';
              const created = this.addTask(agentId, taskText, agent.project || null, { type: 'auto', reason: 'commit-link' }, 'in_progress');
              if (created) {
                targetTask = agent.todoList.find(t => t.id === created.id);
                ownerAgentId = agentId;
                console.log(`🔗 [Commit] Auto-created task "${taskText.slice(0, 50)}" for commit linking`);
              }
            }

            if (targetTask) {
              const linked = this.addTaskCommit(ownerAgentId, targetTask.id, commitHash, commitMsg);
              if (linked) {
                console.log(`🔗 [Commit] Auto-linked ${commitHash.slice(0, 7)} to task "${targetTask.text?.slice(0, 50)}" (status=${targetTask.status}, owner=${ownerAgentId.slice(0, 8)})`);
                result.result = `${result.result}\n\n🔗 Commit ${commitHash.slice(0, 8)} automatically linked to task "${targetTask.text?.slice(0, 60)}"`;
              } else {
                console.warn(`⚠️  [Commit] addTaskCommit failed for ${commitHash.slice(0, 7)} → task "${targetTask.text?.slice(0, 50)}"`);
                result.result = `${result.result}\n\n⚠️ Auto-linking failed. Try: @link_commit(${targetTask.id}, ${commitHash}, ${commitMsg.slice(0, 60)})`;
              }
            } else {
              // No task found — provide agent with real task IDs for manual linking
              const agentTasks = [];
              for (const [, ownerAg] of this.agents) {
                if (!ownerAg.todoList) continue;
                for (const t of ownerAg.todoList) {
                  if (t.assignee === agentId || ownerAg.id === agentId) {
                    agentTasks.push(t);
                  }
                }
              }
              if (agentTasks.length > 0) {
                const taskList = agentTasks.slice(0, 5).map(t => 
                  `  - @link_commit(${t.id}, ${commitHash}, ${commitMsg.slice(0, 60)})  → [${t.status}] ${t.text?.slice(0, 50)}`
                ).join('\n');
                console.warn(`⚠️  [Commit] Agent "${agent.name}" committed ${commitHash.slice(0, 7)} but no in_progress task found. Available tasks:\n${taskList}`);
                result.result = `${result.result}\n\n⚠️ Commit ${commitHash.slice(0, 8)} was not auto-linked (no in_progress task). Link it manually:\n${taskList}`;
              } else {
                console.warn(`⚠️  [Commit] Agent "${agent.name}" committed ${commitHash.slice(0, 7)} but has no tasks at all`);
                result.result = `${result.result}\n\n⚠️ Commit ${commitHash.slice(0, 8)} was not linked — no tasks found for this agent.`;
              }
            }
          } else if (call.tool === 'git_commit_push' && result.success) {
            console.warn(`⚠️  [Commit] Agent "${agent.name}" git_commit_push succeeded but could not extract commit hash from output`);
          }

          // Auto-complete task after successful git_commit_push
          if (call.tool === 'git_commit_push' && result.success) {
            let inProgressTask = null;
            let taskOwnerAgent = null;
            // Search across ALL agents' todoLists (task may be on creator, not executor)
            for (const [, ownerAg] of this.agents) {
              const found = ownerAg.todoList?.find(t => t.status === 'in_progress' && t.assignee === agentId);
              if (found) { inProgressTask = found; taskOwnerAgent = ownerAg; break; }
            }
            // Fallback: check executor's own todoList
            if (!inProgressTask) {
              inProgressTask = agent.todoList?.find(t => t.status === 'in_progress');
              if (inProgressTask) taskOwnerAgent = agent;
            }
            if (inProgressTask) {
              const autoComment = commitMsg || 'Completed (auto-closed after successful git push)';
              inProgressTask._executionCompleted = true;
              inProgressTask._executionComment = autoComment;
              if (taskOwnerAgent) saveAgent(taskOwnerAgent);
              console.log(`✅ [AutoComplete] Agent "${agent.name}" git_commit_push → auto-completing task "${inProgressTask.text?.slice(0, 80)}"`);
              if (streamCallback) {
                streamCallback(`\n✅ Task auto-completed after successful commit & push.\n`);
              }
              result.result = `${result.result}\n\n✅ Task automatically marked as complete.`;
            }
          }
        }

        results.push({ tool: call.tool, args: call.args, ...result });

        // Stream a one-liner per tool execution into the chat
        if (streamCallback) {
          const statusIcon = result.success ? '✓' : '✗';
          streamCallback(`\n${statusIcon} ${toolLabel}\n`);
        }

        if (result.success) {
          // Emit structured tool-result event
          this._emit('agent:tool:result', {
            agentId,
            agentName: agent.name,
            project: agent.project || null,
            tool: call.tool,
            args: call.args,
            success: true,
            preview: result.result.slice(0, 300)
          });
        } else {
          // ── Tool returned an error ─────────────────────────────────
          console.warn(`⚠️  [Tool Error] Agent "${agent.name}" — @${call.tool}(${(call.args[0] || '').slice(0, 80)}): ${result.error}`);
          
          this._emit('agent:tool:error', {
            agentId,
            agentName: agent.name,
            project: agent.project || null,
            tool: call.tool,
            args: call.args,
            error: result.error || 'Unknown error',
            output: result.result || null,
            timestamp: new Date().toISOString()
          });

          // Push error visibly into the stream (include actual output when available)
          if (streamCallback) {
            const outputSnippet = result.result ? `\n\`\`\`\n${result.result.slice(0, 500)}\n\`\`\`` : '';
            streamCallback(`\n\n⚠️ **Tool error** \`@${call.tool}(${(call.args[0] || '').slice(0, 100)})\`: ${result.error}${outputSnippet}\n`);
          }
        }
      } catch (err) {
        console.error(`❌ [Tool Crash] Agent "${agent.name}" — @${call.tool}: ${err.message}`);
        
        results.push({
          tool: call.tool,
          args: call.args,
          success: false,
          error: err.message
        });
        
        this._emit('agent:tool:error', {
          agentId,
          agentName: agent.name,
          project: agent.project || null,
          tool: call.tool,
          args: call.args,
          error: err.message,
          timestamp: new Date().toISOString()
        });

        if (streamCallback) {
          streamCallback(`\n\n❌ **Tool crashed** \`@${call.tool}(${(call.args[0] || '').slice(0, 100)})\`: ${err.message}\n`);
        }
      }
    }

    return results;
  }

  // ─── Delegation Processing (for Leader agents) ────────────────────

  /**
   * Pure parser: extract all complete @delegate(Agent, "task") commands from text.
   * Returns array of { agentName, task }.
   */
  _parseDelegations(text) {
    // Build code-block ranges to skip @delegate inside examples/docs
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const delegations = [];
    const delegateRe = /@delegate\s*\(/gi;
    let reMatch;
    while ((reMatch = delegateRe.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const agentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let taskContent = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          taskContent += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quoteChar) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (j < text.length && text[j] === ')') {
            found = true;
            break;
          }
          taskContent += text[i];
          i++;
          continue;
        }
        taskContent += text[i];
        i++;
      }

      if (found && agentName && taskContent.trim()) {
        delegations.push({ agentName, task: taskContent.trim() });
      }
    }
    return delegations;
  }

  /**
   * Parse @assign_project(AgentName, "project_name") commands from leader output.
   * Returns array of { targetAgentName, projectName }.
   */
  _parseProjectAssignments(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const assignments = [];
    const re = /@assign_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let projectName = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          projectName += text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quoteChar) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (j < text.length && text[j] === ')') {
            found = true;
            break;
          }
          projectName += text[i];
          i++;
          continue;
        }
        projectName += text[i];
        i++;
      }

      if (found && targetAgentName && projectName.trim()) {
        assignments.push({ targetAgentName, projectName: projectName.trim() });
      }
    }
    return assignments;
  }

  /**
   * Parse @get_project(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseGetProject(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@get_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @clear_context(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseClearContext(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@clear_context\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @agent_status(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseAgentStatus(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@agent_status\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @get_available_agent(role) commands from leader output.
   * Returns array of { role }.
   */
  _parseGetAvailableAgent(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@get_available_agent\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const role = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (role) {
        results.push({ role });
      }
    }
    return results;
  }

  /**
   * Parse @agents_on_project(projectName) commands from leader output.
   * Returns array of { projectName }.
   */
  _parseAgentsOnProject(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@agents_on_project\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const projectName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (projectName) {
        results.push({ projectName });
      }
    }
    return results;
  }

  /**
   * Parse @ask(AgentName, "question") commands from any agent's output.
   * Returns array of { agentName, question }.
   */
  _parseAskCommands(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const asks = [];
    const askRe = /@ask\s*\(/gi;
    let reMatch;
    while ((reMatch = askRe.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;

      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const agentName = text.slice(startAfterParen, commaIdx).trim();

      let i = commaIdx + 1;
      while (i < text.length && /\s/.test(text[i])) i++;
      const quoteChar = text[i];
      if (quoteChar !== '"' && quoteChar !== "'") continue;
      i++;

      let questionContent = '';
      let found = false;
      while (i < text.length) {
        if (text[i] === '\\' && i + 1 < text.length) {
          questionContent += text[i] + text[i + 1];
          i += 2;
          continue;
        }
        if (text[i] === quoteChar) {
          let j = i + 1;
          while (j < text.length && /\s/.test(text[j])) j++;
          if (j < text.length && text[j] === ')') {
            found = true;
            break;
          }
          questionContent += text[i];
          i++;
          continue;
        }
        questionContent += text[i];
        i++;
      }

      if (found && agentName && questionContent.trim()) {
        asks.push({ agentName, question: questionContent.trim() });
      }
    }
    return asks;
  }

  /**
   * Parse @stop_agent(AgentName) commands from leader output.
   * Returns array of { targetAgentName }.
   */
  _parseStopAgent(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@stop_agent\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const closeIdx = text.indexOf(')', startAfterParen);
      if (closeIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, closeIdx).trim().replace(/^["']|["']$/g, '');
      if (targetAgentName) {
        results.push({ targetAgentName });
      }
    }
    return results;
  }

  /**
   * Parse @rollback(AgentName, X) commands from leader output.
   * Returns array of { targetAgentName, count }.
   */
  _parseRollback(text) {
    const codeBlockRanges = [];
    const cbRe = /```[\s\S]*?```|`[^`]*`/g;
    let cbMatch;
    while ((cbMatch = cbRe.exec(text)) !== null) {
      codeBlockRanges.push({ start: cbMatch.index, end: cbMatch.index + cbMatch[0].length });
    }
    const isInsideCodeBlock = (pos) => codeBlockRanges.some(r => pos >= r.start && pos < r.end);

    const results = [];
    const re = /@rollback\s*\(/gi;
    let reMatch;
    while ((reMatch = re.exec(text)) !== null) {
      if (isInsideCodeBlock(reMatch.index)) continue;
      const startAfterParen = reMatch.index + reMatch[0].length;
      const commaIdx = text.indexOf(',', startAfterParen);
      if (commaIdx === -1) continue;
      const targetAgentName = text.slice(startAfterParen, commaIdx).trim().replace(/^["']|["']$/g, '');
      const closeIdx = text.indexOf(')', commaIdx + 1);
      if (closeIdx === -1) continue;
      const countStr = text.slice(commaIdx + 1, closeIdx).trim();
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count <= 0) continue;
      if (targetAgentName) {
        results.push({ targetAgentName, count });
      }
    }
    return results;
  }

  /**
   * List available project directories (same logic as projects.js route).
   */
  async _listAvailableProjects() {
    try {
      const repos = await listStarredRepos();
      return repos.map(r => r.name).sort();
    } catch {
      return [];
    }
  }

  /**
   * Execute a single delegation: find target agent, create task, send message, mark done.
   * Returns { agentId, agentName, task, response, error }.
   */
  async _executeSingleDelegation(leaderId, delegation, streamCallback, delegationDepth) {
    const leader = this.agents.get(leaderId);
    const targetAgent = Array.from(this.agents.values()).find(
      a => a.name.toLowerCase() === delegation.agentName.toLowerCase() && a.id !== leaderId
    );

    if (!targetAgent) {
      console.log(`⚠️  Agent "${delegation.agentName}" not found in swarm`);
      if (streamCallback) streamCallback(`\n⚠️ Agent "${delegation.agentName}" not found in swarm\n`);
      return { agentName: delegation.agentName, response: null, error: `Agent "${delegation.agentName}" not found in swarm` };
    }

    try {
      console.log(`📨 Delegating to ${targetAgent.name}: ${delegation.task.slice(0, 80)}...`);
      if (streamCallback) streamCallback(`\n\n--- 📨 Delegating to ${targetAgent.name} ---\n`);

      this._emit('agent:delegation', {
        from: { id: leaderId, name: leader.name, project: leader.project || null },
        to: { id: targetAgent.id, name: targetAgent.name, project: targetAgent.project || null },
        task: delegation.task
      });

      const createdTask = this.addTask(targetAgent.id, `[From ${leader.name}] ${delegation.task}`, leader.project || null, { type: 'agent', name: leader.name, id: leaderId });

      // Mark task as in_progress
      if (createdTask) {
        const t = targetAgent.todoList.find(t => t.id === createdTask.id);
        if (t) {
          t.status = 'in_progress';
          t.startedAt = new Date().toISOString();
          saveAgent(targetAgent);
          this._emit('agent:updated', this._sanitize(targetAgent));
        }
      }

      let delegateStreamStarted = false;
      const agentResponse = await this.sendMessage(
        targetAgent.id,
        `[TASK from ${leader.name}]: ${delegation.task}`,
        (chunk) => {
          if (streamCallback) {
            if (!delegateStreamStarted) {
              delegateStreamStarted = true;
              streamCallback(`\n**[${targetAgent.name}]:**\n`);
            }
            streamCallback(chunk);
          }
        },
        delegationDepth + 1,
        { type: 'delegation-task', fromAgent: leader.name }
      );

      if (createdTask) {
        const t = targetAgent.todoList.find(t => t.id === createdTask.id);
        if (t) {
          t.status = 'done';
          t.completedAt = new Date().toISOString();
          saveAgent(targetAgent);
          this._emit('agent:updated', this._sanitize(targetAgent));
        }
      }

      return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: agentResponse, error: null };
    } catch (err) {
      return { agentId: targetAgent.id, agentName: targetAgent.name, project: targetAgent.project || null, task: delegation.task, response: null, error: err.message };
    }
  }

  // ─── Global Broadcast (tmux-style) ─────────────────────────────────
  async broadcastMessage(message, streamCallback, agentIdFilter = null) {
    let agents = Array.from(this.agents.values()).filter(a => a.enabled !== false);
    if (agentIdFilter) {
      agents = agents.filter(a => agentIdFilter.has(a.id));
    }
    const results = [];

    const promises = agents.map(async (agent) => {
      try {
        const response = await this.sendMessage(
          agent.id,
          message,
          (chunk) => streamCallback && streamCallback(agent.id, chunk)
        );
        results.push({ agentId: agent.id, agentName: agent.name, response, error: null });
      } catch (err) {
        results.push({ agentId: agent.id, agentName: agent.name, response: null, error: err.message });
      }
    });

    await Promise.all(promises);
    return results;
  }

  // ─── Handoff ────────────────────────────────────────────────────────
  async handoff(fromId, toId, context, streamCallback) {
    const fromAgent = this.agents.get(fromId);
    const toAgent = this.agents.get(toId);
    if (!fromAgent || !toAgent) throw new Error('Agent not found');

    const handoffMessage = `[HANDOFF from ${fromAgent.name}]: ${context}\n\nPrevious conversation context:\n${
      fromAgent.conversationHistory.slice(-10).map(m => `${m.role}: ${m.content}`).join('\n')
    }`;

    this._emit('agent:handoff', {
      from: { id: fromId, name: fromAgent.name, project: fromAgent.project || null },
      to: { id: toId, name: toAgent.name, project: toAgent.project || null },
      context
    });

    // File system transfer between agents
    const fileTransferResult = await transferUserFiles(fromId, toId);

    const response = await this.sendMessage(toId, handoffMessage, streamCallback);

    return {
      ...response,
      fileTransfer: fileTransferResult
    };
  }

  // ─── Action Logs ──────────────────────────────────────────────────
  static MAX_ACTION_LOGS = 200;

  addActionLog(agentId, type, message, errorDetail = null) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const now = new Date();

    // Compute duration for the previous log entry (how long that state lasted)
    if (agent.actionLogs.length > 0) {
      const lastLog = agent.actionLogs[agent.actionLogs.length - 1];
      if (!lastLog.durationMs) {
        lastLog.durationMs = now.getTime() - new Date(lastLog.timestamp).getTime();
      }
    }

    const entry = {
      id: uuidv4(),
      type,
      message,
      error: errorDetail,
      timestamp: now.toISOString()
    };

    agent.actionLogs.push(entry);
    if (agent.actionLogs.length > AgentManager.MAX_ACTION_LOGS) {
      agent.actionLogs = agent.actionLogs.slice(-AgentManager.MAX_ACTION_LOGS);
    }

    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return entry;
  }

  clearActionLogs(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.actionLogs = [];
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Execution Log ──────────────────────────────────────────────────
  /**
   * Save the conversation that happened during a task execution into the task history.
   * Called after sendMessage completes (or errors) for a task execution.
   *
   * @param {string} creatorAgentId - The agent that owns the todoList
   * @param {string} taskId - The task ID
   * @param {string} executorId - The agent that actually executed the task
   * @param {number} startMsgIdx - The conversationHistory index before execution started
   * @param {string} startedAt - ISO timestamp when execution started
   * @param {boolean} success - Whether the execution completed successfully
   */
  _saveExecutionLog(creatorAgentId, taskId, executorId, startMsgIdx, startedAt, success = true, actionMode = 'execute') {
    const executor = this.agents.get(executorId);
    const creatorAgent = this.agents.get(creatorAgentId);
    if (!executor || !creatorAgent) return;

    const task = creatorAgent.todoList.find(t => t.id === taskId);
    if (!task) return;

    // Extract conversation messages since execution started
    const rawMessages = executor.conversationHistory.slice(startMsgIdx);

    // Truncate long message contents to keep storage reasonable
    const MAX_MSG_LENGTH = 5000;
    const executionMessages = rawMessages.map(m => ({
      role: m.role,
      content: (m.content || '').length > MAX_MSG_LENGTH
        ? m.content.slice(0, MAX_MSG_LENGTH) + '\n\n... (truncated)'
        : m.content,
      timestamp: m.timestamp,
    }));

    if (!task.history) task.history = [];
    task.history.push({
      type: 'execution',
      mode: actionMode,
      at: new Date().toISOString(),
      by: executor.name,
      startedAt,
      success,
      messages: executionMessages,
    });

    saveAgent(creatorAgent);
    this._emit('agent:updated', this._sanitize(creatorAgent));
  }

  // ─── Workflow Auto-Refine ───────────────────────────────────────────
  /** Evaluate a condition against the current task/agent state.
   *  Always re-fetches the agent from the live agents map to ensure
   *  real-time status (avoids stale closures or cached references). */
  _evaluateCondition(cond, task) {
    // Re-fetch assignee from the live map every time — never rely on a cached reference
    const assigneeAgent = task.assignee ? this.agents.get(task.assignee) : null;
    let fieldValue;
    switch (cond.field) {
      // Legacy owner fields — DEPRECATED, mapped to assignee for backward compat
      // Use assignee_status / assignee_enabled instead
      case 'creator_status': case 'owner_status': fieldValue = assigneeAgent?.status || 'none'; break;
      case 'creator_enabled': case 'owner_enabled': fieldValue = assigneeAgent ? (assigneeAgent.enabled !== false ? 'true' : 'false') : 'false'; break;
      case 'assignee_status': fieldValue = assigneeAgent?.status || 'none'; break;
      case 'assignee_enabled': fieldValue = assigneeAgent ? (assigneeAgent.enabled !== false ? 'true' : 'false') : 'false'; break;
      case 'assignee_role': fieldValue = assigneeAgent?.role || ''; break;
      case 'task_has_assignee': fieldValue = task.assignee ? 'true' : 'false'; break;
      case 'idle_agent_available': {
        // Check if any idle+enabled agent with the given role exists
        const role = cond.value;
        const found = [...this.agents.values()].some(a =>
          a.status === 'idle' && a.enabled !== false && (!role || a.role === role)
        );
        fieldValue = found ? 'true' : 'false';
        const result = cond.operator === 'neq' ? !found : found;
        console.log(`[Workflow] Condition: idle_agent_available role="${role}" project="${task.project}" => ${result}`);
        return result;
      }
      default: fieldValue = '';
    }
    const result = cond.operator === 'neq' ? fieldValue !== cond.value : fieldValue === cond.value;
    console.log(`[Workflow] Condition: ${cond.field} ${cond.operator} "${cond.value}" => fieldValue="${fieldValue}" result=${result} (assignee=${task.assignee || 'none'}, agentName=${assigneeAgent?.name || 'N/A'}, agentStatus=${assigneeAgent?.status || 'N/A'})`);
    return result;
  }

  /** Check if an agent currently has an in_progress task (as creator or assignee) */
  agentHasActiveTask(agentId) {
    for (const [creatorId, agent] of this.agents) {
      if (!agent.todoList) continue;
      for (const task of agent.todoList) {
        if (task.status !== 'in_progress') continue;
        // Task was created by this agent
        if (creatorId === agentId) return true;
        // Task is assigned to this agent
        if (task.assignee === agentId) return true;
      }
    }
    return false;
  }

  /** Migrate old transition format to new trigger+actions format */
  /** Validate a transition has the required new format fields */
  _validTransition(t) {
    return t && t.from && t.trigger && Array.isArray(t.actions);
  }

  _checkAutoRefine(task, { by = null } = {}) {
    // Fire-and-forget: check if there's an autoRefine transition for this status
    console.log(`[Workflow] _checkAutoRefine: status="${task.status}" text="${(task.text || '').slice(0, 60)}" agentId="${task.agentId}" by="${by || 'unknown'}"`);

    // ── Guard: never auto-transition tasks in error status ──
    if (task.status === 'error') {
      console.log(`[Workflow] _checkAutoRefine: skipping — task is in error status`);
      return;
    }

    getWorkflowForBoard(task.boardId).then(async (workflow) => {
      // Determine the owner: prefer board owner, fallback to creator agent's owner
      const creatorAgentForOwner = this.agents.get(task.agentId);
      const boardUserId = workflow.userId || null;
      const taskOwnerId = boardUserId || creatorAgentForOwner?.ownerId || null;

      // ── Auto-assign by column role (independent of transitions) ──
      const currentColumn = workflow.columns?.find(c => c.id === task.status);
      const colIndex = workflow.columns?.findIndex(c => c.id === task.status) ?? -1;
      const isFirstOrLast = colIndex === 0 || colIndex === (workflow.columns?.length || 0) - 1;
      if (currentColumn?.autoAssignRole && !isFirstOrLast) {
        // Find all matching agents owned by the task owner or unowned
        const candidates = Array.from(this.agents.values()).filter(a =>
          a.enabled !== false &&
          a.role === currentColumn.autoAssignRole &&
          (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
        );
        let autoAgent = null;
        let minTasks = Infinity;
        for (const candidate of candidates) {
          let count = 0;
          for (const [, creator] of this.agents) {
            for (const t of creator.todoList || []) {
              if (t.id === task.id) continue; // don't count the task being assigned
              if (t.assignee === candidate.id || (!t.assignee && creator.id === candidate.id)) {
                count++;
              }
            }
          }
          if (count < minTasks) {
            minTasks = count;
            autoAgent = candidate;
          }
        }
        if (autoAgent) {
          console.log(`[Auto-Assign] Task "${(task.text || '').slice(0, 60)}" assigned to "${autoAgent.name}" (${minTasks} tasks in column, role: ${currentColumn.autoAssignRole})`);
          task.assignee = autoAgent.id;
          // Update the actual agent's todoList (task is a spread copy)
          const creatorAgent = this.agents.get(task.agentId);
          const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
          if (actualTask) {
            actualTask.assignee = autoAgent.id;
            saveAgent(creatorAgent);
          }
          this.io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task });
        }
      }

      // Migrate and filter transitions
      const matchingTransitions = workflow.transitions
        .filter(t => this._validTransition(t))
        .filter(t => t && t.from === task.status);

      const originalStatus = task.status;
      let transitionsRan = 0;

      for (const transition of matchingTransitions) {
        // ── Stop if the task moved to a different column ──
        if (task.status !== originalStatus) {
          console.log(`[Workflow] Task moved from "${originalStatus}" to "${task.status}" — stopping remaining transitions`);
          break;
        }

        // ── Skip Jira-managed triggers (handled by jiraSync polling) ──
        if (transition.trigger === 'jira_ticket') continue;

        // ── Evaluate trigger ──
        if (transition.trigger === 'condition') {
          const conditions = transition.conditions || [];
          if (conditions.length === 0) continue;
          const allMet = conditions.every(cond => this._evaluateCondition(cond, task));
          if (!allMet) {
            console.log(`[Workflow] Condition not met for transition from="${transition.from}" (${conditions.length} conditions)`);
            continue;
          }
          console.log(`[Workflow] All ${conditions.length} conditions met for transition from="${transition.from}"`);
        }
        // trigger === 'on_enter' always passes

        // ── Process actions sequentially ──
        const actions = transition.actions || [];
        console.log(`[Workflow] Transition matched: from="${transition.from}" trigger="${transition.trigger}" (${actions.length} action(s))`);
        transitionsRan++;

        let stopActionChain = false;
        for (const action of actions) {
          if (action.type === 'assign_agent') {
            // Find the agent with the specified role that has the fewest tasks (scoped to task owner)
            const candidates = Array.from(this.agents.values()).filter(a =>
              a.enabled !== false &&
              (a.role || '').toLowerCase() === (action.role || '').toLowerCase() &&
              (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
            );
            let agent = null;
            let minTasks = Infinity;
            for (const c of candidates) {
              let count = 0;
              for (const [, creator] of this.agents) {
                for (const t of creator.todoList || []) {
                  if (t.id === task.id) continue;
                  if (t.assignee === c.id || (!t.assignee && creator.id === c.id)) count++;
                }
              }
              if (count < minTasks) { minTasks = count; agent = c; }
            }
            if (agent) {
              task.assignee = agent.id;
              const creatorAgent = this.agents.get(task.agentId);
              const actualTask = creatorAgent?.todoList?.find(t => t.id === task.id);
              if (actualTask) {
                actualTask.assignee = agent.id;
                saveAgent(creatorAgent);
              }
              this.io?.to(`agent:${task.agentId}`)?.emit('task:updated', { agentId: task.agentId, task });
              console.log(`[Workflow] Action: assigned "${(task.text || '').slice(0, 60)}" to "${agent.name}" (${minTasks} total tasks, role: ${action.role})`);
            } else {
              console.log(`[Workflow] Action: no idle agent with role "${action.role}" — skipping assign`);
            }

          } else if (action.type === 'run_agent') {
            // Build _transition compatible with processTransition
            const enrichedTask = {
              ...task,
              _boardUserId: taskOwnerId,
              _transition: {
                agent: action.role || '',
                mode: action.mode || 'execute',
                instructions: action.instructions || '',
                to: action.targetStatus || null,
              }
            };
            console.log(`[Workflow] Action: run_agent mode="${action.mode}" role="${action.role}" target="${action.targetStatus}"`);
            try {
              await processTransition(enrichedTask, this, this.io);
              // Re-read the task after processTransition (it may have been updated)
              const freshAgent = this.agents.get(task.agentId);
              const freshTask = freshAgent?.todoList?.find(t => t.id === task.id);
              if (freshTask) {
                task.text = freshTask.text;
                task.title = freshTask.title;
                task.status = freshTask.status;
                task.assignee = freshTask.assignee;
              }
            } catch (err) {
              console.error(`[Workflow] Error in run_agent for "${(task.text || '').slice(0, 60)}":`, err.message);
            }
            // If the task moved to error, stop everything
            if (task.status === 'error') {
              console.log(`[Workflow] Task in error after run_agent — stopping action chain`);
              return;
            }
            // If an execute action moved the task out of its original column,
            // stop this action chain (remaining transitions will be stopped by the column check above)
            if (action.mode === 'execute' && task.status !== originalStatus) {
              console.log(`[Workflow] Task moved to "${task.status}" after execute — stopping action chain`);
              stopActionChain = true;
              break;
            }

          } else if (action.type === 'change_status') {
            if (action.target && action.target !== task.status) {
              console.log(`[Workflow] Action: change_status "${task.status}" -> "${action.target}" for "${(task.text || '').slice(0, 60)}"`);
              const result = this.setTaskStatus(task.agentId, task.id, action.target, { skipAutoRefine: false, by: 'workflow' });
              if (!result) {
                console.warn(`[Workflow] Action: change_status BLOCKED (guard) for "${(task.text || '').slice(0, 60)}"`);
              }
              // Task moved to a new column — stop this action chain
              // (the column check at the top of the loop will stop remaining transitions)
              stopActionChain = true;
              break;
            }
          }
        }

        if (stopActionChain) continue; // move to next transition (column check will stop if needed)
      }

      if (transitionsRan === 0) {
        console.log(`[Workflow] No matching transition for status="${task.status}" (${matchingTransitions.length} candidates checked)`);
      }
    }).catch(err => {
      console.error(`[Workflow] Failed to load workflow:`, err.message);
    });
  }

  // ─── Task Management ───────────────────────────────────────────────
  // IMPORTANT: Once a task's `source` is set at creation, it MUST NOT be modified.
  // Source tracks the origin (user, api, mcp, agent) and is immutable after creation.
  // Terminology:
  //   - agentId (creator): the agent whose todoList stores this task (Task Creator)
  //   - assignee: the agent that actually executes this task (Task Assignee)
  addTask(agentId, text, project, source, initialStatus, { boardId, skipAutoRefine = false, recurrence, taskType } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const defaultStatus = source?.type === 'api' ? 'backlog' : 'pending';
    const status = initialStatus || defaultStatus;
    const now = new Date().toISOString();
    const newTask = {
      id: uuidv4(),
      text,
      status,
      project: project !== undefined ? project : (agent.project || null),
      source: source || null,
      boardId: boardId || null,
      createdAt: now,
      history: [{ status, at: now, by: source?.name || source?.type || 'user' }],
    };
    if (taskType) newTask.taskType = taskType;
    // Store recurrence config if provided
    if (recurrence && recurrence.enabled) {
      newTask.recurrence = {
        enabled: true,
        period: recurrence.period || 'daily',
        intervalMinutes: recurrence.intervalMinutes || 1440,
        originalStatus: status, // remember which status to reset to
      };
    }
    agent.todoList.push(newTask);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    if (!skipAutoRefine) this._checkAutoRefine({ ...newTask, agentId });
    return newTask;
  }

  toggleTask(agentId, taskId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const prevStatus = task.status;
    task.status = prevStatus === 'done' ? 'pending' : 'done';
    if (task.status === 'done') task.completedAt = new Date().toISOString();

    const now = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status: task.status, at: now, by: 'user' });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  setTaskStatus(agentId, taskId, status, { skipAutoRefine = false, by = null } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    // Guard: only one in_progress task per assignee at a time
    // The guard checks the ASSIGNEE (the agent actually working), not the todoList creator
    if (status === 'in_progress' && task.status !== 'in_progress') {
      const assigneeId = task.assignee || agentId;
      // Check across ALL agents' todoLists for any in_progress task assigned to the same assignee
      for (const [creatorId, creatorAgent] of this.agents) {
        if (!creatorAgent.todoList) continue;
        const existing = creatorAgent.todoList.find(t =>
          t.status === 'in_progress' && t.id !== taskId &&
          (t.assignee || creatorId) === assigneeId
        );
        if (existing) {
          console.warn(`[Guard] Assignee "${this.agents.get(assigneeId)?.name || assigneeId}" already has in_progress task "${existing.text.slice(0, 60)}" - blocking "${task.text.slice(0, 60)}"`);
          return null;
        }
      }
    }
    const prevStatus = task.status;
    if (prevStatus === status) return task; // No-op: skip same-status transitions
    task.status = status;
    const now = new Date().toISOString();
    if (status === 'done') task.completedAt = now;
    if (status === 'in_progress') task.startedAt = now;
    // Track which column the task was in before entering error status
    if (status === 'error') {
      task.errorFromStatus = prevStatus;
    }
    // Track which column the task was in before entering in_progress (for board display)
    if (status === 'in_progress') {
      task.inProgressFromStatus = prevStatus;
    }
    // Clear error metadata when moving out of error (e.g. manual retry)
    if (prevStatus === 'error' && status !== 'error') {
      delete task.errorFromStatus;
      delete task.error;
    }
    // Clear in_progress metadata when moving out of in_progress
    if (prevStatus === 'in_progress' && status !== 'in_progress') {
      delete task.inProgressFromStatus;
    }
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status, at: now, by: by || 'user' });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    // Push status change to Jira (fire-and-forget, skips if no jiraKey or if triggered by jira-sync)
    if (by !== 'jira-sync') onTaskStatusChanged(task, status, this);
    if (!skipAutoRefine && status !== 'error') this._checkAutoRefine({ ...task, agentId }, { by: by || 'user' });
    return task;
  }

  updateTaskTitle(agentId, taskId, title) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldTitle = task.title || null;
    task.title = title;
    if (!task.history) task.history = [];
    task.history.push({
      status: task.status,
      at: new Date().toISOString(),
      by: 'user',
      type: 'edit',
      field: 'title',
      oldValue: oldTitle,
      newValue: title,
    });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  updateTaskText(agentId, taskId, text) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldText = task.text;
    task.text = text;
    if (!task.history) task.history = [];
    task.history.push({
      status: task.status,
      at: new Date().toISOString(),
      by: 'user',
      type: 'edit',
      field: 'text',
      oldValue: oldText,
      newValue: text,
    });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  updateTaskProject(agentId, taskId, project) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldProject = task.project;
    task.project = project;
    if (!task.history) task.history = [];
    task.history.push({
      status: task.status,
      at: new Date().toISOString(),
      by: 'user',
      type: 'edit',
      field: 'project',
      oldValue: oldProject,
      newValue: project,
    });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  updateTaskType(agentId, taskId, taskType, by = 'user') {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldType = task.taskType || null;
    task.taskType = taskType || null;
    if (!task.history) task.history = [];
    task.history.push({
      status: task.status,
      at: new Date().toISOString(),
      by,
      type: 'edit',
      field: 'taskType',
      oldValue: oldType,
      newValue: taskType || null,
    });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  updateTaskRecurrence(agentId, taskId, recurrence) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    if (recurrence && recurrence.enabled) {
      task.recurrence = {
        enabled: true,
        period: recurrence.period || 'daily',
        intervalMinutes: recurrence.intervalMinutes || 1440,
        originalStatus: recurrence.originalStatus || task.recurrence?.originalStatus || 'pending',
      };
    } else {
      task.recurrence = null;
    }
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  /**
   * Search ALL agents' todoLists for a task assigned to or owned by the given agent.
   * Returns { task, ownerAgentId } or null.
   * Priority: in_progress > most recently done.
   * Checks the agent's own list first, then all other agents' lists (for auto-assigned tasks).
   */
  _findTaskForCommitLink(agentId) {
    // 1. Check the agent's own todoList first
    const agent = this.agents.get(agentId);
    if (agent?.todoList?.length) {
      const own = agent.todoList.find(t => t.status === 'in_progress');
      if (own) return { task: own, ownerAgentId: agentId };
    }

    // 2. Search ALL agents' todoLists for tasks assigned to this agent
    let bestInProgress = null;
    let bestDone = null;
    for (const [creatorId, creatorAgent] of this.agents) {
      if (!creatorAgent.todoList) continue;
      for (const task of creatorAgent.todoList) {
        const isOwnedOrAssigned = creatorId === agentId || task.assignee === agentId;
        if (!isOwnedOrAssigned) continue;
        if (task.status === 'in_progress') {
          bestInProgress = { task, ownerAgentId: creatorId };
          break; // in_progress is highest priority
        }
        if (task.status === 'done' && task.completedAt) {
          if (!bestDone || new Date(task.completedAt) > new Date(bestDone.task.completedAt)) {
            bestDone = { task, ownerAgentId: creatorId };
          }
        }
      }
      if (bestInProgress) break;
    }

    if (bestInProgress) return bestInProgress;
    if (bestDone) {
      console.log(`🔗 [Commit] No in_progress task — falling back to recently done task "${bestDone.task.text?.slice(0, 50)}"`);
      return bestDone;
    }
    return null;
  }

  addTaskCommit(agentId, taskId, hash, message) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    if (!task.commits) task.commits = [];
    // Avoid duplicates
    if (task.commits.some(c => c.hash === hash)) return task;
    task.commits.push({ hash, message: message || '', date: new Date().toISOString() });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  removeTaskCommit(agentId, taskId, hash) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task || !task.commits) return null;
    const before = task.commits.length;
    task.commits = task.commits.filter(c => c.hash !== hash);
    if (task.commits.length === before) return null;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  }

  setTaskAssignee(agentId, taskId, assigneeId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    task.assignee = assigneeId;
    if (!task.history) task.history = [];
    task.history.push({
      status: task.status,
      at: new Date().toISOString(),
      by: 'user',
      type: 'reassign',
      assignee: assigneeId,
    });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    // Re-check workflow transitions since assignee changed
    this._recheckConditionalTransitions();
    return task;
  }

  deleteTask(agentId, taskId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.todoList = agent.todoList.filter(t => t.id !== taskId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  clearTasks(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.todoList = [];
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  transferTask(fromAgentId, taskId, toAgentId) {
    const fromAgent = this.agents.get(fromAgentId);
    const toAgent = this.agents.get(toAgentId);
    if (!fromAgent || !toAgent) return null;
    const taskToTransfer = fromAgent.todoList.find(t => t.id === taskId);
    if (!taskToTransfer) return null;

    const prevStatus = taskToTransfer.status;

    // Remove from source agent
    fromAgent.todoList = fromAgent.todoList.filter(t => t.id !== taskId);
    saveAgent(fromAgent);
    this._emit('agent:updated', this._sanitize(fromAgent));

    // Add to target agent, preserving status and assigning to target agent
    const newTask = this.addTask(toAgentId, taskToTransfer.text, taskToTransfer.project, {
      type: 'transfer',
      name: fromAgent.name,
      id: fromAgent.id,
    }, prevStatus);

    // Set the assignee to the target agent so workflow conditions can evaluate
    if (newTask) {
      const actualTask = toAgent.todoList.find(t => t.id === newTask.id);
      if (actualTask) {
        actualTask.assignee = toAgentId;
        saveAgent(toAgent);
      }
      // Re-trigger workflow check with the assignee set
      this._checkAutoRefine({ ...newTask, assignee: toAgentId, agentId: toAgentId });
    }
    return newTask;
  }

  // Execute a single task — sends it as a chat message to the agent
  async executeTask(agentId, taskId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) throw new Error('Task not found');
    if (task.status === 'done') throw new Error('Task already completed');

    console.log(`[Workflow] Triggering execution for "${task.text.slice(0, 80)}" (status=${task.status})`);

    if (task.status === 'pending') {
      // Check if there's a workflow transition with a run_agent action for pending tasks
      const workflow = await getWorkflowForBoard(task.boardId);
      const hasRunAgent = workflow.transitions
        .filter(t => this._validTransition(t))
        .some(t => t.from === 'pending' && (t.actions || []).some(a => a.type === 'run_agent'));

      if (hasRunAgent) {
        // Workflow manages this status — trigger _checkAutoRefine (fire-and-forget)
        this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
      } else {
        // No workflow run_agent transition — move directly to in_progress.
        // _resumeInProgressTask will pick it up on the next tick and send to LLM.
        this.setTaskStatus(agentId, taskId, 'in_progress', { skipAutoRefine: true, by: 'task-loop' });
      }
    } else if (task.status === 'in_progress') {
      // Resume a stopped in_progress task — clear stopped flag and re-trigger execution
      delete task._executionStopped;
      saveAgent(agent);
      this._checkAutoRefine({ ...task, agentId }, { by: 'resume' });
    } else {
      // For other statuses (e.g. error → pending), use setTaskStatus to trigger the chain.
      this.setTaskStatus(agentId, taskId, 'pending');
    }

    return { taskId, response: null };
  }

  // Execute all pending tasks sequentially
  async executeAllTasks(agentId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    const pending = agent.todoList.filter(t => t.status === 'pending' || t.status === 'error');
    if (pending.length === 0) throw new Error('No pending tasks');

    console.log(`▶️  Executing ${pending.length} pending task(s) for ${agent.name}`);
    this._emit('agent:task:executeAll:start', { agentId, count: pending.length });

    const results = [];
    for (const task of pending) {
      try {
        const result = await this.executeTask(agentId, task.id, streamCallback);
        results.push({ taskId: task.id, text: task.text, success: true, response: result.response });
      } catch (err) {
        results.push({ taskId: task.id, text: task.text, success: false, error: err.message });
        // Continue with next task
      }
    }

    this._emit('agent:task:executeAll:complete', { agentId, results: results.map(r => ({ taskId: r.taskId, success: r.success })) });
    return results;
  }

  // ─── RAG Document Management ───────────────────────────────────────
  addRagDocument(agentId, name, content) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const doc = { id: uuidv4(), name, content, addedAt: new Date().toISOString() };
    agent.ragDocuments.push(doc);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return doc;
  }

  deleteRagDocument(agentId, docId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.ragDocuments = agent.ragDocuments.filter(d => d.id !== docId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Skills ────────────────────────────────────────────────────────
  assignSkill(agentId, skillId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    if (!agent.skills) agent.skills = [];
    if (agent.skills.includes(skillId)) return agent.skills;
    agent.skills.push(skillId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.skills;
  }

  removeSkill(agentId, skillId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.skills) agent.skills = [];
    agent.skills = agent.skills.filter(id => id !== skillId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── MCP Servers ──────────────────────────────────────────────────
  assignMcpServer(agentId, serverId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    if (!agent.mcpServers) agent.mcpServers = [];
    if (agent.mcpServers.includes(serverId)) return agent.mcpServers;
    agent.mcpServers.push(serverId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.mcpServers;
  }

  removeMcpServer(agentId, serverId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.mcpServers) agent.mcpServers = [];
    agent.mcpServers = agent.mcpServers.filter(id => id !== serverId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Voice Agent Instructions ────────────────────────────────────
  buildVoiceInstructions(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    let instructions = agent.instructions || 'You are a helpful voice assistant.';

    // Inject available agents for delegation
    const availableAgents = Array.from(this.agents.values())
      .filter(a => a.id !== agentId && a.enabled !== false)
      .map(a => `- ${a.name} (${a.role}): ${a.description || 'No description'}`);

    if (availableAgents.length > 0) {
      instructions += `\n\n--- Available Swarm Agents ---\nYou can delegate tasks to these agents using the "delegate" function. Call it with the agent's name and a detailed task description.\n${availableAgents.join('\n')}\n\nWhen you need an agent to work on something, use the delegate function. The result will be provided back to you and you should summarize it vocally.`;
    }

    // Append RAG context
    if (agent.ragDocuments && agent.ragDocuments.length > 0) {
      instructions += '\n\n--- Reference Documents ---\n';
      for (const doc of agent.ragDocuments) {
        instructions += `\n[${doc.name}]:\n${doc.content}\n`;
      }
    }

    // Append Skills context
    const agentSkills = agent.skills || [];
    if (agentSkills.length > 0 && this.skillManager) {
      const resolvedSkills = agentSkills.map(sid => this.skillManager.getById(sid)).filter(Boolean);
      if (resolvedSkills.length > 0) {
        instructions += '\n\n--- Active Skills ---\n';
        for (const skill of resolvedSkills) {
          instructions += `\n[${skill.name}]:\n${skill.instructions}\n`;
        }
      }
    }

    // Append task list context
    if (agent.todoList && agent.todoList.length > 0) {
      instructions += '\n\n--- Current Task List ---\n';
      for (const task of agent.todoList) {
        const mark = task.status === 'done' ? 'x' : task.status === 'in_progress' ? '~' : task.status === 'error' ? '!' : ' ';
        instructions += `- [${mark}] ${task.text}\n`;
      }
    }

    return instructions;
  }

  // ─── Clear Conversation ────────────────────────────────────────────
  clearHistory(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.conversationHistory = [];
    agent.currentThinking = '';
    delete agent._compactionArmed;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  }

  // ─── Truncate Conversation (keep messages 0..afterIndex, remove the rest) ──
  truncateHistory(agentId, afterIndex) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const idx = parseInt(afterIndex, 10);
    if (isNaN(idx) || idx < 0) return null;
    // Keep messages from 0 to afterIndex (inclusive)
    agent.conversationHistory = agent.conversationHistory.slice(0, idx + 1);
    // Remove any stale compaction summary — it refers to messages that may no longer exist
    agent.conversationHistory = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
    delete agent._compactionArmed;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.conversationHistory;
  }

  // ─── Project Context Switching ──────────────────────────────────────
  /**
   * Save the current conversation context keyed by oldProject,
   * then restore any previously saved context for newProject.
   * If no saved context exists for newProject, start with a clean history.
   */
  _switchProjectContext(agent, oldProject, newProject) {
    if (!agent.projectContexts) agent.projectContexts = {};

    // Save current context under the OLD project key (if there is one)
    if (oldProject) {
      agent.projectContexts[oldProject] = {
        conversationHistory: [...agent.conversationHistory],
        _compactionArmed: agent._compactionArmed,
        savedAt: new Date().toISOString()
      };
      console.log(`💾 [Context Switch] Saved context for "${agent.name}" on project "${oldProject}" (${agent.conversationHistory.length} messages)`);
    }

    // Restore context for the NEW project (if one was previously saved)
    if (newProject && agent.projectContexts[newProject]) {
      const saved = agent.projectContexts[newProject];
      agent.conversationHistory = [...saved.conversationHistory];
      agent._compactionArmed = saved._compactionArmed;
      delete agent.projectContexts[newProject];
      console.log(`📂 [Context Switch] Restored context for "${agent.name}" on project "${newProject}" (${agent.conversationHistory.length} messages)`);
    } else {
      // No saved context for the new project: start fresh
      agent.conversationHistory = [];
      agent.currentThinking = '';
      delete agent._compactionArmed;
      console.log(`🆕 [Context Switch] Clean slate for "${agent.name}" on project "${newProject || '(none)'}"`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  /**
   * Compute dynamic compaction thresholds based on context window size.
   * Larger contexts can afford to keep more messages before compacting.
   */
  _compactionThresholds(contextLimit) {
    if (contextLimit >= 200000) {
      // 200k+ contexts (e.g. 256k): keep a lot more history
      return { maxRecent: 40, compactTrigger: 55, compactReset: 45, safetyRatio: 0.80 };
    } else if (contextLimit >= 128000) {
      // 128k contexts: generous history
      return { maxRecent: 30, compactTrigger: 42, compactReset: 35, safetyRatio: 0.80 };
    } else if (contextLimit >= 32000) {
      // 32k contexts: moderate history
      return { maxRecent: 16, compactTrigger: 24, compactReset: 20, safetyRatio: 0.75 };
    } else {
      // Small contexts (8k-16k): conservative
      return { maxRecent: 10, compactTrigger: 15, compactReset: 12, safetyRatio: 0.75 };
    }
  }

  /**
   * Rough token estimation (~4 chars per token for English, ~3 for code).
   * This is a fast heuristic — not exact, but good enough for compaction triggers.
   */
  _estimateTokens(messages) {
    let chars = 0;
    for (const m of messages) {
      chars += (m.content || '').length;
    }
    return Math.ceil(chars / 3.0);
  }

  /**
   * Compute a safe maxTokens value that won't exceed the model's context window.
   *
   * When input_tokens + max_tokens > context_length, APIs like Claude return 400.
   * This method estimates input size and caps max_tokens so the total stays within
   * the context window, with a 5% safety margin for estimation errors.
   */
  _safeMaxTokens(messages, agent, llmConfig = null) {
    const contextLength = (llmConfig?.contextLength) || agent.contextLength || 131072;
    const desiredMaxTokens = (llmConfig?.maxTokens) || agent.maxTokens || 4096;
    const estimatedInput = this._estimateTokens(messages);
    // Leave 15% headroom for token estimation inaccuracy
    const safetyMargin = Math.ceil(contextLength * 0.15);
    const available = contextLength - estimatedInput - safetyMargin;
    if (available < desiredMaxTokens) {
      // When available is very low/negative, _truncateMessagesToFit will handle it
      const capped = Math.max(1024, available);
      if (capped !== desiredMaxTokens) {
        console.log(`⚠️  [TokenCap] "${agent.name}": capping maxTokens from ${desiredMaxTokens} to ${capped} (input ~${estimatedInput}, context ${contextLength})`);
      }
      return capped;
    }
    return desiredMaxTokens;
  }

  /**
   * Detect if an error message indicates the context window was exceeded.
   */
  /**
   * Detect rate-limit messages like "You've hit your limit · resets 6am (Europe/Paris)"
   * Returns { retryAt: Date ms, resetLabel: string } or null if not a rate limit.
   */
  _parseRateLimitReset(text) {
    if (!text) return null;
    // Match patterns like: "resets 6am", "resets 6:00am", "resets 6 am (Europe/Paris)"
    const match = text.match(/(?:hit your limit|rate.limit|limit.reached)[\s\S]*?resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*(?:\(([^)]+)\))?/i);
    if (!match) return null;

    let hours = parseInt(match[1], 10);
    const minutes = match[2] ? parseInt(match[2], 10) : 0;
    const ampm = match[3].toLowerCase();
    const tz = match[4] || 'Europe/Paris';

    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;

    // Build target time in the specified timezone
    const now = new Date();
    // Use Intl to get current date in the target timezone
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' });
    const todayStr = formatter.format(now); // "YYYY-MM-DD"
    // Build the reset datetime string in the target timezone
    const resetStr = `${todayStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

    // Convert to UTC by calculating the offset
    const resetInTz = new Date(resetStr);
    // Get the offset for this timezone at this time
    const utcDate = new Date(resetInTz.toLocaleString('en-US', { timeZone: 'UTC' }));
    const tzDate = new Date(resetInTz.toLocaleString('en-US', { timeZone: tz }));
    const offsetMs = utcDate - tzDate;
    let resetUtc = new Date(resetInTz.getTime() + offsetMs);

    // If reset time is in the past, it means tomorrow
    if (resetUtc.getTime() <= now.getTime()) {
      resetUtc = new Date(resetUtc.getTime() + 24 * 60 * 60 * 1000);
    }

    // Add 5 minutes buffer
    const retryAt = resetUtc.getTime() + 5 * 60 * 1000;
    const resetLabel = `${match[1]}${match[2] ? ':' + match[2] : ''}${ampm} (${tz})`;

    console.log(`🕐 [Rate Limit] Parsed reset: ${resetLabel} → retry at ${new Date(retryAt).toISOString()}`);
    return { retryAt, resetLabel };
  }

  _isContextExceededError(errMsg) {
    const lower = (errMsg || '').toLowerCase();
    return [
      'context length', 'context_length', 'num_ctx', 'context window',
      'too long', 'maximum context', 'exceeds', 'token limit',
      'kv cache full', 'prompt is too long', 'input too long',
      'context_length_exceeded'
    ].some(kw => lower.includes(kw));
  }

  /**
   * Truncate individual messages so total estimated tokens fits within context limit.
   * Prioritizes truncating the largest non-system messages first.
   * Preserves system prompt and keeps at least a minimum of each message.
   * Returns true if truncation was performed.
   */
  _truncateMessagesToFit(messages, contextLimit, reserveOutputTokens = 1024) {
    const target = contextLimit - reserveOutputTokens - Math.ceil(contextLimit * 0.10); // 10% safety margin
    let estimated = this._estimateTokens(messages);
    if (estimated <= target) return false;

    const MIN_CONTENT = 500; // minimum chars to keep per message

    // Build a list of truncatable messages (skip system prompt — index 0)
    const candidates = messages
      .map((m, i) => ({ index: i, len: (m.content || '').length }))
      .filter(c => c.index > 0 && c.len > MIN_CONTENT)
      .sort((a, b) => b.len - a.len); // largest first

    let truncated = false;
    for (const c of candidates) {
      if (estimated <= target) break;
      const msg = messages[c.index];
      const content = msg.content || '';
      // Calculate how much we need to cut (in chars, estimated 3 chars/token)
      const excessTokens = estimated - target;
      const excessChars = excessTokens * 3;
      const newLen = Math.max(MIN_CONTENT, content.length - excessChars);
      if (newLen < content.length) {
        msg.content = content.slice(0, newLen) + `\n\n... [truncated from ${content.length} to ${newLen} chars to fit context window]`;
        estimated = this._estimateTokens(messages);
        truncated = true;
      }
    }

    if (truncated) {
      console.log(`✂️  [Truncate] Messages truncated to fit context: ~${estimated} tokens (target: ${target}, limit: ${contextLimit})`);
    }
    return truncated;
  }

  /**
   * Compact (summarize) the conversation history to free up context space.
   *
   * Optimized for large context windows (up to 256k tokens / 128k output):
   *  - Dynamic per-message truncation scaled to context size
   *  - Incremental compaction: merges existing summary with new messages
   *  - Summary input and output sizes scale with context window
   *  - Falls back to hard truncation if summarization fails
   */
  async _compactHistory(agent, keepRecent = 10) {
    const history = agent.conversationHistory;
    if (history.length <= keepRecent + 2) {
      agent.conversationHistory = history.slice(-keepRecent);
      saveAgent(agent);
      console.log(`🗜️  [Compact] "${agent.name}": hard truncation to ${agent.conversationHistory.length} msgs (history too short for summary)`);
      return;
    }

    const contextLimit = agent.contextLength || 8192;

    // Scale limits based on context size
    // Per-message truncation: from 2k chars (small ctx) to 8k chars (256k ctx)
    const perMsgTruncate = contextLimit >= 200000 ? 8000
                         : contextLimit >= 128000 ? 6000
                         : contextLimit >= 32000  ? 4000
                         : 2000;
    // Summary input cap: from 12k chars (small ctx) to 100k chars (256k ctx)
    const summaryInputCap = contextLimit >= 200000 ? 100000
                          : contextLimit >= 128000 ? 60000
                          : contextLimit >= 32000  ? 30000
                          : 12000;
    // Summary output tokens: from 1k (small ctx) to 4k (256k ctx)
    const summaryMaxTokens = contextLimit >= 200000 ? 4096
                           : contextLimit >= 128000 ? 3072
                           : contextLimit >= 32000  ? 2048
                           : 1024;
    // Max words in summary prompt instruction
    const summaryMaxWords = contextLimit >= 128000 ? 2000 : 500;

    // Split: messages to summarize vs messages to keep
    // Separate any existing compaction summary from real messages
    const existingSummary = history.find(m => m.type === 'compaction-summary');
    const realHistory = history.filter(m => m.type !== 'compaction-summary');

    const toSummarize = realHistory.slice(0, realHistory.length - keepRecent);
    const toKeep = realHistory.slice(-keepRecent);

    // Build a compact representation of messages to summarize
    const summaryParts = [];

    // Include existing summary for incremental compaction
    if (existingSummary) {
      summaryParts.push(`[PREVIOUS SUMMARY]:\n${existingSummary.content}`);
    }

    // Add messages to summarize with scaled truncation
    for (const m of toSummarize) {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const rawContent = m.content || '';
      const content = rawContent.length > perMsgTruncate
        ? rawContent.slice(0, perMsgTruncate) + `... [truncated, ${rawContent.length} chars total]`
        : rawContent;
      summaryParts.push(`[${role}]: ${content}`);
    }

    const summaryInput = summaryParts.join('\n\n');

    try {
      const llmConfig = this.resolveLlmConfig(agent);
      const provider = createProvider({
        provider: llmConfig.provider,
        model: llmConfig.model,
        endpoint: llmConfig.endpoint,
        apiKey: llmConfig.apiKey,
        agentId: agent.id
      });

      const msgCount = toSummarize.length + (existingSummary ? 1 : 0);
      console.log(`🗜️  [Compact] "${agent.name}": summarizing ${msgCount} messages (${summaryInput.length} chars input, cap ${summaryInputCap}), keeping ${toKeep.length} recent, context ${contextLimit}, model=${llmConfig.model}`);

      // Cap input to stay well within context: leave room for system prompt + output tokens
      const maxSummaryInputChars = Math.min(summaryInputCap, (contextLimit - summaryMaxTokens - 1000) * 3);
      const summaryMessages = [
        {
          role: 'system',
          content: `You are a conversation summarizer. Produce a concise but thorough summary of the conversation below.${existingSummary ? ' A previous summary is included — integrate it with the new messages into one unified summary.' : ''} Preserve: key decisions made, files modified and their changes, errors encountered and how they were resolved, current task status, tools/commands used, and any important context the assistant needs to continue working effectively. Be factual and structured. Use bullet points grouped by topic. Maximum ${summaryMaxWords} words.`
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${summaryInput.slice(0, maxSummaryInputChars)}`
        }
      ];
      // Safety: also truncate summary messages if they'd exceed context
      this._truncateMessagesToFit(summaryMessages, contextLimit, summaryMaxTokens);

      let summaryResponse = await provider.chat(summaryMessages, {
        temperature: 0.2,
        maxTokens: summaryMaxTokens,
        contextLength: contextLimit
      });

      let summaryText = summaryResponse.content || '';

      // Retry once with a simpler prompt if empty (some models struggle with complex instructions)
      if (!summaryText.trim()) {
        console.warn(`🗜️  [Compact] "${agent.name}": first summary attempt returned empty (model=${llmConfig.model}) — retrying with simpler prompt`);
        const retryMessages = [
          { role: 'user', content: `Summarize the following conversation in bullet points. Keep it concise.\n\n${summaryInput.slice(0, Math.floor(maxSummaryInputChars / 2))}` }
        ];
        this._truncateMessagesToFit(retryMessages, contextLimit, summaryMaxTokens);
        summaryResponse = await provider.chat(retryMessages, {
          temperature: 0.3,
          maxTokens: summaryMaxTokens,
          contextLength: contextLimit
        });
        summaryText = summaryResponse.content || '';
      }

      if (!summaryText.trim()) throw new Error(`Empty summary after retry (model=${llmConfig.model}, provider=${llmConfig.provider})`);

      // Replace history: one summary message + recent messages
      agent.conversationHistory = [
        {
          role: 'assistant',
          content: `[CONVERSATION SUMMARY — earlier messages were compacted to save context]\n\n${summaryText}`,
          timestamp: new Date().toISOString(),
          type: 'compaction-summary'
        },
        ...toKeep
      ];

      saveAgent(agent);
      console.log(`🗜️  [Compact] "${agent.name}": compacted ${history.length} → ${agent.conversationHistory.length} messages (summary: ${summaryText.length} chars)`);

    } catch (summaryErr) {
      // Summarization failed — build mechanical summary (no LLM needed)
      console.warn(`🗜️  [Compact] "${agent.name}": summarization failed (${summaryErr.message}), building mechanical summary`);

      // Extract structured info from discarded messages
      const filesRead = new Set();
      const filesWritten = new Set();
      const commandsRun = [];
      const toolCalls = [];
      const errors = [];
      const userRequests = [];

      for (const m of toSummarize) {
        const content = m.content || '';
        if (m.role === 'assistant') {
          // Extract tool calls
          const reads = content.match(/@read_file\(([^)]{1,120})\)/g);
          if (reads) reads.forEach(r => {
            const match = r.match(/@read_file\(([^,)]+)/);
            if (match) filesRead.add(match[1].trim().replace(/^["']|["']$/g, ''));
          });
          const writes = content.match(/@write_file\(([^,]{1,120})/g);
          if (writes) writes.forEach(w => {
            const match = w.match(/@write_file\(([^,]+)/);
            if (match) filesWritten.add(match[1].trim().replace(/^["']|["']$/g, ''));
          });
          const cmds = content.match(/@run_command\(([^)]{1,200})\)/g);
          if (cmds) commandsRun.push(...cmds.slice(0, 3).map(c => c.slice(13, -1).slice(0, 80)));
          const otherTools = content.match(/@(?:search_files|list_dir|append_file|git_commit_push|mcp_call)\([^)]{0,80}\)/g);
          if (otherTools) toolCalls.push(...otherTools.slice(0, 5));
        } else if (m.role === 'user') {
          if (content.includes('Error') || content.includes('error') || content.includes('failed')) {
            const errPreview = content.slice(0, 150).replace(/\n/g, ' ');
            errors.push(errPreview);
          }
          // Capture original user requests (not tool results)
          if (!m.type && content.length > 10 && content.length < 500) {
            userRequests.push(content.slice(0, 150));
          }
        }
      }

      const parts = [];
      parts.push(`[MECHANICAL SUMMARY — ${toSummarize.length} earlier messages compacted (LLM summarization failed)]`);
      if (userRequests.length > 0) parts.push(`Tasks requested: ${userRequests.slice(0, 3).join(' | ')}`);
      if (filesRead.size > 0) parts.push(`Files read: ${[...filesRead].slice(0, 15).join(', ')}`);
      if (filesWritten.size > 0) parts.push(`Files written: ${[...filesWritten].slice(0, 10).join(', ')}`);
      if (commandsRun.length > 0) parts.push(`Commands run: ${commandsRun.slice(0, 5).join(', ')}`);
      if (toolCalls.length > 0) parts.push(`Other tools: ${toolCalls.slice(0, 8).join(', ')}`);
      if (errors.length > 0) parts.push(`Errors encountered: ${errors.slice(0, 3).join(' | ')}`);
      const mechanicalSummary = parts.join('\n');

      if (existingSummary) {
        existingSummary.content += `\n\n${mechanicalSummary}`;
        agent.conversationHistory = [existingSummary, ...toKeep];
      } else {
        agent.conversationHistory = [
          {
            role: 'assistant',
            content: mechanicalSummary,
            timestamp: new Date().toISOString(),
            type: 'compaction-summary'
          },
          ...toKeep
        ];
      }
      // Also truncate individual large messages to prevent context overflow on next call
      const maxPerMsg = Math.floor((contextLimit * 3) / Math.max(agent.conversationHistory.length, 1) * 0.6);
      for (const m of agent.conversationHistory) {
        if (m.type === 'compaction-summary') continue;
        if ((m.content || '').length > maxPerMsg) {
          m.content = m.content.slice(0, maxPerMsg) + `\n\n... [hard-truncated from ${m.content.length} to ${maxPerMsg} chars]`;
        }
      }
      saveAgent(agent);
    }

    this._emit('agent:updated', this._sanitize(agent));
  }

  // ─── Re-evaluate conditional transitions ──────────────────────────
  // Called periodically (from task loop) and on agent status changes to re-check
  // condition-based transitions for tasks waiting on conditions (e.g. "assignee is idle").
  _recheckConditionalTransitions() {
    // Evict stale locks older than 2 minutes to prevent permanent deadlocks
    // from failed processTransition calls that didn't clean up.
    const LOCK_TTL_MS = 2 * 60 * 1000;
    if (this._conditionProcessing) {
      const now = Date.now();
      for (const [key, timestamp] of this._conditionProcessing) {
        if (now - timestamp > LOCK_TTL_MS) {
          console.warn(`[Workflow] Evicting stale condition lock: ${key} (age: ${Math.round((now - timestamp) / 1000)}s)`);
          this._conditionProcessing.delete(key);
        }
      }
    }

    getAllBoardWorkflows().then(async (boardWorkflows) => {
      // Build per-board conditional transitions map
      const boardTransMap = new Map(); // boardId → condTransitions[]
      for (const { boardId, workflow } of boardWorkflows) {
        const condTransitions = workflow.transitions
          .filter(t => this._validTransition(t))
          .filter(t => {
            if (!t) return false;
            // Only condition-based transitions need periodic re-evaluation.
            // on_enter transitions fire once via _checkAutoRefine when a task
            // enters the status — re-checking them here causes infinite loops.
            if (t.trigger === 'condition' && (t.conditions || []).length > 0) return true;
            return false;
          });
        if (condTransitions.length > 0) {
          boardTransMap.set(boardId, condTransitions);
        }
      }

      if (boardTransMap.size === 0) return;

      // Collect all tasks across all agents
      for (const [agentId, agent] of this.agents) {
        if (!agent.todoList) continue;
        for (const task of agent.todoList) {
          // Skip tasks in error status — they must not be auto-transitioned
          if (task.status === 'error') continue;

          // Find conditional transitions for this task's board
          const condTransitions = boardTransMap.get(task.boardId) || (boardTransMap.size === 1 ? [...boardTransMap.values()][0] : []);
          // Find conditional transitions matching this task's status
          const matching = condTransitions.filter(t => t.from === task.status);
          if (matching.length === 0) continue;

          // Skip tasks where the assignee is busy (actively executing).
          // Allow re-evaluation when assignee is idle, error, or absent —
          // the condition evaluator will check the actual status.
          if (task.assignee) {
            const assigneeAgent = this.agents.get(task.assignee);
            if (assigneeAgent && assigneeAgent.status === 'busy') continue;
          }

          for (const transition of matching) {
            const conditions = transition.conditions || [];
            const allMet = conditions.length === 0 || conditions.every(cond =>
              this._evaluateCondition(cond, { ...task, agentId })
            );
            if (!allMet) continue;

            // Prevent double-processing: skip if already being processed (with TTL)
            const lockKey = `${agentId}:${task.id}`;
            if (!this._conditionProcessing) this._conditionProcessing = new Map();
            if (this._conditionProcessing.has(lockKey)) continue;
            this._conditionProcessing.set(lockKey, Date.now());

            console.log(`[Workflow] Condition re-check: all conditions met for "${(task.text || '').slice(0, 60)}" in status="${task.status}"`);

            // Process actions (same logic as _checkAutoRefine)
            const actions = transition.actions || [];
            let didReturn = false;
            for (const action of actions) {
              if (action.type === 'assign_agent') {
                // Scope to board owner's agents or unowned agents
                const boardWf = await getWorkflowForBoard(task.boardId);
                const taskOwnerId = boardWf.userId || agent.ownerId || null;
                const candidates = Array.from(this.agents.values()).filter(a =>
                  a.enabled !== false &&
                  (a.role || '').toLowerCase() === (action.role || '').toLowerCase() &&
                  (!taskOwnerId || !a.ownerId || a.ownerId === taskOwnerId)
                );
                let foundAgent = null;
                let minTasks = Infinity;
                for (const c of candidates) {
                  let count = 0;
                  for (const [, cr] of this.agents) {
                    for (const t of cr.todoList || []) {
                      if (t.id === task.id) continue;
                      if (t.assignee === c.id || (!t.assignee && cr.id === c.id)) count++;
                    }
                  }
                  if (count < minTasks) { minTasks = count; foundAgent = c; }
                }
                if (foundAgent) {
                  const actualTask = agent.todoList.find(t => t.id === task.id);
                  if (actualTask) {
                    actualTask.assignee = foundAgent.id;
                    saveAgent(agent);
                  }
                  this.io?.to(`agent:${agentId}`)?.emit('task:updated', { agentId, task: { ...task, assignee: foundAgent.id } });
                  console.log(`[Workflow] Condition re-check: assigned "${(task.text || '').slice(0, 60)}" to "${foundAgent.name}" (${minTasks} tasks in column, role: ${action.role})`);
                }
              } else if (action.type === 'run_agent') {
                const boardWfForRun = await getWorkflowForBoard(task.boardId);
                const runOwnerId = boardWfForRun.userId || agent.ownerId || null;
                const enrichedTask = {
                  ...task, agentId,
                  _boardUserId: runOwnerId,
                  _transition: {
                    agent: action.role || '',
                    mode: action.mode || 'execute',
                    instructions: action.instructions || '',
                    to: action.targetStatus || null,
                    rejectTarget: action.rejectTarget || null,
                  }
                };
                console.log(`[Workflow] Condition re-check: run_agent mode="${action.mode}" role="${action.role}"`);
                processTransition(enrichedTask, this, this.io)
                  .catch(err => console.error(`[Workflow] Condition re-check error:`, err.message))
                  .finally(() => {
                    this._conditionProcessing.delete(lockKey);
                  });
                didReturn = true;
                break;
              } else if (action.type === 'change_status') {
                if (action.target && action.target !== task.status) {
                  console.log(`[Workflow] Condition re-check: change_status "${task.status}" -> "${action.target}" for "${(task.text || '').slice(0, 60)}"`);
                  const result = this.setTaskStatus(agentId, task.id, action.target, { skipAutoRefine: false, by: 'workflow' });
                  if (!result) {
                    console.warn(`[Workflow] Condition re-check: change_status BLOCKED (guard) for "${(task.text || '').slice(0, 60)}"`);
                  }
                  this._conditionProcessing.delete(lockKey);
                  didReturn = true;
                  break;
                }
              }
            }
            if (!didReturn) this._conditionProcessing.delete(lockKey);
            break; // one transition matched — stop checking others for this task
          }
        }
      }
    }).catch(err => {
      console.error(`[Workflow] Condition re-check error:`, err.message);
    });
  }

  // ─── Automatic Task Loop ───────────────────────────────────────────
  // Periodically scans idle+enabled agents for pending tasks and executes the first one.

  startTaskLoop(intervalMs = 5000) {
    if (this._taskLoopInterval) return;
    this._loopProcessing = new Set();
    this._workflowManagedStatuses = new Set();
    this._refreshWorkflowManagedStatuses();
    this._taskLoopInterval = setInterval(() => this._processNextPendingTasks(), intervalMs);
    // Check recurring tasks every 60 seconds
    this._recurrenceInterval = setInterval(() => this._processRecurringTasks(), 60000);
    // Refresh managed statuses every 30s (picks up workflow config changes)
    this._workflowRefreshInterval = setInterval(() => this._refreshWorkflowManagedStatuses(), 30000);
    console.log(`🔄 Task loop started (every ${intervalMs / 1000}s)`);
  }

  _refreshWorkflowManagedStatuses() {
    getAllBoardWorkflows().then(boardWorkflows => {
      const managed = new Set();
      for (const { workflow } of boardWorkflows) {
        for (const t of workflow.transitions) {
          if (!this._validTransition(t)) continue;
          const migrated = t;
          const hasAgentAction = (migrated.actions || []).some(a => a.type === 'run_agent');
          const isConditional = migrated.trigger === 'condition' && (migrated.conditions || []).length > 0;
          if (hasAgentAction || isConditional) {
            managed.add(migrated.from);
          }
        }
      }
      this._workflowManagedStatuses = managed;
      if (managed.size > 0) {
        console.log(`🔄 [TaskLoop] Workflow-managed statuses: ${[...managed].join(', ')}`);
      }
    }).catch(() => {});
  }

  stopTaskLoop() {
    if (this._taskLoopInterval) {
      clearInterval(this._taskLoopInterval);
      this._taskLoopInterval = null;
    }
    if (this._workflowRefreshInterval) {
      clearInterval(this._workflowRefreshInterval);
      this._workflowRefreshInterval = null;
    }
    if (this._recurrenceInterval) {
      clearInterval(this._recurrenceInterval);
      this._recurrenceInterval = null;
    }
    console.log('🔄 Task loop stopped');
  }

  _processRecurringTasks() {
    const now = Date.now();
    for (const [agentId, agent] of this.agents) {
      if (!agent.todoList) continue;
      for (const task of agent.todoList) {
        if (!task.recurrence?.enabled) continue;
        if (task.status !== 'done') continue;
        if (!task.completedAt) continue;
        const completedAt = new Date(task.completedAt).getTime();
        const intervalMs = (task.recurrence.intervalMinutes || 1440) * 60 * 1000;
        if (now - completedAt >= intervalMs) {
          const resetStatus = task.recurrence.originalStatus || 'pending';
          console.log(`🔁 [Recurrence] Resetting task "${task.text.slice(0, 60)}" → ${resetStatus} (interval: ${task.recurrence.intervalMinutes}min)`);
          task.status = resetStatus;
          task.completedAt = null;
          task.startedAt = null;
          if (!task.history) task.history = [];
          task.history.push({ from: 'done', status: resetStatus, at: new Date().toISOString(), by: 'recurrence' });
          saveAgent(agent);
          this._emit('agent:updated', this._sanitize(agent));
        }
      }
    }
  }

  _processNextPendingTasks() {
    // Re-evaluate conditional transitions for tasks waiting on conditions
    this._recheckConditionalTransitions();

    for (const [agentId, agent] of this.agents) {
      // Skip disabled, non-idle, or already being processed by the loop
      if (agent.enabled === false) continue;
      if (agent.status !== 'idle') continue;
      if (this._loopProcessing.has(agentId)) continue;

      // Priority 1: resume in_progress tasks assigned to this agent (check own list + other lists)
      // Skip if workflow manages in_progress transitions (conditions will handle the move)
      let inProgressTask = null;
      let inProgressCreatorId = null;
      // Check own list first
      const ownInProgress = agent.todoList?.find(t =>
        t.status === 'in_progress' && (!t.assignee || t.assignee === agentId)
      );
      if (ownInProgress) {
        inProgressTask = ownInProgress;
        inProgressCreatorId = agentId;
      } else {
        // Check other agents' lists for tasks assigned to this agent
        for (const [oid, oa] of this.agents) {
          if (oid === agentId || !oa.todoList) continue;
          const found = oa.todoList.find(t => t.status === 'in_progress' && t.assignee === agentId);
          if (found) { inProgressTask = found; inProgressCreatorId = oid; break; }
        }
      }
      if (inProgressTask) {
        if (this._workflowManagedStatuses?.has('in_progress')) continue;
        this._loopProcessing.add(agentId);
        console.log(`🔄 [TaskLoop] Agent "${agent.name}" is idle but has in_progress task "${inProgressTask.text.slice(0, 60)}" — resuming`);
        this._resumeInProgressTask(inProgressCreatorId, this.agents.get(inProgressCreatorId), inProgressTask).finally(() => {
          this._loopProcessing.delete(agentId);
        });
        continue;
      }

      // Priority 2: pick up the first pending task — but skip tasks managed by workflow transitions
      // Only pick up tasks where this agent is the assignee (or creator when no assignee is set)
      const task = agent.todoList?.find(t =>
        t.status === 'pending' && (!t.assignee || t.assignee === agentId)
      );
      if (!task) continue;

      // Check if there's a workflow transition for this status — if so, let the workflow handle it
      if (this._workflowManagedStatuses?.has(task.status)) continue;

      // Mark as being processed by the loop to avoid double-pickup on next tick
      this._loopProcessing.add(agentId);

      // Build a streamCallback that broadcasts to all connected clients
      const streamCallback = (chunk) => {
        this._emit('agent:stream:chunk', { agentId, chunk });
        this._emit('agent:thinking', {
          agentId,
          thinking: agent.currentThinking || ''
        });
      };

      this._emit('agent:stream:start', { agentId });

      this.executeTask(agentId, task.id, streamCallback)
        .then(() => {
          this._emit('agent:stream:end', { agentId });
          this._emit('agent:updated', this._sanitize(agent));
        })
        .catch((err) => {
          if (err) {
            console.error(`🔄 Task loop error for ${agent.name}:`, err.message);
            this._emit('agent:stream:error', { agentId, error: err.message });
          }
          // Recover agent to idle so the task loop can pick up remaining tasks
          if (agent.status === 'error') {
            this.setStatus(agentId, 'idle', 'Auto-recovered after task error');
          }
        })
        .finally(() => {
          this._loopProcessing.delete(agentId);
        });
    }
  }

  /**
   * Wait for the executing agent to call @task_execution_complete.
   * Checks immediately after sendMessage returns, then enters a 5-min reminder loop.
   * Shared by both processTransition (workflow path) and _resumeInProgressTask (task loop path).
   * Returns: 'completed' | 'error' | 'moved' | 'stopped' | 'deleted' | 'timeout'
   */
  async _waitForExecutionComplete(creatorAgentId, taskId, executorId, executorName, targetStatus, taskText) {
    const freshTask = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);

    // Helper: resolve the status to move to on completion.
    // If targetStatus is null (execute mode from workflow action chain),
    // restore to the column the task was in before in_progress so the chain continues.
    const resolveCompletionStatus = (task) => {
      if (targetStatus) return targetStatus;
      return task?.inProgressFromStatus || 'done';
    };

    if (freshTask?.status === 'error') {
      console.log(`[Execution] Task "${taskText.slice(0, 60)}" ended with error — blocking transition`);
      return 'error';
    }

    if (freshTask?._executionCompleted) {
      const comment = freshTask._executionComment || '';
      delete freshTask._executionCompleted;
      delete freshTask._executionComment;
      const completionStatus = resolveCompletionStatus(freshTask);
      this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: !targetStatus, by: executorName });
      console.log(`✅ [Execution] task_execution_complete for "${taskText.slice(0, 60)}" -> ${completionStatus}${comment ? ` (${comment.slice(0, 80)})` : ''}`);
      return 'completed';
    }

    if (freshTask && freshTask.status !== 'in_progress') {
      console.log(`[Execution] Task "${taskText.slice(0, 60)}" already moved to "${freshTask.status}" — accepting`);
      return 'moved';
    }

    // Agent went idle without calling task_execution_complete — start reminder loop
    console.log(`🔔 [Execution] Agent "${executorName}" went idle without completing "${taskText.slice(0, 60)}" — starting reminder loop`);
    const REMINDER_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
    const MAX_REMINDERS = 12; // 1 hour max
    let reminded = 0;

    while (reminded < MAX_REMINDERS) {
      await new Promise(resolve => setTimeout(resolve, REMINDER_INTERVAL_MS));

      const currentTask = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (!currentTask) {
        console.log(`🔔 [Execution] Task deleted during reminder wait — exiting loop`);
        return 'deleted';
      }
      if (currentTask._executionCompleted) {
        const comment = currentTask._executionComment || '';
        delete currentTask._executionCompleted;
        delete currentTask._executionComment;
        const completionStatus = resolveCompletionStatus(currentTask);
        this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: !targetStatus, by: executorName });
        console.log(`✅ [Execution] Completed during wait: "${taskText.slice(0, 60)}" -> ${completionStatus}`);
        return 'completed';
      }
      if (currentTask.status !== 'in_progress') {
        console.log(`🔔 [Execution] Task status changed to "${currentTask.status}" — exiting loop`);
        return 'moved';
      }
      if (currentTask._executionStopped) {
        console.log(`🛑 [Execution] Task was manually stopped — exiting reminder loop`);
        delete currentTask._executionStopped;
        return 'stopped';
      }

      const currentExecutor = this.agents.get(executorId);
      if (!currentExecutor || currentExecutor.status === 'busy') {
        console.log(`🔔 [Execution] Executor "${executorName}" is busy — skipping reminder`);
        continue;
      }
      if (currentExecutor.status === 'error') {
        console.log(`🔔 [Execution] Executor "${executorName}" is in error — exiting reminder loop`);
        return 'error';
      }

      reminded++;
      console.log(`🔔 [Execution] Reminding "${executorName}" to complete task (attempt ${reminded}/${MAX_REMINDERS})`);

      this._emit('agent:stream:start', { agentId: executorId });
      try {
        const reminderStartIdx = currentExecutor.conversationHistory.length;
        const reminderStartedAt = new Date().toISOString();

        await this.sendMessage(
          executorId,
          `[SYSTEM REMINDER] You have an in-progress task that is not yet complete:\n"${taskText.slice(0, 300)}"\n\nPlease finish your work on this task. When you are done, you MUST call @task_execution_complete(summary of what was done) to signal completion.\n\nIf you have already finished all the work, call @task_execution_complete now with a summary of what was accomplished.`,
          (chunk) => {
            this._emit('agent:stream:chunk', { agentId: executorId, chunk });
            this._emit('agent:thinking', {
              agentId: executorId,
              thinking: currentExecutor.currentThinking || ''
            });
          }
        );

        this._saveExecutionLog(creatorAgentId, taskId, executorId, reminderStartIdx, reminderStartedAt, true);
      } catch (reminderErr) {
        console.error(`🔔 [Execution] Reminder failed: ${reminderErr.message}`);
      }
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(currentExecutor));

      // Check completion after reminder
      const afterReminder = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (afterReminder?._executionCompleted) {
        const comment = afterReminder._executionComment || '';
        delete afterReminder._executionCompleted;
        delete afterReminder._executionComment;
        const completionStatus = resolveCompletionStatus(afterReminder);
        this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: !targetStatus, by: executorName });
        console.log(`✅ [Execution] Completed after reminder: "${taskText.slice(0, 60)}" -> ${completionStatus}`);
        return 'completed';
      }
    }

    if (reminded >= MAX_REMINDERS) {
      const finalTask = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (finalTask && finalTask.status === 'in_progress' && !finalTask._executionCompleted) {
        console.warn(`⚠️ [Execution] Max reminders (${MAX_REMINDERS}) reached for "${taskText.slice(0, 60)}" — task remains in_progress`);
        this.addActionLog(executorId, 'warning', `Task reminder limit reached — task remains in_progress`, taskText.slice(0, 200));
      }
      return 'timeout';
    }

    return 'unknown';
  }

  /**
   * Resume an in_progress task when the assignee agent is idle.
   * Sends the task text directly to the assignee and moves to done on success.
   * The agentId parameter is the todoList creator; execution uses the assignee.
   */
  async _resumeInProgressTask(agentId, agent, task) {
    // Use the assignee agent for execution (fall back to creator if no assignee set)
    const executorId = task.assignee || agentId;
    const executor = this.agents.get(executorId) || agent;

    const streamCallback = (chunk) => {
      this._emit('agent:stream:chunk', { agentId: executorId, chunk });
      this._emit('agent:thinking', {
        agentId: executorId,
        thinking: executor.currentThinking || ''
      });
    };

    this._emit('agent:stream:start', { agentId: executorId });

    // Track conversation index for execution log (declared outside try for catch access)
    let startMsgIdx = executor.conversationHistory.length;
    let executionStartedAt = new Date().toISOString();

    try {
      // Check if there's a workflow transition from in_progress that defines a target status
      let targetStatus = 'done';
      try {
        const workflow = await getWorkflowForBoard(task.boardId);
        const transition = workflow.transitions.find(t => {
          if (t.from !== 'in_progress') return false;
          // New format: look for run_agent action with a targetStatus
          if (this._validTransition(t)) {
            return (t.actions || []).some(a => a.type === 'run_agent' && a.targetStatus);
          }
          // Old format fallback
          return t.autoRefine && (t.mode === 'execute' || t.mode === 'decide' || t.agent);
        });
        if (transition) {
          if (this._validTransition(transition)) {
            const runAction = (transition.actions || []).find(a => a.type === 'run_agent' && a.targetStatus);
            if (runAction?.targetStatus) targetStatus = runAction.targetStatus;
          } else if (transition.to) {
            targetStatus = transition.to;
          }
        }
      } catch (_) { /* use default */ }

      // Auto-switch executor to the task's project if needed
      if (task.project && task.project !== executor.project) {
        console.log(`🔄 [TaskLoop] Switching "${executor.name}" to project "${task.project}" for resume`);
        if (this._switchProjectContext) {
          this._switchProjectContext(executor, executor.project, task.project);
        }
        executor.project = task.project;
      }

      // Clear any previous stop flag (task may be re-executed after a stop)
      delete task._executionStopped;
      delete task._executionCompleted;
      delete task._executionComment;

      // Update conversation start index right before execution
      startMsgIdx = executor.conversationHistory.length;
      executionStartedAt = new Date().toISOString();

      const result = await this.sendMessage(
        executorId,
        task.text,
        streamCallback
      );

      // Save execution chat log to task history
      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, true);

      // Wait for agent to signal completion via @task_execution_complete (or enter reminder loop)
      await this._waitForExecutionComplete(agentId, task.id, executorId, executor.name, targetStatus, task.text);
    } catch (err) {
      console.error(`🔄 [TaskLoop] Error resuming task for ${executor.name}:`, err.message);
      this._emit('agent:stream:error', { agentId: executorId, error: err.message });

      // Save execution chat log even on error
      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, false);

      // Mark the task as error — stays in its current column (via errorFromStatus) and blocks auto-transitions
      this.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true, by: executor.name });
      // Store the error message on the task for display
      const actualTask = this.agents.get(agentId)?.todoList?.find(t => t.id === task.id);
      if (actualTask) {
        actualTask.error = err.message;
        saveAgent(this.agents.get(agentId));
      }
      if (executor.status === 'error') {
        this.setStatus(executorId, 'idle', 'Auto-recovered after resume error');
      }
    } finally {
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(executor));
    }
  }

  /**
   * Per-agent sequential task queue.
   * Tasks are added instantly (returns a Promise) but execute one at a time.
   * Multiple callers can enqueue concurrently — the queue serialises execution.
   */
  _enqueueAgentTask(agentId, taskFn) {
    if (!this._taskQueues.has(agentId)) {
      this._taskQueues.set(agentId, Promise.resolve());
    }

    // Chain the new task after whatever is currently running/queued
    const resultPromise = this._taskQueues.get(agentId).then(
      () => taskFn(),
      () => taskFn()   // If the previous task rejected, still run the next one
    );

    // Update the queue tail (ignore rejections so the chain never breaks)
    this._taskQueues.set(agentId, resultPromise.catch(() => {}));

    return resultPromise;
  }

  _sanitize(agent) {
    const { apiKey, mcpAuth, ...rest } = agent;
    // Mask per-server API keys: { serverId: { apiKey: '...' } } → { serverId: { hasApiKey: true } }
    const sanitizedMcpAuth = {};
    if (mcpAuth && typeof mcpAuth === 'object') {
      for (const [serverId, conf] of Object.entries(mcpAuth)) {
        sanitizedMcpAuth[serverId] = { hasApiKey: !!conf?.apiKey };
      }
    }
    const sanitized = { ...rest, hasApiKey: !!apiKey, mcpAuth: sanitizedMcpAuth };
    // Resolve display provider/model from LLM config so cards show the current LLM
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

    // Throttle agent:updated to avoid flooding clients with rapid-fire updates
    // for the same agent (e.g. during delegation: task created → in_progress → done)
    if (event === 'agent:updated' && data?.id) {
      const agentId = data.id;
      // Always store the latest data
      this._updatePending.set(agentId, data);

      // If a timer is already running, let it fire with the latest data
      if (this._updateTimers.has(agentId)) return;

      // Set a short debounce window (300ms) — batches rapid emissions
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

    // For agent:created / agent:deleted, route by ownerId in the payload
    if ((event === 'agent:created' || event === 'agent:deleted') && data?.ownerId) {
      this.io.to(`user:${data.ownerId}`).emit(event, data);
      return;
    }

    // For all other agent events, look up the owner from the agents map
    const agentId = data?.id || data?.agentId;
    if (agentId) {
      const agent = this.agents.get(agentId);
      if (agent?.ownerId) {
        this.io.to(`user:${agent.ownerId}`).emit(event, data);
        return;
      }
    }

    // Fallback: unowned agent or no agentId → broadcast to all
    this.io.emit(event, data);
  }

  /**
   * Emit an event only to users who own the agent.
   * Unowned agents are broadcast to everyone.
   */
  _emitToOwner(event, data) {
    if (!this.io) return;
    const ownerId = data?.ownerId;
    if (ownerId) {
      this.io.to(`user:${ownerId}`).emit(event, data);
    } else {
      // Unowned agent → everyone can see it
      this.io.emit(event, data);
    }
  }

  /** Force-flush any pending throttled agent:updated for a specific agent */
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

  /**
   * Format a duration in milliseconds to a human-readable string.
   * E.g. 3661000 → "1h 1m", 120000 → "2m", 86400000 → "1d 0h"
   */
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