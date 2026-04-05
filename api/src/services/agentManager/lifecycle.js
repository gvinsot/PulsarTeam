// ─── Agent Lifecycle: CRUD, Getters, Status, Stats, Broadcast, Handoff, Logs,
//     RAG, Skills, MCP, Voice, Conversation ────────────────────────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent, deleteAgentFromDb, setAgentOwner, clearTaskExecutionFlags, clearActionRunningForAgent, saveTaskToDb } from '../database.js';
import { transferUserFiles } from './helpers.js';
import { AGENT_TEMPLATES } from '../../data/templates.js';

/** @this {import('./index.js').AgentManager} */
export const lifecycleMethods = {

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
    this._tasks.set(id, config.todoList || []);
    await saveAgent(agent);
    if (config.ownerId) {
      await setAgentOwner(id, config.ownerId);
    }
    this._emit('agent:created', this._sanitize(agent));
    return this._sanitize(agent);
  },

  getAll() {
    return Array.from(this.agents.values()).map(a => this._sanitize(a));
  },

  getAllForUser(userId, role) {
    return Array.from(this.agents.values())
      .filter(a => a.ownerId === userId || !a.ownerId)
      .map(a => this._sanitize(a));
  },

  _agentsForUser(userId, role) {
    return Array.from(this.agents.values())
      .filter(a => a.ownerId === userId || !a.ownerId);
  },

  getById(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._sanitize(agent);
  },

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
  },

  getLastMessagesByName(agentName, limit = 1) {
    if (!agentName) return null;
    const target = Array.from(this.agents.values()).find(
      a => (a.name || '').toLowerCase() === String(agentName).toLowerCase()
    );
    if (!target) return null;
    return this.getLastMessages(target.id, limit);
  },

  getAgentStatus(id) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const todoList = this._getAgentTasks(id);
    const waitingTasks = todoList.filter(t => !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error').length;
    const activeTaskCount = todoList.filter(t => this._isActiveTaskStatus(t.status)).length;
    const doneTasks = todoList.filter(t => t.status === 'done').length;
    const errorTasks = todoList.filter(t => t.status === 'error').length;
    const totalTasks = todoList.length;
    const msgCount = (agent.conversationHistory || []).length;
    const hasSandbox = this.executionManager ? this.executionManager.hasEnvironment(agent.id) : false;

    const currentTaskEntry = todoList.find(t => this._isActiveTaskStatus(t.status));
    const currentTask = agent.currentTask || (currentTaskEntry ? currentTaskEntry.text : null);

    const activeTasks = todoList
      .filter(t => t.status !== 'done')
      .map(t => ({ id: t.id, text: t.text, status: t.status, startedAt: t.startedAt || null }));

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
        waiting: waitingTasks,
        active: activeTaskCount,
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
  },

  getAllStatuses(userId = null, role = null) {
    const agents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    return agents
      .filter(a => a.enabled !== false)
      .map(a => this.getAgentStatus(a.id))
      .filter(Boolean);
  },

  getAgentsByProject(projectName, userId = null, role = null) {
    if (!projectName) return [];
    const agents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    return agents
      .filter(a => a.enabled !== false && (a.project || '').toLowerCase() === projectName.toLowerCase())
      .map(a => this.getAgentStatus(a.id))
      .filter(Boolean);
  },

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
  },

  _collectTasks(projectFilter = null) {
    const tasks = [];
    for (const agent of this.agents.values()) {
      const tasks_ = this._getAgentTasks(agent.id);
      if (!tasks_.length) continue;
      for (const t of tasks_) {
        const proj = t.project || agent.project || null;
        if (projectFilter && proj !== projectFilter) continue;
        tasks.push({ ...t, _agentId: agent.id, _project: proj });
      }
    }
    return tasks;
  },

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
  },

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
  },

  getAgentTimeSeries(projectFilter = null, days = 30) {
    const tasks = this._collectTasks(projectFilter);
    const now = new Date();
    const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const toDay = (d) => d.toISOString().slice(0, 10);

    const ACTIVE_STATES = new Set(['pending', 'in_progress', 'code', 'build', 'test', 'deploy', 'review']);

    // Build a map: agentId -> agentName
    const agentNames = {};
    for (const agent of this.agents.values()) {
      agentNames[agent.id] = agent.name || agent.id.slice(0, 8);
    }

    // dailyAgent: { "2026-03-20": { "agentId1": msTotal, "agentId2": msTotal } }
    const dailyAgent = {};

    for (const t of tasks) {
      const agentId = t.assignee || t.agentId || t._agentId;
      if (!agentId) continue;

      // Build timeline from history entries
      const events = [];
      if (t.history?.length) {
        for (const h of t.history) {
          if (h.at) {
            events.push({ at: new Date(h.at).getTime(), status: h.status || h.to || null });
          }
        }
      }
      // If task was started but has no history transitions, use startedAt -> completedAt/now
      if (events.length === 0 && t.startedAt) {
        const start = new Date(t.startedAt).getTime();
        const end = t.completedAt ? new Date(t.completedAt).getTime() : now.getTime();
        events.push({ at: start, status: t.status });
        events.push({ at: end, status: 'done' });
      }

      if (events.length < 2) continue;
      events.sort((a, b) => a.at - b.at);

      // Walk through consecutive pairs and attribute active time
      for (let i = 0; i < events.length - 1; i++) {
        const state = events[i].status;
        if (!state || !ACTIVE_STATES.has(state)) continue;

        const start = Math.max(events[i].at, cutoff.getTime());
        const end = Math.min(events[i + 1].at, now.getTime());
        if (end <= start) continue;

        // Distribute across days
        let cursor = new Date(start);
        while (cursor.getTime() < end) {
          const dayStr = toDay(cursor);
          const dayEnd = new Date(cursor);
          dayEnd.setUTCHours(23, 59, 59, 999);
          const segEnd = Math.min(dayEnd.getTime() + 1, end);
          const ms = segEnd - cursor.getTime();

          if (ms > 0) {
            if (!dailyAgent[dayStr]) dailyAgent[dayStr] = {};
            dailyAgent[dayStr][agentId] = (dailyAgent[dayStr][agentId] || 0) + ms;
          }

          // Move to next day
          cursor = new Date(dayEnd.getTime() + 1);
        }
      }
    }

    // Build date range
    const allDays = [];
    for (let d = new Date(cutoff); d <= now; d.setDate(d.getDate() + 1)) {
      allDays.push(d.toISOString().slice(0, 10));
    }

    // Collect all agents that appear
    const agentSet = new Set();
    for (const dayData of Object.values(dailyAgent)) {
      for (const id of Object.keys(dayData)) agentSet.add(id);
    }

    const agents = Array.from(agentSet).map(id => ({
      id,
      name: agentNames[id] || id.slice(0, 8),
    }));

    const daily = allDays.map(date => {
      const agentTimes = {};
      for (const a of agents) {
        agentTimes[a.id] = dailyAgent[date]?.[a.id] || 0;
      }
      return { date, agentTimes };
    });

    // Totals
    let totalMs = 0;
    for (const d of daily) {
      for (const ms of Object.values(d.agentTimes)) totalMs += ms;
    }
    const daysWithData = daily.filter(d => Object.values(d.agentTimes).some(ms => ms > 0)).length;
    const avgDailyMs = daysWithData > 0 ? Math.round(totalMs / daysWithData) : 0;

    return { agents, daily, totalMs, avgDailyMs };
  },

  getSwarmStatus(userId = null, role = null) {
    const allAgents = (userId && role) ? this._agentsForUser(userId, role) : Array.from(this.agents.values());
    const enabled = allAgents.filter(a => a.enabled !== false);
    const disabled = allAgents.filter(a => a.enabled === false);

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
  },

  async update(id, updates) {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const allowed = [
      'name', 'role', 'description', 'instructions', 'temperature',
      'maxTokens', 'contextLength', 'ragDocuments', 'skills', 'mcpServers', 'mcpAuth', 'handoffTargets',
      'color', 'icon', 'provider', 'model', 'endpoint', 'apiKey', 'project', 'isLeader', 'isVoice', 'isReasoning', 'voice', 'enabled',
      'costPerInputToken', 'costPerOutputToken', 'llmConfigId', 'ownerId'
    ];

    for (const key of allowed) {
      if (updates[key] !== undefined) {
        if (key === 'apiKey' && !updates[key] && agent[key]) continue;
        if (key === 'ownerId' && updates[key] !== agent[key]) {
          agent[key] = updates[key];
          setAgentOwner(agent.id, updates[key]);
          continue;
        }
        if (key === 'mcpAuth') {
          if (!agent.mcpAuth) agent.mcpAuth = {};
          for (const [serverId, conf] of Object.entries(updates.mcpAuth || {})) {
            if (conf?.apiKey) {
              agent.mcpAuth[serverId] = { apiKey: conf.apiKey };
            } else {
              delete agent.mcpAuth[serverId];
            }
          }
          if (this.mcpManager) {
            this.mcpManager.disconnectAgent(id).catch(() => {});
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
  async resetInstructionsByRole(role) {
    const template = AGENT_TEMPLATES.find(t => t.role === role);
    if (!template) return { error: 'no_template', reset: [] };

    const reset = [];
    for (const [id, agent] of this.agents) {
      if (agent.role !== role) continue;
      agent.instructions = template.instructions;
      agent.updatedAt = new Date().toISOString();
      await saveAgent(agent);
      this._emit('agent:updated', this._sanitize(agent));
      reset.push(id);
    }
    return { error: null, reset };
  },

  async delete(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;
    const ownerId = this.agents.get(id)?.ownerId || null;
    if (this.executionManager) {
      this.executionManager.destroySandbox(id).catch(err => {
        console.error(`Failed to destroy execution environment for agent ${id}:`, err.message);
      });
    }
    if (this.mcpManager) {
      this.mcpManager.disconnectAgent(id).catch(err => {
        console.error(`Failed to disconnect MCP for agent ${id}:`, err.message);
      });
    }
    this.agents.delete(id);
    await deleteAgentFromDb(id);
    this._emit('agent:deleted', { id, ownerId });
    return true;
  },

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
  },

  setStatus(id, status, detail = null) {
    const agent = this.agents.get(id);
    if (!agent) return;
    const prev = agent.status;
    agent.status = status;

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

    if (status === 'busy' && prev !== 'busy') {
      const taskInfo = agent.currentTask ? ` — ${agent.currentTask.slice(0, 150)}` : '';
      this.addActionLog(id, 'busy', (detail || 'Agent started working') + taskInfo);
    } else if (status === 'idle' && prev !== 'idle') {
      this.addActionLog(id, 'idle', detail || 'Agent finished working');
      this._recheckConditionalTransitions();
    } else if (status === 'error') {
      this.addActionLog(id, 'error', 'Agent encountered an error', detail);
      this._recheckConditionalTransitions();
    }

    // Flush AFTER addActionLog so the emitted data includes the new log
    // entry and the current agent state (not a stale snapshot).
    if (status === 'idle' || status === 'error') {
      this._flushAgentUpdate(id);
    }
  },

  stopAgent(id) {
    const agent = this.agents.get(id);
    if (!agent) return false;

    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    this._taskQueues.delete(id);

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

    for (const t of this._getAgentTasks(id)) {
      if (this._isActiveTaskStatus(t.status)) {
        t._executionStopped = true;
        t.executionStatus = 'stopped';
        saveTaskToDb({ ...t, agentId: id });
      }
    }

    // Clear actionRunning flags for tasks assigned to this agent
    clearActionRunningForAgent(id);
    for (const [creatorId, creatorAgent] of this.agents) {
      for (const t of this._getAgentTasks(creatorId)) {
        if (t.actionRunning && t.actionRunningAgentId === id) {
          t.actionRunning = false;
          delete t.actionRunningAgentId;
          delete t.actionRunningMode;
          this._emit('task:updated', { agentId: creatorAgent.id, task: t });
        }
      }
    }

    agent.currentThinking = '';
    agent.currentTask = null;
    this._chatLocks.delete(id);
    this.setStatus(id, 'idle', 'Agent stopped by user');
    saveAgent(agent);

    console.log(`🛑 Agent ${agent.name} stopped`);
    this._emit('agent:stopped', { id, name: agent.name, project: agent.project || null });
    return true;
  },

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
  },

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

    const fileTransferResult = await transferUserFiles(fromId, toId);

    const response = await this.sendMessage(toId, handoffMessage, streamCallback);

    return {
      ...response,
      fileTransfer: fileTransferResult
    };
  },

  // ─── Action Logs ──────────────────────────────────────────────────
  addActionLog(agentId, type, message, errorDetail = null) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const now = new Date();

    if (agent.actionLogs.length > 0) {
      const lastLog = agent.actionLogs[agent.actionLogs.length - 1];
      if (!lastLog.durationMs) {
        lastLog.durationMs = now.getTime() - new Date(lastLog.timestamp).getTime();
      }
    }

    // Find the current active task for this agent
    let taskId = null;
    let taskTitle = null;
    const ownTask = this._getAgentTasks(agentId).find(t => this._isActiveTaskStatus(t.status) && (!t.assignee || t.assignee === agentId));
    if (ownTask) {
      taskId = ownTask.id;
      taskTitle = ownTask.text?.slice(0, 200) || null;
    } else {
      for (const [otherId] of this.agents) {
        const delegated = this._getAgentTasks(otherId).find(t => this._isActiveTaskStatus(t.status) && t.assignee === agentId);
        if (delegated) { taskId = delegated.id; taskTitle = delegated.text?.slice(0, 200) || null; break; }
      }
    }

    const entry = {
      id: uuidv4(),
      type,
      message,
      error: errorDetail,
      taskId: taskId || null,
      taskTitle: taskTitle || null,
      timestamp: now.toISOString()
    };

    agent.actionLogs.push(entry);
    if (agent.actionLogs.length > 200) {
      agent.actionLogs = agent.actionLogs.slice(-200);
    }

    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return entry;
  },

  clearActionLogs(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.actionLogs = [];
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  // ─── Execution Log ──────────────────────────────────────────────────
  _saveExecutionLog(creatorAgentId, taskId, executorId, startMsgIdx, startedAt, success = true, actionMode = 'execute') {
    const executor = this.agents.get(executorId);
    const creatorAgent = this.agents.get(creatorAgentId);
    if (!executor || !creatorAgent) return;

    const task = this._getAgentTasks(creatorAgentId).find(t => t.id === taskId);
    if (!task) return;

    const rawMessages = executor.conversationHistory.slice(startMsgIdx);

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
  },

  // ─── RAG Document Management ───────────────────────────────────────
  addRagDocument(agentId, name, content) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const doc = { id: uuidv4(), name, content, addedAt: new Date().toISOString() };
    agent.ragDocuments.push(doc);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return doc;
  },

  deleteRagDocument(agentId, docId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.ragDocuments = agent.ragDocuments.filter(d => d.id !== docId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

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
  },

  removeSkill(agentId, skillId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.skills) agent.skills = [];
    agent.skills = agent.skills.filter(id => id !== skillId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

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
  },

  removeMcpServer(agentId, serverId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    if (!agent.mcpServers) agent.mcpServers = [];
    agent.mcpServers = agent.mcpServers.filter(id => id !== serverId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  // ─── Voice Agent Instructions ────────────────────────────────────
  buildVoiceInstructions(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');

    let instructions = agent.instructions || 'You are a helpful voice assistant.';

    const availableAgents = Array.from(this.agents.values())
      .filter(a => a.id !== agentId && a.enabled !== false)
      .map(a => `- ${a.name} (${a.role}): ${a.description || 'No description'}`);

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
      const resolvedSkills = agentSkills.map(sid => this.skillManager.getById(sid)).filter(Boolean);
      if (resolvedSkills.length > 0) {
        instructions += '\n\n--- Active Skills ---\n';
        for (const skill of resolvedSkills) {
          instructions += `\n[${skill.name}]:\n${skill.instructions}\n`;
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

  // ─── Clear Conversation ────────────────────────────────────────────
  clearHistory(agentId) {
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

  truncateHistory(agentId, afterIndex) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const idx = parseInt(afterIndex, 10);
    if (isNaN(idx) || idx < 0) return null;
    agent.conversationHistory = agent.conversationHistory.slice(0, idx + 1);
    agent.conversationHistory = agent.conversationHistory.filter(m => m.type !== 'compaction-summary');
    delete agent._compactionArmed;
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return agent.conversationHistory;
  },

  // ─── Coder Session Reset ────────────────────────────────────────────
  _resetCoderSession(agentId, agent) {
    const llmConfig = this.resolveLlmConfig(agent);
    if (llmConfig.provider !== 'claude-paid') return;
    const endpoint = 'http://coder-service:8000';
    const apiKey = llmConfig.apiKey || process.env.CODER_API_KEY || '';
    fetch(`${endpoint}/reset`, {
      method: 'POST',
      headers: {
        'X-Api-Key': apiKey,
        'X-Agent-Id': agentId,
      },
    }).then(res => {
      if (res.ok) console.log(`🔄 [Session] Reset coder-service session for "${agent.name}"`);
      else console.warn(`⚠️  [Session] Failed to reset coder-service session: ${res.status}`);
    }).catch(err => {
      console.warn(`⚠️  [Session] Failed to reset coder-service session: ${err.message}`);
    });
  },

  // ─── Project Context Switching ──────────────────────────────────────
  _switchProjectContext(agent, oldProject, newProject) {
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
};
