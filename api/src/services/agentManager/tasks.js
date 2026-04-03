// ─── Tasks: CRUD, execution, task loop, queue, wait, resume ──────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveTaskToDb, deleteTaskFromDb, deleteTasksByAgent, hardDeleteTaskFromDb, restoreTaskFromDb, getDeletedTasks, getDeletedTaskById, getTasksForResume, updateTaskExecutionStatus, getTaskById, getTasksByAgent, getActiveTasksByAgent, getActiveTaskForExecutor, getRecurringDoneTasks, hasActiveTask, updateTaskFields } from '../database.js';
import { getWorkflowForBoard, getAllBoardWorkflows, getReminderConfig } from '../configManager.js';
import { processTransition } from '../transitionProcessor.js';
import { onTaskStatusChanged } from '../jiraSync.js';

// ── Ephemeral task signals ──────────────────────────────────────────────────
// Transient coordination flags between async coroutines (NOT persisted).
// Replaces in-memory task._execution* properties.
const _taskSignals = new Map(); // taskId -> { completed, comment, stopped, watching, pendingOnEnter }

export function setTaskSignal(taskId, key, value) {
  if (!_taskSignals.has(taskId)) _taskSignals.set(taskId, {});
  _taskSignals.get(taskId)[key] = value;
}

export function getTaskSignal(taskId, key) {
  return _taskSignals.get(taskId)?.[key];
}

export function clearTaskSignal(taskId, key) {
  const signals = _taskSignals.get(taskId);
  if (signals) {
    delete signals[key];
    if (Object.keys(signals).length === 0) _taskSignals.delete(taskId);
  }
}

export function clearTaskSignals(taskId) {
  _taskSignals.delete(taskId);
}

/** @this {import('./index.js').AgentManager} */
export const tasksMethods = {

  addTask(agentId, text, project, source, initialStatus, { boardId, skipAutoRefine = false, recurrence, taskType } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const defaultStatus = 'backlog';
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
    if (recurrence && recurrence.enabled) {
      newTask.recurrence = {
        enabled: true,
        period: recurrence.period || 'daily',
        intervalMinutes: recurrence.intervalMinutes || 1440,
        originalStatus: status,
      };
    }
    agent.todoList.push(newTask);
    saveTaskToDb({ ...newTask, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    if (!skipAutoRefine) this._checkAutoRefine({ ...newTask, agentId });
    return newTask;
  },

  toggleTask(agentId, taskId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const prevStatus = task.status;
    task.status = prevStatus === 'done' ? 'backlog' : 'done';
    if (task.status === 'done') task.completedAt = new Date().toISOString();
    const now = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status: task.status, at: now, by: 'user' });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  setTaskStatus(agentId, taskId, status, { skipAutoRefine = false, by = null } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const prevStatus = task.status;
    if (prevStatus === status) return task;
    task.status = status;
    delete task._pendingOnEnter;
    // Clear execution state — processTransition will re-set startedAt when
    // a workflow action genuinely starts execution. Without this, stale
    // startedAt from a previous execution causes the task loop to resume
    // tasks that were manually moved (e.g. done → nextsprint).
    delete task.startedAt;
    task.executionStatus = null;
    const now = new Date().toISOString();
    if (status === 'done') task.completedAt = now;
    if (status === 'error') {
      task.errorFromStatus = prevStatus;
    }
    if (prevStatus === 'error' && status !== 'error') {
      delete task.errorFromStatus;
      delete task.error;
    }
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status, at: now, by: by || 'user' });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    if (by !== 'jira-sync') onTaskStatusChanged(task, status, this);
    if (!skipAutoRefine && status !== 'error') this._checkAutoRefine({ ...task, agentId }, { by: by || 'user' });
    return task;
  },

  updateTaskTitle(agentId, taskId, title) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldTitle = task.title || null;
    task.title = title;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'title', oldValue: oldTitle, newValue: title });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskText(agentId, taskId, text) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldText = task.text;
    task.text = text;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'text', oldValue: oldText, newValue: text });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskProject(agentId, taskId, project) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldProject = task.project;
    task.project = project;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'project', oldValue: oldProject, newValue: project });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskType(agentId, taskId, taskType, by = 'user') {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    const oldType = task.taskType || null;
    task.taskType = taskType || null;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by, type: 'edit', field: 'taskType', oldValue: oldType, newValue: taskType || null });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

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
        originalStatus: recurrence.originalStatus || task.recurrence?.originalStatus || 'backlog',
      };
    } else {
      task.recurrence = null;
    }
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  _isActiveTaskStatus(status) {
    const INACTIVE = new Set(['done', 'backlog', 'error']);
    return !INACTIVE.has(status);
  },

  /** Resolve the first column ID of a board's workflow (used as default status) */
  async _getFirstColumnStatus(boardId) {
    try {
      const workflow = await getWorkflowForBoard(boardId);
      if (workflow?.columns?.length > 0) {
        return workflow.columns[0].id;
      }
    } catch { /* fall through */ }
    return 'backlog';
  },

  _findTaskForCommitLink(agentId) {
    const agent = this.agents.get(agentId);

    // Priority 1: Task actively running via this agent (set by processTransition)
    // This is the most reliable indicator — it means a workflow action is in progress.
    for (const [creatorId, creatorAgent] of this.agents) {
      if (!creatorAgent.todoList) continue;
      for (const task of creatorAgent.todoList) {
        if (task.actionRunningAgentId === agentId && this._isActiveTaskStatus(task.status)) {
          console.log(`🔗 [Commit] Found task via actionRunningAgentId: "${task.text?.slice(0, 50)}" (owner=${creatorId.slice(0, 8)})`);
          return { task, ownerAgentId: creatorId };
        }
      }
    }

    // Priority 2: Active task explicitly assigned to this agent (from any agent's list)
    // Prefer the most recently started task when multiple are assigned.
    let bestAssigned = null;
    for (const [creatorId, creatorAgent] of this.agents) {
      if (!creatorAgent.todoList) continue;
      for (const task of creatorAgent.todoList) {
        if (task.assignee !== agentId || !this._isActiveTaskStatus(task.status)) continue;
        if (!bestAssigned || (task.startedAt && (!bestAssigned.task.startedAt || new Date(task.startedAt) > new Date(bestAssigned.task.startedAt)))) {
          bestAssigned = { task, ownerAgentId: creatorId };
        }
      }
    }
    if (bestAssigned) {
      console.log(`🔗 [Commit] Found task via assignee: "${bestAssigned.task.text?.slice(0, 50)}" (owner=${bestAssigned.ownerAgentId.slice(0, 8)})`);
      return bestAssigned;
    }

    // Priority 3: Agent's own active task (when no assigned/running task found)
    if (agent?.todoList?.length) {
      const ownActive = agent.todoList.find(t => this._isActiveTaskStatus(t.status));
      if (ownActive) {
        console.log(`🔗 [Commit] Found own active task: "${ownActive.text?.slice(0, 50)}"`);
        return { task: ownActive, ownerAgentId: agentId };
      }
    }

    // Priority 4: Fall back to most recently completed task (owned or assigned)
    let bestDone = null;
    for (const [creatorId, creatorAgent] of this.agents) {
      if (!creatorAgent.todoList) continue;
      for (const task of creatorAgent.todoList) {
        const isOwnedOrAssigned = creatorId === agentId || task.assignee === agentId;
        if (!isOwnedOrAssigned) continue;
        if (task.status === 'done' && task.completedAt) {
          if (!bestDone || new Date(task.completedAt) > new Date(bestDone.task.completedAt)) {
            bestDone = { task, ownerAgentId: creatorId };
          }
        }
      }
    }
    if (bestDone) {
      console.log(`🔗 [Commit] No active task — falling back to recently done: "${bestDone.task.text?.slice(0, 50)}"`);
      return bestDone;
    }

    console.log(`🔗 [Commit] No task found for agent ${agentId.slice(0, 8)} (${agent?.name || 'unknown'})`);
    return null;
  },

  addTaskCommit(agentId, taskId, hash, message) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    if (!task.commits) task.commits = [];
    if (task.commits.some(c => c.hash === hash)) return task;
    task.commits.push({ hash, message: message || '', date: new Date().toISOString() });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  removeTaskCommit(agentId, taskId, hash) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task || !task.commits) return null;
    const before = task.commits.length;
    task.commits = task.commits.filter(c => c.hash !== hash);
    if (task.commits.length === before) return null;
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  setTaskAssignee(agentId, taskId, assigneeId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    task.assignee = assigneeId;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'reassign', assignee: assigneeId });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    this._recheckConditionalTransitions();
    return task;
  },

  deleteTask(agentId, taskId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return false;
    // Record deletion in history before removing from memory
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'deleted' });
    saveTaskToDb({ ...task, agentId });
    // Remove from in-memory list
    agent.todoList = agent.todoList.filter(t => t.id !== taskId);
    // Soft-delete in DB (sets deleted_at)
    deleteTaskFromDb(taskId);
    this._emit('agent:updated', this._sanitize(agent));
    this._emit('task:deleted', { taskId, agentId });
    return true;
  },

  async restoreTask(taskId) {
    const restored = await restoreTaskFromDb(taskId);
    if (!restored) return null;
    // Re-add to in-memory agent todoList
    const agent = this.agents.get(restored.agentId);
    if (agent) {
      if (!restored.history) restored.history = [];
      restored.history.push({ status: restored.status, at: new Date().toISOString(), by: 'user', type: 'restored' });
      agent.todoList.push(restored);
      saveTaskToDb({ ...restored, agentId: restored.agentId });
      this._emit('agent:updated', this._sanitize(agent));
    }
    return restored;
  },

  async hardDeleteTask(taskId) {
    const result = await hardDeleteTaskFromDb(taskId);
    return result;
  },

  async getDeletedTasks() {
    return getDeletedTasks();
  },

  clearTasks(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.todoList = [];
    deleteTasksByAgent(agentId);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  transferTask(fromAgentId, taskId, toAgentId) {
    const fromAgent = this.agents.get(fromAgentId);
    const toAgent = this.agents.get(toAgentId);
    if (!fromAgent || !toAgent) return null;
    const taskToTransfer = fromAgent.todoList.find(t => t.id === taskId);
    if (!taskToTransfer) return null;
    const prevStatus = taskToTransfer.status;
    fromAgent.todoList = fromAgent.todoList.filter(t => t.id !== taskId);
    hardDeleteTaskFromDb(taskId); // Hard delete since the task is recreated on the target agent
    this._emit('agent:updated', this._sanitize(fromAgent));
    const newTask = this.addTask(toAgentId, taskToTransfer.text, taskToTransfer.project, { type: 'transfer', name: fromAgent.name, id: fromAgent.id }, prevStatus);
    if (newTask) {
      const actualTask = toAgent.todoList.find(t => t.id === newTask.id);
      if (actualTask) {
        actualTask.assignee = toAgentId;
        saveTaskToDb({ ...actualTask, agentId: toAgentId });
      }
      this._checkAutoRefine({ ...newTask, assignee: toAgentId, agentId: toAgentId });
    }
    return newTask;
  },

  async executeTask(agentId, taskId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) throw new Error('Task not found');
    if (task.status === 'done') throw new Error('Task already completed');

    console.log(`[Workflow] Triggering execution for "${task.text.slice(0, 80)}" (status=${task.status})`);

    delete task._executionStopped;
    task.executionStatus = null;
    updateTaskExecutionStatus(task.id, null);
    if (this._isActiveTaskStatus(task.status)) {
      // Task is already in an active status — resume execution
      saveTaskToDb({ ...task, agentId });
      this._checkAutoRefine({ ...task, agentId }, { by: 'resume' });
    } else {
      // Task is inactive — trigger workflow transitions
      const workflow = await getWorkflowForBoard(task.boardId);
      const hasRunAgent = workflow.transitions
        .filter(t => this._validTransition(t))
        .some(t => t.from === task.status && (t.actions || []).some(a => a.type === 'run_agent'));

      if (hasRunAgent) {
        this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
      } else {
        // No workflow transition — trigger auto-refine directly
        this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
      }
    }

    return { taskId, response: null };
  },

  async executeAllTasks(agentId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const executable = agent.todoList.filter(t => t.status !== 'done' && !this._isActiveTaskStatus(t.status));
    if (executable.length === 0) throw new Error('No executable tasks');

    console.log(`▶️  Executing ${executable.length} task(s) for ${agent.name}`);
    this._emit('agent:task:executeAll:start', { agentId, count: executable.length });

    const results = [];
    for (const task of executable) {
      try {
        const result = await this.executeTask(agentId, task.id, streamCallback);
        results.push({ taskId: task.id, text: task.text, success: true, response: result.response });
      } catch (err) {
        results.push({ taskId: task.id, text: task.text, success: false, error: err.message });
      }
    }

    this._emit('agent:task:executeAll:complete', { agentId, results: results.map(r => ({ taskId: r.taskId, success: r.success })) });
    return results;
  },

  // ─── Task Loop ──────────────────────────────────────────────────────
  startTaskLoop(intervalMs = 5000) {
    if (this._taskLoopInterval) return;
    this._loopProcessing = new Set();
    this._workflowManagedStatuses = new Set();
    this._refreshWorkflowManagedStatuses();
    this._taskLoopInterval = setInterval(() => this._processNextPendingTasks(), intervalMs);
    this._recurrenceInterval = setInterval(() => this._processRecurringTasks(), 60000);
    this._workflowRefreshInterval = setInterval(() => this._refreshWorkflowManagedStatuses(), 30000);
    console.log(`🔄 Task loop started (every ${intervalMs / 1000}s)`);
  },

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
  },

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
  },

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
          const resetStatus = task.recurrence.originalStatus || 'backlog';
          console.log(`🔁 [Recurrence] Resetting task "${task.text.slice(0, 60)}" → ${resetStatus} (interval: ${task.recurrence.intervalMinutes}min)`);
          task.status = resetStatus;
          task.completedAt = null;
          task.startedAt = null;
          if (!task.history) task.history = [];
          task.history.push({ from: 'done', status: resetStatus, at: new Date().toISOString(), by: 'recurrence' });
          saveTaskToDb({ ...task, agentId });
          this._emit('agent:updated', this._sanitize(agent));
        }
      }
    }
  },

  _processNextPendingTasks() {
    this._recheckConditionalTransitions();

    // Use DB query to find tasks that need resume, instead of scanning in-memory state
    getTasksForResume().then(dbTasks => {
      for (const dbTask of dbTasks) {
        const executorId = dbTask.assignee || dbTask.agentId;
        const executor = this.agents.get(executorId);
        if (!executor) continue;
        if (executor.enabled === false) continue;
        if (executor.status !== 'idle') continue;
        if (this._loopProcessing.has(executorId)) continue;

        // Sync: find the in-memory task to operate on
        const creatorAgent = this.agents.get(dbTask.agentId);
        if (!creatorAgent) continue;
        const activeTask = creatorAgent.todoList?.find(t => t.id === dbTask.id);
        if (!activeTask) continue;
        if (!this._isActiveTaskStatus(activeTask.status)) continue;

        if (this._workflowManagedStatuses?.has(activeTask.status)) continue;

        if (activeTask.executionStatus === 'stopped' || activeTask._executionStopped) {
          console.log(`🛑 [TaskLoop] Skipping auto-resume for "${activeTask.text.slice(0, 60)}" — was manually stopped`);
          this.setTaskStatus(dbTask.agentId, activeTask.id, 'backlog', { skipAutoRefine: true, by: 'user-stop' });
          continue;
        }
        if (activeTask.executionStatus === 'watching' || activeTask._executionWatching) continue;

        this._loopProcessing.add(executorId);
        console.log(`🔄 [TaskLoop] Agent "${executor.name}" is idle but has started task "${activeTask.text.slice(0, 60)}" (${activeTask.status}) — resuming`);
        this._resumeActiveTask(dbTask.agentId, creatorAgent, activeTask).finally(() => {
          this._loopProcessing.delete(executorId);
        });
      }
    }).catch(err => {
      console.error('[TaskLoop] Failed to query tasks for resume:', err.message);
    });
  },

  async _waitForExecutionComplete(creatorAgentId, taskId, executorId, executorName, targetStatus, taskText) {
    const freshTask = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
    console.log(`🔍 [Execution] _waitForExecutionComplete: task=${taskId} creator=${creatorAgentId} executor=${executorName} _executionCompleted=${freshTask?._executionCompleted} status=${freshTask?.status}`);

    const resolveCompletionStatus = () => {
      return targetStatus || 'done';
    };

    if (freshTask?.status === 'error') {
      console.log(`[Execution] Task ${taskId} "${taskText.slice(0, 60)}" ended with error — blocking transition`);
      return 'error';
    }

    if (freshTask?._executionCompleted) {
      const comment = freshTask._executionComment || '';
      delete freshTask._executionCompleted;
      delete freshTask._executionComment;
      if (targetStatus) {
        const completionStatus = resolveCompletionStatus();
        this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: false, by: executorName });
        console.log(`✅ [Execution] task ${taskId} completed via task_execution_complete -> ${completionStatus}${comment ? ` (${comment.slice(0, 80)})` : ''}`);
      } else {
        console.log(`✅ [Execution] task ${taskId} completed via task_execution_complete (no targetStatus — action chain continues)${comment ? ` (${comment.slice(0, 80)})` : ''}`);
      }
      return 'completed';
    }

    if (freshTask && !this._isActiveTaskStatus(freshTask.status)) {
      console.log(`[Execution] Task ${taskId} "${taskText.slice(0, 60)}" already moved to "${freshTask.status}" — accepting`);
      return 'moved';
    }

    // Mark the task so the 5-second task loop doesn't re-send the original
    // message (which causes a full reasoning reset).
    if (freshTask) {
      freshTask._executionWatching = true;
      freshTask.executionStatus = 'watching';
      updateTaskExecutionStatus(taskId, 'watching');
    }

    const reminderConfig = await getReminderConfig();
    console.log(`🔔 [Execution] Agent "${executorName}" went idle without completing task ${taskId} "${taskText.slice(0, 60)}" — starting reminder loop (interval=${reminderConfig.intervalMinutes}min, cooldown=${reminderConfig.cooldownMinutes}min)`);
    const { intervalMs: REMINDER_INTERVAL_MS, maxReminders: MAX_REMINDERS, cooldownMs: COOLDOWN_MS } = reminderConfig;
    let reminded = 0;
    let lastReminderSentAt = 0;

    try {
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
        if (targetStatus) {
          const completionStatus = resolveCompletionStatus();
          this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: false, by: executorName });
          console.log(`✅ [Execution] Task ${taskId} completed during wait -> ${completionStatus}`);
        } else {
          console.log(`✅ [Execution] Task ${taskId} completed during wait (no targetStatus — action chain continues)`);
        }
        return 'completed';
      }
      if (!this._isActiveTaskStatus(currentTask.status)) {
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

      // Cooldown: skip if a reminder was sent too recently
      const now = Date.now();
      if (COOLDOWN_MS > 0 && lastReminderSentAt > 0 && (now - lastReminderSentAt) < COOLDOWN_MS) {
        console.log(`🔔 [Execution] Cooldown active for "${executorName}" — skipping redundant reminder`);
        continue;
      }

      reminded++;
      lastReminderSentAt = now;
      console.log(`🔔 [Execution] Reminding "${executorName}" to complete task (attempt ${reminded}/${MAX_REMINDERS})`);

      this._emit('agent:stream:start', { agentId: executorId });
      try {
        const reminderStartIdx = currentExecutor.conversationHistory.length;
        const reminderStartedAt = new Date().toISOString();

        await this.sendMessage(
          executorId,
          `[SYSTEM REMINDER] You have an active task that is not yet complete:\n"${taskText.slice(0, 300)}"\n\nPlease finish your work on this task. When you are done, you MUST call @task_execution_complete(summary of what was done) to signal completion.\n\nIf you have already finished all the work, call @task_execution_complete now with a summary of what was accomplished.`,
          (chunk) => {
            this._emit('agent:stream:chunk', { agentId: executorId, chunk });
            this._emit('agent:thinking', { agentId: executorId, thinking: currentExecutor.currentThinking || '' });
          }
        );

        this._saveExecutionLog(creatorAgentId, taskId, executorId, reminderStartIdx, reminderStartedAt, true);
      } catch (reminderErr) {
        console.error(`🔔 [Execution] Reminder failed: ${reminderErr.message}`);
      }
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(currentExecutor));

      const afterReminder = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (afterReminder?._executionCompleted) {
        const comment = afterReminder._executionComment || '';
        delete afterReminder._executionCompleted;
        delete afterReminder._executionComment;
        if (targetStatus) {
          const completionStatus = resolveCompletionStatus();
          this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: false, by: executorName });
          console.log(`✅ [Execution] Completed after reminder: "${taskText.slice(0, 60)}" -> ${completionStatus}`);
        } else {
          console.log(`✅ [Execution] Completed after reminder: "${taskText.slice(0, 60)}" (no targetStatus — action chain continues)`);
        }
        return 'completed';
      }
    }

    if (reminded >= MAX_REMINDERS) {
      const finalTask = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (finalTask && this._isActiveTaskStatus(finalTask.status) && !finalTask._executionCompleted) {
        console.warn(`⚠️ [Execution] Max reminders (${MAX_REMINDERS}) reached for "${taskText.slice(0, 60)}" — task remains active (${finalTask.status})`);
        this.addActionLog(executorId, 'warning', `Task reminder limit reached — task remains active`, taskText.slice(0, 200));
      }
      return 'timeout';
    }

    return 'unknown';
    } finally {
      // Always clear the watching flag so the task loop can resume if needed
      const watched = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (watched) {
        delete watched._executionWatching;
        watched.executionStatus = null;
        updateTaskExecutionStatus(taskId, null);
      }
    }
  },

  async _resumeActiveTask(agentId, agent, task) {
    const executorId = task.assignee || agentId;
    const executor = this.agents.get(executorId) || agent;

    const streamCallback = (chunk) => {
      this._emit('agent:stream:chunk', { agentId: executorId, chunk });
      this._emit('agent:thinking', { agentId: executorId, thinking: executor.currentThinking || '' });
    };

    this._emit('agent:stream:start', { agentId: executorId });

    let startMsgIdx = executor.conversationHistory.length;
    let executionStartedAt = new Date().toISOString();
    // Ensure startedAt is set for managesContext history scoping
    if (!task.startedAt) {
      task.startedAt = executionStartedAt;
    }

    try {
      let targetStatus = null;
      try {
        const workflow = await getWorkflowForBoard(task.boardId);
        const transition = workflow.transitions.find(t => {
          if (t.from !== task.status) return false;
          if (this._validTransition(t)) {
            return (t.actions || []).some(a => a.type === 'run_agent');
          }
          return t.autoRefine && (t.mode === 'execute' || t.mode === 'decide' || t.agent);
        });
        if (transition) {
          if (this._validTransition(transition)) {
            // Only use an explicit targetStatus set on the run_agent action itself.
            // Do NOT fallback to change_status — that's a separate action in the
            // chain and will be handled by _checkAutoRefine after execution completes.
            const runAction = (transition.actions || []).find(a => a.type === 'run_agent' && a.targetStatus);
            if (runAction?.targetStatus) {
              targetStatus = runAction.targetStatus;
            }
          } else if (transition.to) {
            targetStatus = transition.to;
          }
        }
      } catch (_) { /* use default */ }

      if (task.project && task.project !== executor.project) {
        console.log(`🔄 [TaskLoop] Switching "${executor.name}" to project "${task.project}" for resume`);
        if (this._switchProjectContext) {
          this._switchProjectContext(executor, executor.project, task.project);
        }
        executor.project = task.project;
      }

      delete task._executionCompleted;
      delete task._executionComment;

      startMsgIdx = executor.conversationHistory.length;
      executionStartedAt = new Date().toISOString();

      // Check if the agent already started working on this task (has the task
      // text in its conversation history).  If so, send a continuation nudge
      // instead of the original message, which would cause a full reasoning reset.
      const taskPrefix = task.text.slice(0, 80);
      const alreadySent = executor.conversationHistory.some(
        msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes(taskPrefix)
      );
      const messageToSend = alreadySent
        ? `[SYSTEM REMINDER] You have an active task that needs to be completed:\n"${task.text.slice(0, 300)}"\n\nContinue where you left off. When you are done, call @task_execution_complete(summary of what was done).`
        : task.text;

      const result = await this.sendMessage(executorId, messageToSend, streamCallback);

      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, true);

      await this._waitForExecutionComplete(agentId, task.id, executorId, executor.name, targetStatus, task.text);
    } catch (err) {
      const isUserStop = err.message === 'Agent stopped by user';
      console.error(`🔄 [TaskLoop] Error resuming task for ${executor.name}:`, err.message);
      this._emit('agent:stream:error', { agentId: executorId, error: err.message });

      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, false);

      if (isUserStop) {
        // User manually stopped — put task back to pending, don't treat as error
        task._executionStopped = true;
        task.executionStatus = 'stopped';
        updateTaskExecutionStatus(task.id, 'stopped');
        this.setTaskStatus(agentId, task.id, 'backlog', { skipAutoRefine: true, by: 'user-stop' });
      } else {
        this.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true, by: executor.name });
        const actualTask = this.agents.get(agentId)?.todoList?.find(t => t.id === task.id);
        if (actualTask) {
          actualTask.error = err.message;
          saveTaskToDb({ ...actualTask, agentId });
        }
      }
      if (executor.status === 'error') {
        this.setStatus(executorId, 'idle', 'Auto-recovered after resume error');
      }
    } finally {
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(executor));
    }
  },

  /** Find a task by ID across all agents */
  getTask(taskId) {
    for (const [agentId, agent] of this.agents) {
      if (!agent.todoList) continue;
      const task = agent.todoList.find(t => t.id === taskId);
      if (task) return { ...task, agentId };
    }
    return null;
  },

  /** Persist a task object to the database (used by routes/tasks.js) */
  saveTasksToDb() {
    // With the dedicated tasks table, individual task mutations already persist.
    // This method exists for compatibility with routes/tasks.js which calls it
    // after direct field updates. We save the specific task that was modified.
    // Callers should use saveTaskToDb() directly when possible.
  },

  /** Save a single in-memory task to the DB (convenience for route handlers) */
  saveTaskDirectly(task) {
    if (!task || !task.agentId) return;
    saveTaskToDb(task);
  },

  _enqueueAgentTask(agentId, taskFn) {
    if (!this._taskQueues.has(agentId)) {
      this._taskQueues.set(agentId, Promise.resolve());
    }
    const resultPromise = this._taskQueues.get(agentId).then(
      () => taskFn(),
      () => taskFn()
    );
    this._taskQueues.set(agentId, resultPromise.catch(() => {}));
    return resultPromise;
  },
};
