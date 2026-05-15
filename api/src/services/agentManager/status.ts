// ─── Agent Status: getAgentStatus, swarm status, setStatus, stopAgent ───────
import { saveAgent, clearActionRunningForAgent, saveTaskToDb } from '../database.js';
import { setTaskSignal } from './tasks.js';

/** @this {import('./index.js').AgentManager} */
export const statusMethods = {

  getAgentStatus(this: any, id: string): any {
    const agent = this.agents.get(id);
    if (!agent) return null;

    const todoList = this._getAgentTasks(id);
    const waitingTasks = todoList.filter((t: any) => !this._isActiveTaskStatus(t.status) && t.status !== 'done' && t.status !== 'error').length;
    const activeTaskCount = todoList.filter((t: any) => this._isActiveTaskStatus(t.status)).length;
    const doneTasks = todoList.filter((t: any) => t.status === 'done').length;
    const errorTasks = todoList.filter((t: any) => t.status === 'error').length;
    const totalTasks = todoList.length;
    const msgCount = (agent.conversationHistory || []).length;
    const hasSandbox = this.executionManager ? this.executionManager.hasEnvironment(agent.id) : false;

    const currentTaskEntry = todoList.find((t: any) => this._isActiveTaskStatus(t.status));
    const currentTask = agent.currentTask || (currentTaskEntry ? currentTaskEntry.text : null);

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
      provider: agent.provider || null,
      model: agent.model || null,
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

  getAllStatuses(this: any, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): any[] {
    const agents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    return (agents as any[])
      .filter((a: any) => a.enabled !== false)
      .map((a: any) => this.getAgentStatus(a.id))
      .filter(Boolean);
  },

  getAgentsByProject(this: any, projectName: string, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): any[] {
    if (!projectName) return [];
    const agents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    return (agents as any[])
      .filter((a: any) => a.enabled !== false && (a.project || '').toLowerCase() === projectName.toLowerCase())
      .map((a: any) => this.getAgentStatus(a.id))
      .filter(Boolean);
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

  getSwarmStatus(this: any, userId: string | null = null, role: string | null = null, userBoardIds?: Set<string>): any {
    const allAgents = (userId && role) ? this._agentsForUser(userId, role, userBoardIds) : Array.from(this.agents.values());
    const enabled = (allAgents as any[]).filter((a: any) => a.enabled !== false);
    const disabled = (allAgents as any[]).filter((a: any) => a.enabled === false);

    const projectMap: Record<string, any[]> = {};
    const unassigned: any[] = [];
    for (const agent of enabled) {
      const status = this.getAgentStatus(agent.id);
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
      agents: enabled.map((a: any) => this.getAgentStatus(a.id))
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

    const controller = this.abortControllers.get(id);
    if (controller) {
      controller.abort();
      this.abortControllers.delete(id);
    }

    this._taskQueues.delete(id);

    if (agent.isLeader) {
      for (const [subId, subAgent] of this.agents) {
        if (subId !== id && (subAgent as any).status === 'busy') {
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
    for (const t of this._getAgentTasks(id)) {
      if (this._isActiveTaskStatus(t.status)) {
        t._executionStopped = true;
        t.executionStatus = 'stopped';
        t.startedAt = null;
        if (!t.history) t.history = [];
        t.history.push({
          status: t.status,
          at: stopTimestamp,
          by: 'user',
          type: 'stopped',
        });
        saveTaskToDb({ ...t, agentId: id });
        this._emit('task:updated', { agentId: id, task: { ...t, agentId: id } });
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
          // Mark the task as stopped in DB + memory so the task-loop SQL
          // filter (started_at IS NOT NULL AND execution_status NOT IN
          // (watching, stopped)) excludes it. Without this an
          // executor-only stop leaves execution_status=NULL and
          // started_at intact, so the next 5-second tick of
          // _processNextPendingTasks resumes the task immediately.
          if (this._isActiveTaskStatus(t.status)) {
            t._executionStopped = true;
            t.executionStatus = 'stopped';
            t.startedAt = null;
            if (!t.history) t.history = [];
            t.history.push({
              status: t.status,
              at: stopTimestamp,
              by: 'user',
              type: 'stopped',
            });
            saveTaskToDb({ ...t, agentId: creatorId });
          }
          // Signal any pending _waitForExecutionComplete loop so it unblocks
          // the workflow lock instead of waiting out the 10-min reminder cycle.
          setTaskSignal(t.id, 'stopped', true);
          this._emit('task:updated', { agentId: (creatorAgent as any).id, task: t });
        }
      }
    }

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
};
