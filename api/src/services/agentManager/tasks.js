// ─── Tasks: CRUD, execution, task loop, queue, wait, resume ──────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveAgent } from '../database.js';
import { getWorkflowForBoard, getAllBoardWorkflows } from '../configManager.js';
import { processTransition } from '../transitionProcessor.js';
import { onTaskStatusChanged } from '../jiraSync.js';

/** @this {import('./index.js').AgentManager} */
export const tasksMethods = {

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
    if (recurrence && recurrence.enabled) {
      newTask.recurrence = {
        enabled: true,
        period: recurrence.period || 'daily',
        intervalMinutes: recurrence.intervalMinutes || 1440,
        originalStatus: status,
      };
    }
    agent.todoList.push(newTask);
    saveAgent(agent);
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
    task.status = prevStatus === 'done' ? 'pending' : 'done';
    if (task.status === 'done') task.completedAt = new Date().toISOString();
    const now = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status: task.status, at: now, by: 'user' });
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  setTaskStatus(agentId, taskId, status, { skipAutoRefine = false, by = null } = {}) {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = agent.todoList.find(t => t.id === taskId);
    if (!task) return null;
    if (status === 'in_progress' && task.status !== 'in_progress') {
      const assigneeId = task.assignee || agentId;
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
    if (prevStatus === status) return task;
    task.status = status;
    delete task._pendingOnEnter;
    const now = new Date().toISOString();
    if (status === 'done') task.completedAt = now;
    if (status === 'in_progress') task.startedAt = now;
    if (status === 'error') {
      task.errorFromStatus = prevStatus;
    }
    if (status === 'in_progress') {
      task.inProgressFromStatus = prevStatus;
    }
    if (prevStatus === 'error' && status !== 'error') {
      delete task.errorFromStatus;
      delete task.error;
    }
    if (prevStatus === 'in_progress' && status !== 'in_progress') {
      delete task.inProgressFromStatus;
    }
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status, at: now, by: by || 'user' });
    saveAgent(agent);
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
    saveAgent(agent);
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
    saveAgent(agent);
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
    saveAgent(agent);
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
    saveAgent(agent);
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
        originalStatus: recurrence.originalStatus || task.recurrence?.originalStatus || 'pending',
      };
    } else {
      task.recurrence = null;
    }
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  _isActiveTaskStatus(status) {
    const INACTIVE = new Set(['done', 'pending', 'backlog', 'error']);
    return !INACTIVE.has(status);
  },

  _findTaskForCommitLink(agentId) {
    const agent = this.agents.get(agentId);
    if (agent?.todoList?.length) {
      const own = agent.todoList.find(t => t.status === 'in_progress');
      if (own) return { task: own, ownerAgentId: agentId };
      // Also check active workflow statuses (code, build, test, deploy, etc.)
      const ownActive = agent.todoList.find(t => this._isActiveTaskStatus(t.status) && t.status !== 'in_progress');
      if (ownActive) return { task: ownActive, ownerAgentId: agentId };
    }
    let bestInProgress = null;
    let bestActive = null;
    let bestDone = null;
    for (const [creatorId, creatorAgent] of this.agents) {
      if (!creatorAgent.todoList) continue;
      for (const task of creatorAgent.todoList) {
        const isOwnedOrAssigned = creatorId === agentId || task.assignee === agentId;
        if (!isOwnedOrAssigned) continue;
        if (task.status === 'in_progress') {
          bestInProgress = { task, ownerAgentId: creatorId };
          break;
        }
        if (this._isActiveTaskStatus(task.status) && !bestActive) {
          bestActive = { task, ownerAgentId: creatorId };
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
    if (bestActive) return bestActive;
    if (bestDone) {
      console.log(`🔗 [Commit] No in_progress task — falling back to recently done task "${bestDone.task.text?.slice(0, 50)}"`);
      return bestDone;
    }
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
    saveAgent(agent);
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
    saveAgent(agent);
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
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    this._recheckConditionalTransitions();
    return task;
  },

  deleteTask(agentId, taskId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.todoList = agent.todoList.filter(t => t.id !== taskId);
    saveAgent(agent);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  clearTasks(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    agent.todoList = [];
    saveAgent(agent);
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
    saveAgent(fromAgent);
    this._emit('agent:updated', this._sanitize(fromAgent));
    const newTask = this.addTask(toAgentId, taskToTransfer.text, taskToTransfer.project, { type: 'transfer', name: fromAgent.name, id: fromAgent.id }, prevStatus);
    if (newTask) {
      const actualTask = toAgent.todoList.find(t => t.id === newTask.id);
      if (actualTask) {
        actualTask.assignee = toAgentId;
        saveAgent(toAgent);
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

    if (task.status === 'pending') {
      delete task._executionStopped;
      const workflow = await getWorkflowForBoard(task.boardId);
      const hasRunAgent = workflow.transitions
        .filter(t => this._validTransition(t))
        .some(t => t.from === 'pending' && (t.actions || []).some(a => a.type === 'run_agent'));

      if (hasRunAgent) {
        this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
      } else {
        this.setTaskStatus(agentId, taskId, 'in_progress', { skipAutoRefine: true, by: 'task-loop' });
      }
    } else if (task.status === 'in_progress') {
      delete task._executionStopped;
      saveAgent(agent);
      this._checkAutoRefine({ ...task, agentId }, { by: 'resume' });
    } else {
      this.setTaskStatus(agentId, taskId, 'pending');
    }

    return { taskId, response: null };
  },

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
  },

  _processNextPendingTasks() {
    this._recheckConditionalTransitions();

    for (const [agentId, agent] of this.agents) {
      if (agent.enabled === false) continue;
      if (agent.status !== 'idle') continue;
      if (this._loopProcessing.has(agentId)) continue;

      let inProgressTask = null;
      let inProgressCreatorId = null;
      const ownInProgress = agent.todoList?.find(t =>
        t.status === 'in_progress' && (!t.assignee || t.assignee === agentId)
      );
      if (ownInProgress) {
        inProgressTask = ownInProgress;
        inProgressCreatorId = agentId;
      } else {
        for (const [oid, oa] of this.agents) {
          if (oid === agentId || !oa.todoList) continue;
          const found = oa.todoList.find(t => t.status === 'in_progress' && t.assignee === agentId);
          if (found) { inProgressTask = found; inProgressCreatorId = oid; break; }
        }
      }
      if (inProgressTask) {
        if (this._workflowManagedStatuses?.has('in_progress')) continue;
        // If the task was manually stopped, do NOT auto-resume it.
        // Move it back to pending so the user can decide when to restart.
        if (inProgressTask._executionStopped) {
          console.log(`🛑 [TaskLoop] Skipping auto-resume for "${inProgressTask.text.slice(0, 60)}" — was manually stopped`);
          this.setTaskStatus(inProgressCreatorId, inProgressTask.id, 'pending', { skipAutoRefine: true, by: 'user-stop' });
          continue;
        }
        // Skip if _waitForExecutionComplete is already monitoring this task
        if (inProgressTask._executionWatching) continue;
        this._loopProcessing.add(agentId);
        console.log(`🔄 [TaskLoop] Agent "${agent.name}" is idle but has in_progress task "${inProgressTask.text.slice(0, 60)}" — resuming`);
        this._resumeInProgressTask(inProgressCreatorId, this.agents.get(inProgressCreatorId), inProgressTask).finally(() => {
          this._loopProcessing.delete(agentId);
        });
        continue;
      }

      const task = agent.todoList?.find(t =>
        t.status === 'pending' && (!t.assignee || t.assignee === agentId)
      );
      if (!task) continue;

      if (this._workflowManagedStatuses?.has(task.status)) continue;

      // Skip tasks that were just stopped by the user — the flag is cleared
      // on the next manual start so the task won't be blocked forever.
      if (task._executionStopped) {
        continue;
      }

      this._loopProcessing.add(agentId);

      const streamCallback = (chunk) => {
        this._emit('agent:stream:chunk', { agentId, chunk });
        this._emit('agent:thinking', { agentId, thinking: agent.currentThinking || '' });
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
          if (agent.status === 'error') {
            this.setStatus(agentId, 'idle', 'Auto-recovered after task error');
          }
        })
        .finally(() => {
          this._loopProcessing.delete(agentId);
        });
    }
  },

  async _waitForExecutionComplete(creatorAgentId, taskId, executorId, executorName, targetStatus, taskText) {
    const freshTask = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);

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

    // Mark the task so the 5-second task loop doesn't re-send the original
    // message (which causes a full reasoning reset).
    if (freshTask) freshTask._executionWatching = true;

    console.log(`🔔 [Execution] Agent "${executorName}" went idle without completing "${taskText.slice(0, 60)}" — starting reminder loop`);
    const REMINDER_INTERVAL_MS = 5 * 60 * 1000;
    const MAX_REMINDERS = 12;
    let reminded = 0;

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
    } finally {
      // Always clear the watching flag so the task loop can resume if needed
      const watched = this.agents.get(creatorAgentId)?.todoList?.find(t => t.id === taskId);
      if (watched) delete watched._executionWatching;
    }
  },

  async _resumeInProgressTask(agentId, agent, task) {
    const executorId = task.assignee || agentId;
    const executor = this.agents.get(executorId) || agent;

    const streamCallback = (chunk) => {
      this._emit('agent:stream:chunk', { agentId: executorId, chunk });
      this._emit('agent:thinking', { agentId: executorId, thinking: executor.currentThinking || '' });
    };

    this._emit('agent:stream:start', { agentId: executorId });

    let startMsgIdx = executor.conversationHistory.length;
    let executionStartedAt = new Date().toISOString();

    try {
      let targetStatus = 'done';
      try {
        const workflow = await getWorkflowForBoard(task.boardId);
        const transition = workflow.transitions.find(t => {
          if (t.from !== 'in_progress') return false;
          if (this._validTransition(t)) {
            return (t.actions || []).some(a => a.type === 'run_agent' && a.targetStatus);
          }
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
        ? `[SYSTEM REMINDER] You have an in-progress task that needs to be completed:\n"${task.text.slice(0, 300)}"\n\nContinue where you left off. When you are done, call @task_execution_complete(summary of what was done).`
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
        this.setTaskStatus(agentId, task.id, 'pending', { skipAutoRefine: true, by: 'user-stop' });
      } else {
        this.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true, by: executor.name });
        const actualTask = this.agents.get(agentId)?.todoList?.find(t => t.id === task.id);
        if (actualTask) {
          actualTask.error = err.message;
          saveAgent(this.agents.get(agentId));
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
