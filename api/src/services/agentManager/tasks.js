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

  async addTask(agentId, text, project, source, initialStatus, { boardId, skipAutoRefine = false, recurrence, taskType } = {}) {
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
    await saveTaskToDb({ ...newTask, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    if (!skipAutoRefine) this._checkAutoRefine({ ...newTask, agentId });
    return newTask;
  },

  async toggleTask(agentId, taskId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task || task.agentId !== agentId) return null;
    const prevStatus = task.status;
    task.status = prevStatus === 'done' ? 'backlog' : 'done';
    if (task.status === 'done') task.completedAt = new Date().toISOString();
    const now = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status: task.status, at: now, by: 'user' });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async setTaskStatus(agentId, taskId, status, { skipAutoRefine = false, by = null } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const prevStatus = task.status;
    if (prevStatus === status) return task;
    task.status = status;
    // Clear pending on enter signal
    clearTaskSignal(taskId, 'pendingOnEnter');
    // Clear execution state — processTransition will re-set startedAt when
    // a workflow action genuinely starts execution. Without this, stale
    // startedAt from a previous execution causes the task loop to resume
    // tasks that were manually moved (e.g. done → nextsprint).
    task.startedAt = null;
    task.executionStatus = null;
    const now = new Date().toISOString();
    if (status === 'done') task.completedAt = now;
    if (status === 'error') {
      task.errorFromStatus = prevStatus;
    }
    if (prevStatus === 'error' && status !== 'error') {
      task.errorFromStatus = null;
      task.error = null;
    }
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status, at: now, by: by || 'user' });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    if (by !== 'jira-sync') onTaskStatusChanged(task, status, this);
    if (!skipAutoRefine && status !== 'error') this._checkAutoRefine({ ...task, agentId }, { by: by || 'user' });
    return task;
  },

  async updateTaskTitle(agentId, taskId, title) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldTitle = task.title || null;
    task.title = title;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'title', oldValue: oldTitle, newValue: title });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async updateTaskText(agentId, taskId, text) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldText = task.text;
    task.text = text;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'text', oldValue: oldText, newValue: text });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async updateTaskProject(agentId, taskId, project) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldProject = task.project;
    task.project = project;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'project', oldValue: oldProject, newValue: project });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async updateTaskType(agentId, taskId, taskType, by = 'user') {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldType = task.taskType || null;
    task.taskType = taskType || null;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by, type: 'edit', field: 'taskType', oldValue: oldType, newValue: taskType || null });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async updateTaskRecurrence(agentId, taskId, recurrence) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
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
    await saveTaskToDb({ ...task, agentId });
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
      const creatorTasks = this._getAgentTasks(creatorId);
      for (const task of creatorTasks) {
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
      const creatorTasks = this._getAgentTasks(creatorId);
      for (const task of creatorTasks) {
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
    const ownTasks = this._getAgentTasks(agentId);
    if (ownTasks.length) {
      const ownActive = ownTasks.find(t => this._isActiveTaskStatus(t.status));
      if (ownActive) {
        console.log(`🔗 [Commit] Found own active task: "${ownActive.text?.slice(0, 50)}"`);
        return { task: ownActive, ownerAgentId: agentId };
      }
    }

    return null;
  },

  async _findTaskForCommitLink(agentId) {
    // Find active task assigned to or owned by this agent
    const activeTask = await getActiveTaskForExecutor(agentId);
    if (activeTask) return { task: activeTask, ownerAgentId: activeTask.agentId };
    // Fallback: find recently completed task
    const allTasks = await getTasksByAgent(agentId);
    const doneTasks = allTasks.filter(t => t.status === 'done' && t.completedAt);
    if (doneTasks.length > 0) {
      doneTasks.sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
      console.log(`🔗 [Commit] No active task — falling back to recently done task "${doneTasks[0].text?.slice(0, 50)}"`);
      return { task: doneTasks[0], ownerAgentId: doneTasks[0].agentId };
    }
    return null;
  },

  async addTaskCommit(agentId, taskId, hash, message) {
    const task = await getTaskById(taskId);
    if (!task) return null;
    if (!task.commits) task.commits = [];
    if (task.commits.some(c => c.hash === hash)) return task;
    task.commits.push({ hash, message: message || '', date: new Date().toISOString() });
    await saveTaskToDb({ ...task, agentId: task.agentId });
    const agent = this.agents.get(task.agentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async removeTaskCommit(agentId, taskId, hash) {
    const task = await getTaskById(taskId);
    if (!task || !task.commits) return null;
    const before = task.commits.length;
    task.commits = task.commits.filter(c => c.hash !== hash);
    if (task.commits.length === before) return null;
    await saveTaskToDb({ ...task, agentId: task.agentId });
    const agent = this.agents.get(task.agentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async setTaskAssignee(agentId, taskId, assigneeId) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    task.assignee = assigneeId;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'reassign', assignee: assigneeId });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    this._recheckConditionalTransitions();
    return task;
  },

  async deleteTask(agentId, taskId) {
    const task = await getTaskById(taskId);
    if (!task) return false;
    // Record deletion in history
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'deleted' });
    await saveTaskToDb({ ...task, agentId });
    // Soft-delete in DB (sets deleted_at)
    await deleteTaskFromDb(taskId);
    clearTaskSignals(taskId);
    const agent = this.agents.get(agentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    this._emit('task:deleted', { taskId, agentId });
    return true;
  },

  async restoreTask(taskId) {
    const restored = await restoreTaskFromDb(taskId);
    if (!restored) return null;
    if (!restored.history) restored.history = [];
    restored.history.push({ status: restored.status, at: new Date().toISOString(), by: 'user', type: 'restored' });
    await saveTaskToDb({ ...restored, agentId: restored.agentId });
    const agent = this.agents.get(restored.agentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return restored;
  },

  async hardDeleteTask(taskId) {
    clearTaskSignals(taskId);
    const result = await hardDeleteTaskFromDb(taskId);
    return result;
  },

  async getDeletedTasks() {
    return getDeletedTasks();
  },

  async clearTasks(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    await deleteTasksByAgent(agentId);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  async transferTask(fromAgentId, taskId, toAgentId) {
    const fromAgent = this.agents.get(fromAgentId);
    const toAgent = this.agents.get(toAgentId);
    if (!fromAgent || !toAgent) return null;
    const taskToTransfer = await getTaskById(taskId);
    if (!taskToTransfer) return null;
    const prevStatus = taskToTransfer.status;
    await hardDeleteTaskFromDb(taskId); // Hard delete since the task is recreated on the target agent
    this._emit('agent:updated', this._sanitize(fromAgent));
    const newTask = await this.addTask(toAgentId, taskToTransfer.text, taskToTransfer.project, { type: 'transfer', name: fromAgent.name, id: fromAgent.id }, prevStatus);
    if (newTask) {
      newTask.assignee = toAgentId;
      await saveTaskToDb({ ...newTask, agentId: toAgentId });
      this._checkAutoRefine({ ...newTask, assignee: toAgentId, agentId: toAgentId });
    }
    return newTask;
  },

  async executeTask(agentId, taskId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const task = await getTaskById(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status === 'done') throw new Error('Task already completed');

    console.log(`[Workflow] Triggering execution for "${task.text.slice(0, 80)}" (status=${task.status})`);

    clearTaskSignal(taskId, 'stopped');
    await updateTaskExecutionStatus(taskId, null);
    if (this._isActiveTaskStatus(task.status)) {
      this._checkAutoRefine({ ...task, agentId }, { by: 'resume' });
    } else {
      this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
    }

    return { taskId, response: null };
  },

  async executeAllTasks(agentId, streamCallback) {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const tasks = await getTasksByAgent(agentId);
    const executable = tasks.filter(t => t.status !== 'done' && !this._isActiveTaskStatus(t.status));
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

  async _processRecurringTasks() {
    const now = Date.now();
    const recurringTasks = await getRecurringDoneTasks();
    for (const task of recurringTasks) {
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
        await saveTaskToDb(task);
        const agent = this.agents.get(task.agentId);
        if (agent) this._emit('agent:updated', this._sanitize(agent));
      }
    }
  },

  _processNextPendingTasks() {
    this._recheckConditionalTransitions();

    // Use DB query to find tasks that need resume
    getTasksForResume().then(async (dbTasks) => {
      for (const dbTask of dbTasks) {
        const executorId = dbTask.assignee || dbTask.agentId;
        const executor = this.agents.get(executorId);
        if (!executor) continue;
        if (executor.enabled === false) continue;
        if (executor.status !== 'idle') continue;
        if (this._loopProcessing.has(executorId)) continue;
        if (!this._isActiveTaskStatus(dbTask.status)) continue;

        if (this._workflowManagedStatuses?.has(dbTask.status)) continue;

        if (dbTask.executionStatus === 'stopped' || getTaskSignal(dbTask.id, 'stopped')) {
          console.log(`🛑 [TaskLoop] Skipping auto-resume for "${dbTask.text.slice(0, 60)}" — was manually stopped`);
          this.setTaskStatus(dbTask.agentId, dbTask.id, 'backlog', { skipAutoRefine: true, by: 'user-stop' });
          continue;
        }
        if (dbTask.executionStatus === 'watching' || getTaskSignal(dbTask.id, 'watching')) continue;

        this._loopProcessing.add(executorId);
        console.log(`🔄 [TaskLoop] Agent "${executor.name}" is idle but has started task "${dbTask.text.slice(0, 60)}" (${dbTask.status}) — resuming`);
        this._resumeActiveTask(dbTask.agentId, this.agents.get(dbTask.agentId), dbTask).finally(() => {
          this._loopProcessing.delete(executorId);
        });
      }
    }).catch(err => {
      console.error('[TaskLoop] Failed to query tasks for resume:', err.message);
    });
  },

  async _waitForExecutionComplete(creatorAgentId, taskId, executorId, executorName, targetStatus, taskText) {
    const freshTask = this._getAgentTasks(creatorAgentId).find(t => t.id === taskId);
    console.log(`🔍 [Execution] _waitForExecutionComplete: task=${taskId} creator=${creatorAgentId} executor=${executorName} _executionCompleted=${freshTask?._executionCompleted} status=${freshTask?.status}`);
    const resolveCompletionStatus = () => targetStatus || 'done';

    // Helper: check if task was completed via signal
    const _checkCompleted = async () => {
      if (getTaskSignal(taskId, 'completed')) {
        const comment = getTaskSignal(taskId, 'comment') || '';
        clearTaskSignal(taskId, 'completed');
        clearTaskSignal(taskId, 'comment');
        if (targetStatus) {
          const completionStatus = resolveCompletionStatus();
          await this.setTaskStatus(creatorAgentId, taskId, completionStatus, { skipAutoRefine: false, by: executorName });
          console.log(`✅ [Execution] task_execution_complete for "${taskText.slice(0, 60)}" -> ${completionStatus}${comment ? ` (${comment.slice(0, 80)})` : ''}`);
        } else {
          console.log(`✅ [Execution] task_execution_complete for "${taskText.slice(0, 60)}" (no targetStatus — action chain continues)${comment ? ` (${comment.slice(0, 80)})` : ''}`);
        }
        return 'completed';
      }
      return null;
    };

    // Check immediate completion
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

    const immediateResult = await _checkCompleted();
    if (immediateResult) return immediateResult;
    if (freshTask && !this._isActiveTaskStatus(freshTask.status)) {
      console.log(`[Execution] Task ${taskId} "${taskText.slice(0, 60)}" already moved to "${freshTask.status}" — accepting`);
      return 'moved';
    }

    // Mark task as watching so the task loop doesn't re-send
    setTaskSignal(taskId, 'watching', true);
    updateTaskExecutionStatus(taskId, 'watching');

    const reminderConfig = await getReminderConfig();
    console.log(`🔔 [Execution] Agent "${executorName}" went idle without completing task ${taskId} "${taskText.slice(0, 60)}" — starting reminder loop (interval=${reminderConfig.intervalMinutes}min, cooldown=${reminderConfig.cooldownMinutes}min)`);
    const { intervalMs: REMINDER_INTERVAL_MS, maxReminders: MAX_REMINDERS, cooldownMs: COOLDOWN_MS } = reminderConfig;
    let reminded = 0;
    let lastReminderSentAt = 0;

    try {
    while (reminded < MAX_REMINDERS) {
      await new Promise(resolve => setTimeout(resolve, REMINDER_INTERVAL_MS));

      const currentTask = await getTaskById(taskId);
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
      const completedResult = await _checkCompleted();
      if (completedResult) return completedResult;
      if (!this._isActiveTaskStatus(currentTask.status)) {
        console.log(`🔔 [Execution] Task status changed to "${currentTask.status}" — exiting loop`);
        return 'moved';
      }
      if (getTaskSignal(taskId, 'stopped')) {
        console.log(`🛑 [Execution] Task was manually stopped — exiting reminder loop`);
        clearTaskSignal(taskId, 'stopped');
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

      const afterResult = await _checkCompleted();
      if (afterResult) return afterResult;
    }

    if (reminded >= MAX_REMINDERS) {
      const finalTask = await getTaskById(taskId);
      if (finalTask && this._isActiveTaskStatus(finalTask.status) && !getTaskSignal(taskId, 'completed')) {
        console.warn(`⚠️ [Execution] Max reminders (${MAX_REMINDERS}) reached for "${taskText.slice(0, 60)}" — task remains active (${finalTask.status})`);
        this.addActionLog(executorId, 'warning', `Task reminder limit reached — task remains active`, taskText.slice(0, 200));
      }
      return 'timeout';
    }

    return 'unknown';
    } finally {
      // Always clear the watching flag so the task loop can resume if needed
      clearTaskSignal(taskId, 'watching');
      updateTaskExecutionStatus(taskId, null);
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

      clearTaskSignal(task.id, 'completed');
      clearTaskSignal(task.id, 'comment');

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
        setTaskSignal(task.id, 'stopped', true);
        updateTaskExecutionStatus(task.id, 'stopped');
        await this.setTaskStatus(agentId, task.id, 'backlog', { skipAutoRefine: true, by: 'user-stop' });
      } else {
        await this.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true, by: executor.name });
        await updateTaskFields(task.id, { error: err.message });
      }
      if (executor.status === 'error') {
        this.setStatus(executorId, 'idle', 'Auto-recovered after resume error');
      }
    } finally {
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(executor));
    }
  },

  /** Find a task by ID (from database) */
  async getTask(taskId) {
    return getTaskById(taskId);
  },

  /** Save a task to the database */
  async saveTaskDirectly(task) {
    if (!task || !task.agentId) return;
    await saveTaskToDb(task);
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
