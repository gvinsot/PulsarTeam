// ─── Agent Status: getAgentStatus, swarm status, setStatus, stopAgent ───────
import { saveAgent, clearActionRunningForAgent, saveTaskToDb, getTasksByAgent, getAllTasks, getTasksByAssignee, getTaskByActionRunningAgent } from '../database.js';
import { getTaskSignal, setTaskSignal } from './tasks.js';
import { isCliRunner } from '../runners.js';

function requestCliTerminalInterrupt(manager: any, agent: any): void {
  if (!manager?.executionManager || !agent?.id) return;
  const provider = manager.executionManager.getProviderType?.(agent.id);
  if (!isCliRunner(agent) && (!provider || provider === 'sandbox')) return;
  const interrupt =
    manager.executionManager.interruptCliTerminalSessions
    || manager.executionManager.interruptTerminalSession;
  if (!interrupt) return;
  Promise.resolve(interrupt.call(manager.executionManager, agent.id))
    .then((sent: boolean) => {
      if (sent) {
        console.log(`🛑 [Execution] Sent CLI interrupt to ${agent.name || agent.id}`);
      }
    })
    .catch((err: any) => {
      console.warn(`⚠️ [Execution] CLI interrupt failed for ${(agent.name || agent.id)}: ${err?.message || err}`);
    });
}

/** @this {import('./index.js').AgentManager} */
export const statusMethods = {

  /** Apply the shared "mark task stopped" mutation: set executionStatus,
   * clear startedAt, push a {type:'stopped', by:'user'} history entry, and
   * persist. Does NOT set the task signal or emit task:updated — each stopAgent
   * loop keeps its own guard/signal/emit because those differ per block. */
  _markTaskStopped(this: any, t: any, ownerAgentId: string | null, stopTimestamp: string): void {
    t.executionStatus = 'stopped';
    t.startedAt = null;
    if (!t.history) t.history = [];
    t.history.push({
      status: t.status,
      at: stopTimestamp,
      by: 'user',
      type: 'stopped',
    });
    saveTaskToDb({ ...t, agentId: ownerAgentId });
  },

  /** Fetch every live task once and group by owning agentId. Board-level tasks
   * (agentId = null) belong to no agent's todoList — matching the prior
   * agent-keyed store — so they are skipped. Used by the bulk status getters to
   * avoid an N+1 per-agent query. */
  async _tasksByAgentMap(this: any): Promise<Map<string, any[]>> {
    const all = await getAllTasks();
    const byAgent = new Map<string, any[]>();
    for (const t of all) {
      if (!t.agentId) continue;
      let list = byAgent.get(t.agentId);
      if (!list) { list = []; byAgent.set(t.agentId, list); }
      list.push(t);
    }
    return byAgent;
  },

  async getAgentStatus(this: any, id: string): Promise<any> {
    const agent = this.agents.get(id);
    if (!agent) return null;
    return this._buildAgentStatus(agent, await getTasksByAgent(id));
  },

  /** Build the status snapshot for an agent from a pre-fetched todoList (its
   * owned tasks). Synchronous so the bulk getters can map over a grouped set
   * without a per-agent await. */
  _buildAgentStatus(this: any, agent: any, todoList: any[]): any {
    const id = agent.id;
    const waitingTasks = todoList.filter((t: any) => !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error').length;
    const activeTaskCount = todoList.filter((t: any) => this._isActiveTaskStatus(t.status)).length;
    const doneTasks = todoList.filter((t: any) => t.status === 'done').length;
    const errorTasks = todoList.filter((t: any) => t.status === 'error').length;
    const totalTasks = todoList.length;
    const msgCount = (agent.conversationHistory || []).length;
    const hasSandbox = this.executionManager ? this.executionManager.hasEnvironment(agent.id) : false;

    const currentTaskEntry = todoList.find((t: any) => this._isActiveTaskStatus(t.status));
    const currentTask = agent.currentTask || (currentTaskEntry ? currentTaskEntry.text : null);
    const resolvedLlm = this.resolveLlmConfig(agent);

    const activeTasks = todoList
      .filter((t: any) => t.status !== 'done')
      .map((t: any) => ({ id: t.id, text: t.text, status: t.status, startedAt: t.startedAt || null }));

    let projectDurationMs: number | null = null;
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
      provider: resolvedLlm.provider || null,
      model: resolvedLlm.model || null,
      enabled: agent.enabled !== false,
      isLeader: agent.isLeader || false,
      runner: agent.runner || null,
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

  async getAllStatuses(this: any, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): Promise<any[]> {
    const agents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    const enabled = (agents as any[]).filter((a: any) => a.enabled !== false);
    const byAgent = await this._tasksByAgentMap();
    return enabled.map((a: any) => this._buildAgentStatus(a, byAgent.get(a.id) || [])).filter(Boolean);
  },

  async getAgentsByProject(this: any, projectName: string, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): Promise<any[]> {
    if (!projectName) return [];
    const agents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    const matched = (agents as any[]).filter((a: any) => a.enabled !== false && (a.project || '').toLowerCase() === projectName.toLowerCase());
    const byAgent = await this._tasksByAgentMap();
    return matched.map((a: any) => this._buildAgentStatus(a, byAgent.get(a.id) || [])).filter(Boolean);
  },

  getProjectSummary(this: any, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): any {
    const agents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    const enabled = (agents as any[]).filter((a: any) => a.enabled !== false);
    const projectMap: Record<string, any> = {};
    const unassigned: any[] = [];

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

  async getSwarmStatus(this: any, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): Promise<any> {
    const allAgents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    const enabled = (allAgents as any[]).filter((a: any) => a.enabled !== false);
    const disabled = (allAgents as any[]).filter((a: any) => a.enabled === false);
    const byAgent = await this._tasksByAgentMap();
    const statusOf = (a: any) => this._buildAgentStatus(a, byAgent.get(a.id) || []);

    const projectMap: Record<string, any[]> = {};
    const unassigned: any[] = [];
    for (const agent of enabled) {
      const status = statusOf(agent);
      if (agent.project) {
        if (!projectMap[agent.project]) projectMap[agent.project] = [];
        projectMap[agent.project].push(status);
      } else {
        unassigned.push(status);
      }
    }

    const projectSummaries: Record<string, any> = {};
    for (const [project, agents] of Object.entries(projectMap)) {
      projectSummaries[project] = {
        total: agents.length,
        busy: agents.filter((a: any) => a.status === 'busy').length,
        idle: agents.filter((a: any) => a.status === 'idle').length,
        error: agents.filter((a: any) => a.status === 'error').length,
        agents: agents.map((a: any) => ({
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
        total: (allAgents as any[]).length,
        enabled: enabled.length,
        disabled: disabled.length,
        busy: enabled.filter((a: any) => a.status === 'busy').length,
        idle: enabled.filter((a: any) => a.status === 'idle').length,
        error: enabled.filter((a: any) => a.status === 'error').length,
        withProject: enabled.filter((a: any) => a.project).length,
        withoutProject: enabled.filter((a: any) => !a.project).length,
        activeProjects: Object.keys(projectMap)
      },
      projectSummaries,
      projectAssignments: projectMap,
      unassignedAgents: unassigned,
      agents: enabled.map((a: any) => statusOf(a))
    };
  },

  setStatus(this: any, id: string, status: string, detail: string | null = null): void {
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
      // Emit system error report so the leader + frontend get notified
      // the same way as agent-reported errors (via @report_error)
      this._emit('agent:error:report', {
        agentId: id,
        agentName: agent.name,
        project: agent.project || null,
        description: `[System Error] ${detail || 'Unknown error'}`,
        timestamp: new Date().toISOString(),
        isSystemError: true,
      });
      this._recheckConditionalTransitions();
    }

    // Flush AFTER addActionLog so the emitted data includes the new log
    // entry and the current agent state (not a stale snapshot).
    if (status === 'idle' || status === 'error') {
      this._flushAgentUpdate(id);
    }
  },

  stopAgent(this: any, id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;

    requestCliTerminalInterrupt(this, agent);

    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    this._taskQueues.delete(id);

    if (agent.isLeader) {
      for (const [subId, subAgent] of this.agents) {
        if (subId !== id && (subAgent as any).status === 'busy') {
          requestCliTerminalInterrupt(this, subAgent);
          const subCtrl = this.abortControllers.get(subId);
          if (subCtrl) {
            subCtrl.abort();
            this.abortControllers.delete(subId);
          }
          this._taskQueues.delete(subId);
          (subAgent as any).currentThinking = '';
          this._emit('agent:thinking', { agentId: subId, agentName: (subAgent as any).name, project: (subAgent as any).project || null, thinking: '' });
          (subAgent as any).currentTask = null;
          this._chatLocks.delete(subId);
          this.setStatus(subId, 'idle', 'Stopped by leader');
          saveAgent(subAgent);
          this._emit('agent:stopped', { id: subId, name: (subAgent as any).name, project: (subAgent as any).project || null });
        }
      }
    }

    const stopTimestamp = new Date().toISOString();
    // Halt the agent's in-flight tasks. Sourced from the DB (the single source of
    // truth) and run fire-and-forget so the synchronous stop path (abort + set
    // idle below) isn't blocked on DB round-trips. Signals set here still reach
    // the polling _waitForExecutionComplete loops moments later.
    this._haltAgentTasks(id, stopTimestamp).catch((err: any) =>
      console.warn(`⚠️ [stopAgent] halting tasks for ${id} failed: ${err?.message || err}`));

    agent.currentThinking = '';
    this._emit('agent:thinking', { agentId: id, agentName: agent.name, project: agent.project || null, thinking: '' });
    agent.currentTask = null;
    this._chatLocks.delete(id);
    this.setStatus(id, 'idle', 'Agent stopped by user');
    saveAgent(agent);

    console.log(`🛑 Agent ${agent.name} stopped`);
    this._emit('agent:stopped', { id, name: agent.name, project: agent.project || null });
    return true;
  },

  /** Mark every in-flight task this agent is executing as stopped. The candidate
   * set is the DB union of: tasks it owns (active), tasks assigned to it (active,
   * started or being watched), and the task carrying its in-flight action_running
   * flag. Clears action_running, pushes a stopped history entry (via
   * _markTaskStopped), sets the 'stopped' signal so a waiting reminder loop exits,
   * and emits task:updated. Board-level (ownerless) tasks emit under their own
   * agentId = null. */
  async _haltAgentTasks(this: any, id: string, stopTimestamp: string): Promise<void> {
    // Capture the running task BEFORE clearing the DB flags below.
    const running = await getTaskByActionRunningAgent(id);
    clearActionRunningForAgent(id);

    const owned = (await getTasksByAgent(id)).filter((t: any) => this._isActiveTaskStatus(t.status));
    const assigned = (await getTasksByAssignee(id)).filter((t: any) =>
      this._isActiveTaskStatus(t.status) && (t.startedAt || getTaskSignal(t.id, 'watching')));

    const halt = new Map<string, any>();
    for (const t of [...owned, ...assigned, ...(running ? [running] : [])]) {
      if (!halt.has(t.id)) halt.set(t.id, t);
    }
    for (const t of halt.values()) {
      const ownerId = t.agentId || null;
      t.actionRunning = false;
      delete t.actionRunningAgentId;
      delete t.actionRunningMode;
      if (this._isActiveTaskStatus(t.status)) {
        this._markTaskStopped(t, ownerId, stopTimestamp);
      }
      setTaskSignal(t.id, 'stopped', true);
      this._emit('task:updated', { agentId: ownerId, task: { ...t, agentId: ownerId } });
    }
  },
};
