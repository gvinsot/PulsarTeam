// ─── Agent Status: getAgentStatus, swarm status, setStatus, stopAgent ───────
import {
  saveAgent,
  clearActionRunningForAgent,
  updateTaskFields,
  getTaskById,
  getTasksByAgent,
  getAllTasks,
  getTasksByAssignee,
  getTaskByActionRunningAgent,
  getTotalTokensByAgentId,
  getTotalTokensForAgent,
} from '../database.js';
import { getTaskSignal, setTaskSignal } from './tasks.js';
import { isCliRunner } from '../runners.js';
import { getCurrentEnvironment } from '../../lib/environment.js';
import { getAgentRunningTaskId } from '../workflow/agentSelector.js';
import { emitTaskUpdated } from '../taskMutations.js';
import type { Task } from '../database/tasks.js';

function requestCliTerminalInterrupt(manager: any, agent: any): void {
  if (!manager?.executionManager || !agent?.id) return;
  const provider = manager.executionManager.getProviderType?.(agent.id);
  if (!isCliRunner(agent) && (!provider || provider === 'sandbox')) return;
  const interrupt =
    manager.executionManager.interruptCliTerminalSessions ||
    manager.executionManager.interruptTerminalSession;
  if (!interrupt) return;
  Promise.resolve(interrupt.call(manager.executionManager, agent.id))
    .then((sent: boolean) => {
      if (sent) {
        console.log(`🛑 [Execution] Sent CLI interrupt to ${agent.name || agent.id}`);
      }
    })
    .catch((err: any) => {
      console.warn(
        `⚠️ [Execution] CLI interrupt failed for ${agent.name || agent.id}: ${err?.message || err}`
      );
    });
}

/** @this {import('./index.js').AgentManager} */
export const statusMethods = {
  /** Apply the shared "mark task stopped" mutation — a TARGETED write, guarded
   * by the column the task was seen in: the full-row save of the snapshot it
   * replaces landed after a concurrent move (PUT, bulk move) and sent the task
   * back to its old column. Returns the fresh row, or null when the task moved
   * meanwhile (that move already ended the run). */
  async _markTaskStopped(
    this: unknown,
    t: { id: string; status: string },
    stopTimestamp: string
  ): Promise<Task | null> {
    return updateTaskFields(
      t.id,
      {
        executionStatus: 'stopped',
        startedAt: null,
        historyAppend: [{ status: t.status, at: stopTimestamp, by: 'user', type: 'stopped' }],
      },
      { expect: { status: t.status } }
    );
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
      if (!list) {
        list = [];
        byAgent.set(t.agentId, list);
      }
      list.push(t);
    }
    return byAgent;
  },

  /** Reduce a todoList to the { waiting, active, done, error, total } counts
   * the agents view shows. Shares the "active" definition with
   * _buildAgentStatus so the card and the REST/MCP status stay in agreement. */
  _countTasks(
    this: any,
    todoList: any[]
  ): { waiting: number; active: number; done: number; error: number; total: number } {
    const list = todoList || [];
    return {
      waiting: list.filter(
        (t: any) =>
          !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error'
      ).length,
      active: list.filter((t: any) => this._isActiveTaskStatus(t.status)).length,
      done: list.filter((t: any) => t.status === 'done').length,
      error: list.filter((t: any) => t.status === 'error').length,
      total: list.length,
    };
  },

  /** Raise an agent's in-memory token metrics to at least the persisted
   * token_usage_log totals. The card reads agent.metrics, but CLI runners only
   * ever record their spend in token_usage_log (out-of-band), leaving the live
   * metrics at zero. Using max() keeps the value monotonic and consistent with
   * the budget dashboard without ever double-counting inline (chat-stream)
   * usage, since both paths advance the same underlying total. */
  _applyTokenFloor(this: any, agent: any, db: { input: number; output: number } | undefined): void {
    if (!agent) return;
    agent.metrics = agent.metrics || {};
    const dbIn = db?.input || 0;
    const dbOut = db?.output || 0;
    if (dbIn > (agent.metrics.totalTokensIn || 0)) agent.metrics.totalTokensIn = dbIn;
    if (dbOut > (agent.metrics.totalTokensOut || 0)) agent.metrics.totalTokensOut = dbOut;
  },

  /** Refresh the cached runtime stats (task counts + token totals) that the
   * agents view renders, for every in-memory agent. Runs two bulk DB queries
   * total (all tasks + token sums grouped by agent) so the AGENTS_LIST snapshot
   * is accurate without an N+1. Results are stored back on the agent objects so
   * _sanitize surfaces them on every socket payload. */
  async _enrichAllAgentsStats(this: any): Promise<void> {
    let byAgent: Map<string, any[]>;
    let tokens: Map<string, { input: number; output: number }>;
    try {
      [byAgent, tokens] = await Promise.all([this._tasksByAgentMap(), getTotalTokensByAgentId()]);
    } catch (err: any) {
      console.warn(`⚠️ [Stats] enrichAllAgentsStats failed: ${err?.message || err}`);
      return;
    }
    for (const agent of this.agents.values()) {
      agent.tasks = this._countTasks(byAgent.get(agent.id) || []);
      this._applyTokenFloor(agent, tokens.get(agent.id));
    }
  },

  /** Refresh the cached runtime stats for a single agent (used on the
   * per-agent agent:updated emit path). Cheap targeted queries so the debounced
   * update stays light. */
  async _enrichAgentStats(this: any, agentId: string): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    try {
      const [todoList, tokens] = await Promise.all([
        getTasksByAgent(agentId),
        getTotalTokensForAgent(agentId),
      ]);
      agent.tasks = this._countTasks(todoList);
      this._applyTokenFloor(agent, tokens);
    } catch (err: any) {
      console.warn(`⚠️ [Stats] enrichAgentStats failed for ${agentId}: ${err?.message || err}`);
    }
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
    const waitingTasks = todoList.filter(
      (t: any) => !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error'
    ).length;
    const activeTaskCount = todoList.filter((t: any) => this._isActiveTaskStatus(t.status)).length;
    const doneTasks = todoList.filter((t: any) => t.status === 'done').length;
    const errorTasks = todoList.filter((t: any) => t.status === 'error').length;
    const totalTasks = todoList.length;
    const msgCount = (agent.conversationHistory || []).length;
    const hasSandbox = this.executionManager
      ? this.executionManager.hasEnvironment(agent.id)
      : false;

    const currentTaskEntry = todoList.find((t: any) => this._isActiveTaskStatus(t.status));
    const currentTask = agent.currentTask || (currentTaskEntry ? currentTaskEntry.text : null);
    const resolvedLlm = this.resolveLlmConfig(agent);

    const activeTasks = todoList
      .filter((t: any) => t.status !== 'done')
      .map((t: any) => ({
        id: t.id,
        text: t.text,
        status: t.status,
        startedAt: t.startedAt || null,
      }));

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
        total: totalTasks,
      },
      messages: msgCount,
      metrics: {
        totalMessages: agent.metrics?.totalMessages || 0,
        totalTokensIn: agent.metrics?.totalTokensIn || 0,
        totalTokensOut: agent.metrics?.totalTokensOut || 0,
        lastActiveAt: agent.metrics?.lastActiveAt || null,
        errors: agent.metrics?.errors || 0,
      },
      createdAt: agent.createdAt || null,
      updatedAt: agent.updatedAt || null,
    };
  },

  async getAllStatuses(
    this: any,
    userId: string | null = null,
    role: string | null = null,
    userBoardIds?: Set<string>
  ): Promise<any[]> {
    const agents = userId
      ? this._agentsForUser(userId, role, userBoardIds)
      : Array.from(this.agents.values());
    const enabled = (agents as any[]).filter((a: any) => a.enabled !== false);
    const byAgent = await this._tasksByAgentMap();
    return enabled
      .map((a: any) => this._buildAgentStatus(a, byAgent.get(a.id) || []))
      .filter(Boolean);
  },

  async getAgentsByProject(
    this: any,
    projectName: string,
    userId: string | null = null,
    role: string | null = null,
    userBoardIds?: Set<string>
  ): Promise<any[]> {
    if (!projectName) return [];
    const agents = userId
      ? this._agentsForUser(userId, role, userBoardIds)
      : Array.from(this.agents.values());
    const matched = (agents as any[]).filter(
      (a: any) =>
        a.enabled !== false && (a.project || '').toLowerCase() === projectName.toLowerCase()
    );
    const byAgent = await this._tasksByAgentMap();
    return matched
      .map((a: any) => this._buildAgentStatus(a, byAgent.get(a.id) || []))
      .filter(Boolean);
  },

  getProjectSummary(
    this: any,
    userId: string | null = null,
    role: string | null = null,
    userBoardIds?: Set<string>
  ): any {
    const agents = userId
      ? this._agentsForUser(userId, role, userBoardIds)
      : Array.from(this.agents.values());
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
          currentTask: agent.currentTask || null,
        });
      } else {
        unassigned.push({
          id: agent.id,
          name: agent.name,
          status: agent.status,
          role: agent.role || 'worker',
          currentTask: agent.currentTask || null,
        });
      }
    }

    return {
      projects: Object.entries(projectMap).map(([name, data]) => ({
        name,
        ...data,
      })),
      unassigned,
      totalAgents: enabled.length,
      totalProjects: Object.keys(projectMap).length,
    };
  },

  async getSwarmStatus(
    this: any,
    userId: string | null = null,
    role: string | null = null,
    userBoardIds?: Set<string>
  ): Promise<any> {
    const allAgents = userId
      ? this._agentsForUser(userId, role, userBoardIds)
      : Array.from(this.agents.values());
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
          projectChangedAt: a.projectChangedAt || null,
        })),
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
        activeProjects: Object.keys(projectMap),
      },
      projectSummaries,
      projectAssignments: projectMap,
      unassignedAgents: unassigned,
      agents: enabled.map((a: any) => statusOf(a)),
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
      isLeader: agent.isLeader || false,
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
      // the same way as agent-reported errors (via report_error)
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

    const stopTimestamp = new Date().toISOString();
    if (agent.isLeader) {
      // A leader's Stop halts ITS team — the agents of its owner on its board —
      // not every busy agent of the instance (every voice agent is a leader).
      const inTeam = (sub: any) =>
        (sub.ownerId || null) === (agent.ownerId || null) &&
        (!agent.boardId || sub.boardId === agent.boardId);
      for (const [subId, subAgent] of this.agents) {
        if (subId !== id && (subAgent as any).status === 'busy' && inTeam(subAgent)) {
          requestCliTerminalInterrupt(this, subAgent);
          const subCtrl = this.abortControllers.get(subId);
          if (subCtrl) {
            subCtrl.abort();
            this.abortControllers.delete(subId);
          }
          this._taskQueues.delete(subId);
          (subAgent as any).currentThinking = '';
          this._emit('agent:thinking', {
            agentId: subId,
            agentName: (subAgent as any).name,
            project: (subAgent as any).project || null,
            thinking: '',
          });
          (subAgent as any).currentTask = null;
          this._chatLocks.delete(subId);
          // Their task waits must end too, or they keep re-prompting the CLI
          // that was just interrupted.
          this._haltAgentTasks(subId, stopTimestamp).catch(() => {});
          this.setStatus(subId, 'idle', 'Stopped by leader');
          saveAgent(subAgent);
          this._emit('agent:stopped', {
            id: subId,
            name: (subAgent as any).name,
            project: (subAgent as any).project || null,
          });
        }
      }
    }

    // Halt the agent's in-flight tasks. Sourced from the DB (the single source of
    // truth) and run fire-and-forget so the synchronous stop path (abort + set
    // idle below) isn't blocked on DB round-trips. Signals set here still reach
    // the polling _waitForExecutionComplete loops moments later.
    this._haltAgentTasks(id, stopTimestamp).catch((err: any) =>
      console.warn(`⚠️ [stopAgent] halting tasks for ${id} failed: ${err?.message || err}`)
    );

    agent.currentThinking = '';
    this._emit('agent:thinking', {
      agentId: id,
      agentName: agent.name,
      project: agent.project || null,
      thinking: '',
    });
    agent.currentTask = null;
    this._chatLocks.delete(id);
    this.setStatus(id, 'idle', 'Agent stopped by user');
    saveAgent(agent);

    console.log(`🛑 Agent ${agent.name} stopped`);
    this._emit('agent:stopped', { id, name: agent.name, project: agent.project || null });
    return true;
  },

  /** Mark the task(s) this agent is EXECUTING, in this environment, as stopped:
   * its in-process run, the task carrying its run claim, and active tasks
   * assigned to it that are started or being watched. Tasks it merely OWNS are
   * left alone — the board's container agent owns every card, and halting them
   * froze the whole board and released other agents' runs while their CLIs kept
   * working. The stop is persisted (targeted, guarded by the column) BEFORE the
   * 'stopped' signal is raised, so the waiting run cannot exit and clear the
   * execution status in between. */
  async _haltAgentTasks(this: any, id: string, stopTimestamp: string): Promise<void> {
    const env = getCurrentEnvironment();
    const halt = new Map<string, any>();
    const reservedTaskId = getAgentRunningTaskId(id);
    const reserved = reservedTaskId ? await getTaskById(reservedTaskId) : null;
    const running = await getTaskByActionRunningAgent(id, env);
    const assigned = (await getTasksByAssignee(id)).filter(
      (t: any) =>
        t.assignee === id &&
        (t.environment || 'prod') === env &&
        this._isActiveTaskStatus(t.status) &&
        (t.startedAt || t.actionRunning || getTaskSignal(t.id, 'watching'))
    );
    for (const t of [reserved, running, ...assigned]) {
      if (t && !halt.has(t.id)) halt.set(t.id, t);
    }
    // The durable Stop first, the claim release after: in between, a released
    // but not yet stopped task could be claimed again by another process (a
    // claim refuses a stopped task).
    const stoppedRows = new Map<string, Task | null>();
    for (const t of halt.values()) {
      stoppedRows.set(
        t.id,
        this._isActiveTaskStatus(t.status) ? await this._markTaskStopped(t, stopTimestamp) : null
      );
    }
    await clearActionRunningForAgent(id, env);

    for (const t of halt.values()) {
      setTaskSignal(t.id, 'stopped', true);
      const fresh = await getTaskById(t.id).catch(() => stoppedRows.get(t.id) || null);
      if (fresh) emitTaskUpdated(this, { ...fresh }, { emitAgent: false, stampUpdatedAt: true });
    }
  },
};
