// ─── Tasks: CRUD, execution, task loop, queue, wait, resume ──────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveTaskToDb, deleteTaskFromDb, deleteTasksByAgent, hardDeleteTaskFromDb, restoreTaskFromDb, getDeletedTasks, getDeletedTaskById, getTasksForResume, updateTaskExecutionStatus, getTaskById, getTasksByAgent, getActiveTasksByAgent, getActiveTaskForExecutor, getRecurringTasks, hasActiveTask, updateTaskFields } from '../database.js';
import { getWorkflowForBoard, getAllBoardWorkflows, getReminderConfig } from '../configManager.js';
import { isActiveStatus, getWorkflowManagedStatuses } from '../workflow/index.js';

// ── Ephemeral task signals ──────────────────────────────────────────────────
// Transient coordination flags between async coroutines (NOT persisted).
// Replaces in-memory task._execution* properties.
const _taskSignals = new Map<string, Record<string, any>>(); // taskId -> { completed, comment, stopped, watching, pendingOnEnter }

export function setTaskSignal(taskId: string, key: string, value: any): void {
  if (!_taskSignals.has(taskId)) _taskSignals.set(taskId, {});
  _taskSignals.get(taskId)![key] = value;
}

export function getTaskSignal(taskId: string, key: string): any {
  return _taskSignals.get(taskId)?.[key];
}

export function clearTaskSignal(taskId: string, key: string): void {
  const signals = _taskSignals.get(taskId);
  if (signals) {
    delete signals[key];
    if (Object.keys(signals).length === 0) _taskSignals.delete(taskId);
  }
}

export function clearTaskSignals(taskId: string): void {
  _taskSignals.delete(taskId);
}

/** Purge signals for task IDs that no longer exist in the active task set */
export function purgeStaleTaskSignals(activeTaskIds: Set<string>): void {
  for (const taskId of _taskSignals.keys()) {
    if (!activeTaskIds.has(taskId)) {
      _taskSignals.delete(taskId);
    }
  }
}

/**
 * Coerce an arbitrary input into a positive integer day count, or null if the
 * caller wants no retention (the default — keep the full history).
 * Caps at 3650 days (~10 years) to keep JSONB rows bounded even if the field
 * is mis-set via a direct API call.
 */
function normalizeRetention(value: any): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === false) return null;
  const n = typeof value === 'number' ? value : parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(3650, Math.floor(n));
}

/**
 * Drop history entries with `at` older than `cutoffMs`. Mutates the array
 * in place and returns the number of dropped entries.
 */
function pruneByDate<T extends { at?: string; date?: string }>(
  arr: T[] | undefined,
  cutoffMs: number,
): number {
  if (!Array.isArray(arr) || arr.length === 0) return 0;
  let dropped = 0;
  for (let i = arr.length - 1; i >= 0; i--) {
    const stamp = arr[i]?.at || arr[i]?.date;
    const t = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(t) && t < cutoffMs) {
      arr.splice(i, 1);
      dropped++;
    }
  }
  return dropped;
}

/** @this {import('./index.js').AgentManager} */
export const tasksMethods = {

  addTask(this: any, agentId: string, text: string, source: any, initialStatus?: string, { boardId, repoFullName, repoProvider, storagePath, storageProvider, skipAutoRefine = false, recurrence, taskType, isManual }: { boardId?: string; repoFullName?: string | null; repoProvider?: string | null; storagePath?: string | null; storageProvider?: string | null; skipAutoRefine?: boolean; recurrence?: any; taskType?: string; isManual?: boolean } = {}): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const defaultStatus = 'backlog';
    const status = initialStatus || defaultStatus;
    const now = new Date().toISOString();
    const newTask: any = {
      id: uuidv4(),
      text,
      status,
      // project is derived server-side from board.project_id; no longer stored on the task
      repoFullName: repoFullName || null,
      repoProvider: repoFullName ? (repoProvider || 'github') : null,
      storagePath: storagePath || null,
      storageProvider: storagePath ? (storageProvider || 'onedrive') : null,
      source: source || null,
      boardId: boardId || null,
      isManual: isManual || false,
      position: Date.now(),
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
        // Optional retention: drop history/commits older than N days at each
        // reset. null/0/undefined means "keep everything" (legacy behavior).
        historyRetentionDays: normalizeRetention(recurrence.historyRetentionDays),
        // Reference timestamp for the next reset. Set on creation so the first
        // cycle is measured from "now" regardless of how long the task takes
        // to reach `done` (or whether it ever does).
        lastResetAt: now,
      };
    }
    this._addTaskToStore(agentId, newTask);
    const savePromise = saveTaskToDb({ ...newTask, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    // Emit task:updated after the DB write has committed so the frontend
    // can add the new task to its list in real-time (the handler must support
    // inserting tasks it hasn't seen before, not just patching existing ones).
    const taskPayload = { ...newTask, agentId };
    Promise.resolve(savePromise)
      .catch(() => {})
      .then(() => this._emit('task:updated', { agentId, task: taskPayload }));
    if (!skipAutoRefine && !newTask.isManual) this._checkAutoRefine({ ...newTask, agentId });
    return newTask;
  },

  toggleTask(this: any, agentId: string, taskId: string): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
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

  setTaskStatus(this: any, agentId: string, taskId: string, status: string, { skipAutoRefine = false, by = null }: { skipAutoRefine?: boolean; by?: string | null } = {}): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    const prevStatus = task.status;
    if (prevStatus === status) return task;
    task.status = status;
    // Clear pending on enter signal
    clearTaskSignal(taskId, 'pendingOnEnter');
    delete task._pendingOnEnter;
    // Clear chain resume state so a new on_enter chain starts fresh.
    // Without this, a stale completedActionIdx from a previous chain
    // (e.g. refine) could cause the new chain (e.g. code) to skip actions.
    delete task._completedActionIdx;
    task.completedActionIdx = null;
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
      // An errored task is not running anymore — clear actionRunning so the
      // UI can show recovery actions (Resume / Clear-stopped) instead of the
      // Stop button. Without this, the task gets stuck: Stop appears but
      // does nothing visible (the executor may already be idle), and no
      // recovery button shows up.
      task.actionRunning = false;
      task.actionRunningAgentId = null;
      task.actionRunningMode = null;
    }
    if (prevStatus === 'error' && status !== 'error') {
      task.errorFromStatus = null;
      task.error = null;
    }
    if (!task.history) task.history = [];
    task.history.push({ from: prevStatus, status, at: now, by: by || 'user' });
    // Stamp updatedAt so the frontend can detect stale loadTasks() responses.
    // The DB sets its own updated_at = NOW() inside saveTaskToDb, but a SELECT
    // on a parallel pool connection may run before that UPDATE commits and
    // return a stale row. By including this client-side timestamp in the
    // task:updated payload, the frontend can compare and reject stale data.
    task.updatedAt = now;
    const savePromise = saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    // Emit task:updated so the TasksBoard UI updates in real-time
    // (agent:updated alone is not enough — the board listens on task:updated).
    //
    // We defer this emit until after the DB write has committed. The reason:
    // the debounced agent:updated emit (300ms) triggers a loadTasks() on the
    // frontend, which re-fetches from the DB. If the DB write hasn't landed
    // yet, that fetch returns a stale row and overwrites the in-memory state
    // — and since this is the last transition, no subsequent emit corrects
    // it. By chaining task:updated after savePromise we guarantee the emit
    // reflects (and is observed after) the persisted state.
    const taskPayload = { ...task, agentId };
    if (task.assignee) {
      const assigneeAgent = this.agents.get(task.assignee);
      taskPayload.assigneeName = assigneeAgent?.name || null;
      taskPayload.assigneeIcon = assigneeAgent?.icon || null;
    }
    Promise.resolve(savePromise)
      .catch(() => {})
      .then(() => this._emit('task:updated', { agentId, task: taskPayload }));
    if (!skipAutoRefine && status !== 'error' && !task.isManual) this._checkAutoRefine({ ...task, agentId }, { by: by || 'user' });
    return task;
  },

  updateTaskTitle(this: any, agentId: string, taskId: string, title: string): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    const oldTitle = task.title || null;
    task.title = title;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'title', oldValue: oldTitle, newValue: title });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskText(this: any, agentId: string, taskId: string, text: string): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    const oldText = task.text;
    task.text = text;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'text', oldValue: oldText, newValue: text });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskRepo(this: any, agentId: string, taskId: string, repoFullName: string | null, repoProvider: string | null = null): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    const oldFullName = task.repoFullName || null;
    task.repoFullName = repoFullName || null;
    task.repoProvider = repoFullName ? (repoProvider || task.repoProvider || 'github') : null;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'repoFullName', oldValue: oldFullName, newValue: repoFullName || null });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskStorage(this: any, agentId: string, taskId: string, storagePath: string | null, storageProvider: string | null = null): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    const oldPath = task.storagePath || null;
    task.storagePath = storagePath || null;
    task.storageProvider = storagePath ? (storageProvider || task.storageProvider || 'onedrive') : null;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'storagePath', oldValue: oldPath, newValue: storagePath || null });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskType(this: any, agentId: string, taskId: string, taskType: string, by: string = 'user'): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    const oldType = task.taskType || null;
    task.taskType = taskType || null;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by, type: 'edit', field: 'taskType', oldValue: oldType, newValue: taskType || null });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskRecurrence(this: any, agentId: string, taskId: string, recurrence: any): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    if (recurrence && recurrence.enabled) {
      const prev = task.recurrence || {};
      task.recurrence = {
        enabled: true,
        period: recurrence.period || 'daily',
        intervalMinutes: recurrence.intervalMinutes || 1440,
        originalStatus: recurrence.originalStatus || prev.originalStatus || 'backlog',
        historyRetentionDays: normalizeRetention(
          recurrence.historyRetentionDays !== undefined
            ? recurrence.historyRetentionDays
            : prev.historyRetentionDays
        ),
        // Preserve the existing reference timestamp so toggling recurrence
        // on/off mid-cycle doesn't postpone the next reset; default to now
        // if this is the first time recurrence is enabled.
        lastResetAt: prev.lastResetAt || new Date().toISOString(),
      };
    } else {
      task.recurrence = null;
    }
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  _isActiveTaskStatus(this: any, status: string): boolean {
    return isActiveStatus(status);
  },

  /** Resolve the first column ID of a board's workflow (used as default status) */
  async _getFirstColumnStatus(this: any, boardId: string): Promise<string> {
    try {
      const workflow = await getWorkflowForBoard(boardId);
      if (workflow?.columns?.length > 0) {
        return workflow.columns[0].id;
      }
    } catch { /* fall through */ }
    return 'backlog';
  },

  async _findTaskForCommitLink(this: any, agentId: string): Promise<{ task: any; ownerAgentId: string } | null> {
    // Window for the "recently active" fallback (used when status has transitioned
    // away from active — e.g. error from a rate-limit, or done seconds ago).
    // Commits made by an agent within this window after the task left the
    // "active" set still belong to that task in 99% of cases.
    const RECENT_ACTIVE_MS = 15 * 60 * 1000;
    const now = Date.now();

    // Priority 1: Task actively running via this agent.
    // We INTENTIONALLY do not require _isActiveTaskStatus here — if
    // actionRunningAgentId is still pointing at this agent, the action is in
    // flight and the link is valid even if the status briefly transitioned
    // (e.g. to "error" via a rate-limit handler or to "done" via @update_task).
    for (const [creatorId] of this.agents) {
      const creatorTasks = this._getAgentTasks(creatorId);
      for (const task of creatorTasks) {
        if (task.actionRunningAgentId === agentId) {
          console.log(`🔗 [Commit] Found task via actionRunningAgentId: "${task.text?.slice(0, 50)}" (status=${task.status}, owner=${creatorId.slice(0, 8)})`);
          return { task, ownerAgentId: creatorId };
        }
      }
    }

    // Priority 2: Active task explicitly assigned to this agent (from any agent's list)
    // Prefer the most recently started task when multiple are assigned.
    let bestAssigned: { task: any; ownerAgentId: string } | null = null;
    for (const [creatorId] of this.agents) {
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
      const ownActive = ownTasks.find((t: any) => this._isActiveTaskStatus(t.status));
      if (ownActive) {
        console.log(`🔗 [Commit] Found own active task: "${ownActive.text?.slice(0, 50)}"`);
        return { task: ownActive, ownerAgentId: agentId };
      }
    }

    // Priority 4: Recently active in-memory task (any status).
    // Catches the case where a task transitioned to error/done between the
    // commit being made and the run_command handler processing the result.
    // We scan ALL in-memory tasks (the agent may have been the assignee or the
    // executor for someone else's task) and pick the most-recently-started one
    // within RECENT_ACTIVE_MS.
    let bestRecent: { task: any; ownerAgentId: string; ts: number } | null = null;
    for (const [creatorId] of this.agents) {
      const creatorTasks = this._getAgentTasks(creatorId);
      for (const task of creatorTasks) {
        if (task.assignee !== agentId) continue;
        const ref = task.completedAt || task.startedAt;
        if (!ref) continue;
        const ts = new Date(ref).getTime();
        if (now - ts > RECENT_ACTIVE_MS) continue;
        if (!bestRecent || ts > bestRecent.ts) {
          bestRecent = { task, ownerAgentId: creatorId, ts };
        }
      }
    }
    if (bestRecent) {
      console.log(`🔗 [Commit] Found recently-active task: "${bestRecent.task.text?.slice(0, 50)}" (status=${bestRecent.task.status}, age=${Math.round((now - bestRecent.ts) / 1000)}s)`);
      return { task: bestRecent.task, ownerAgentId: bestRecent.ownerAgentId };
    }

    // Priority 5 (DB fallback): find active task from DB
    const activeTask = await getActiveTaskForExecutor(agentId);
    if (activeTask) {
      console.log(`🔗 [Commit] Found task via DB executor lookup: "${(activeTask as any).text?.slice(0, 50)}"`);
      return { task: activeTask, ownerAgentId: (activeTask as any).agentId };
    }

    // Priority 6 (DB fallback): recently completed/errored task. Include
    // 'error' so commits made just before/during a rate-limit failure still
    // attach to the originating task instead of creating a stray "Commit
    // without task".
    const allTasks = await getTasksByAgent(agentId);
    const recentlyFinished = allTasks
      .filter((t: any) => (t.status === 'done' || t.status === 'error') && (t.completedAt || t.startedAt))
      .map((t: any) => ({ task: t, ts: new Date(t.completedAt || t.startedAt).getTime() }))
      .filter((x: any) => now - x.ts <= RECENT_ACTIVE_MS);
    if (recentlyFinished.length > 0) {
      recentlyFinished.sort((a: any, b: any) => b.ts - a.ts);
      const top = recentlyFinished[0].task;
      console.log(`🔗 [Commit] No active task — falling back to recently finished task "${top.text?.slice(0, 50)}" (status=${top.status})`);
      return { task: top, ownerAgentId: top.agentId };
    }
    // Log diagnostic info when no task found at all
    const agentObj = this.agents.get(agentId);
    console.warn(`⚠️ [Commit] _findTaskForCommitLink: no task found for agent "${agentObj?.name || agentId.slice(0, 8)}". Checked: actionRunningAgentId, assignee, own tasks, recent in-mem, DB executor, DB recent finished.`);
    return null;
  },

  addTaskCommit(this: any, agentId: string, taskId: string, hash: string, message: string): any {
    let task: any = null;
    let ownerAgentId = agentId;
    for (const [aid, tasks] of this._tasks) {
      const found = (tasks as any[]).find((t: any) => t.id === taskId);
      if (found) { task = found; ownerAgentId = aid as string; break; }
    }
    if (!task) return null;
    if (!task.commits) task.commits = [];
    // Prefix-aware dedup: treat short and full hashes of the same commit as equal.
    // If a full hash is provided and a short hash already exists, upgrade it.
    const existingIdx = task.commits.findIndex((c: any) =>
      c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
    );
    if (existingIdx !== -1) {
      const existing = task.commits[existingIdx];
      // Upgrade: if the new hash is longer (full), replace the short one
      if (hash.length > existing.hash.length) {
        existing.hash = hash;
        if (message && !existing.message) existing.message = message;
        saveTaskToDb({ ...task, agentId: ownerAgentId });
      }
      return task;
    }
    task.commits.push({ hash, message: message || '', date: new Date().toISOString() });
    saveTaskToDb({ ...task, agentId: ownerAgentId });
    const agent = this.agents.get(ownerAgentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  removeTaskCommit(this: any, agentId: string, taskId: string, hash: string): any {
    let task: any = null;
    let ownerAgentId = agentId;
    for (const [aid, tasks] of this._tasks) {
      const found = (tasks as any[]).find((t: any) => t.id === taskId);
      if (found) { task = found; ownerAgentId = aid as string; break; }
    }
    if (!task || !task.commits) return null;
    const before = task.commits.length;
    task.commits = task.commits.filter((c: any) => c.hash !== hash);
    if (task.commits.length === before) return null;
    saveTaskToDb({ ...task, agentId: ownerAgentId });
    const agent = this.agents.get(ownerAgentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  setTaskAssignee(this: any, agentId: string, taskId: string, assigneeId: string): any {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return null;
    task.assignee = assigneeId;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'reassign', assignee: assigneeId });
    saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    this._recheckConditionalTransitions();
    return task;
  },

  deleteTask(this: any, agentId: string, taskId: string): boolean {
    const task = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (!task) return false;
    this._removeTaskFromStore(agentId, taskId);
    deleteTaskFromDb(taskId);
    clearTaskSignals(taskId);
    const agent = this.agents.get(agentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    this._emit('task:deleted', { taskId, agentId });
    return true;
  },

  async restoreTask(this: any, taskId: string): Promise<any> {
    const restored = await restoreTaskFromDb(taskId);
    if (!restored) return null;
    if (!restored.history) restored.history = [];
    restored.history.push({ status: restored.status, at: new Date().toISOString(), by: 'user', type: 'restored' });
    await saveTaskToDb({ ...restored, agentId: restored.agentId });
    this._addTaskToStore(restored.agentId, restored);
    const agent = this.agents.get(restored.agentId);
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return restored;
  },

  async hardDeleteTask(this: any, taskId: string): Promise<any> {
    clearTaskSignals(taskId);
    const result = await hardDeleteTaskFromDb(taskId);
    return result;
  },

  async getDeletedTasks(this: any): Promise<any[]> {
    return getDeletedTasks();
  },

  clearTasks(this: any, agentId: string): boolean {
    const agent = this.agents.get(agentId);
    if (!agent) return false;
    this._clearAgentTasks(agentId);
    deleteTasksByAgent(agentId);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  transferTask(this: any, fromAgentId: string, taskId: string, toAgentId: string): any {
    const fromAgent = this.agents.get(fromAgentId);
    const toAgent = this.agents.get(toAgentId);
    if (!fromAgent || !toAgent) return null;
    const taskToTransfer = this._getAgentTasks(fromAgentId).find((t: any) => t.id === taskId);
    if (!taskToTransfer) return null;
    const prevStatus = taskToTransfer.status;
    this._removeTaskFromStore(fromAgentId, taskId);
    deleteTaskFromDb(taskId);
    this._emit('agent:updated', this._sanitize(fromAgent));
    const newTask = this.addTask(toAgentId, taskToTransfer.text, { type: 'transfer', name: fromAgent.name, id: fromAgent.id }, prevStatus, { boardId: taskToTransfer.boardId, repoFullName: taskToTransfer.repoFullName, repoProvider: taskToTransfer.repoProvider, storagePath: taskToTransfer.storagePath, storageProvider: taskToTransfer.storageProvider });
    if (newTask) {
      newTask.assignee = toAgentId;
      saveTaskToDb({ ...newTask, agentId: toAgentId });
      this._checkAutoRefine({ ...newTask, assignee: toAgentId, agentId: toAgentId });
    }
    return newTask;
  },

  async executeTask(this: any, agentId: string, taskId: string, streamCallback: any): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const task = await getTaskById(taskId);
    if (!task) throw new Error('Task not found');
    if (task.status === 'done') throw new Error('Task already completed');

    console.log(`[Workflow] Triggering execution for "${task.text.slice(0, 80)}" (status=${task.status})`);

    clearTaskSignal(taskId, 'stopped');
    clearTaskSignal(taskId, 'watching');
    await updateTaskExecutionStatus(taskId, null);

    // Reset the failure circuit breaker so a manual resume always gets a fresh attempt
    this._taskResumeFailures?.delete(taskId);

    // Update in-memory task and notify frontend so the yellow "Stopped" state clears
    const memTask = this._getAgentTasks(agentId).find((t: any) => t.id === taskId);
    if (memTask) {
      memTask.executionStatus = null;
      this._emit('task:updated', { agentId, task: { ...memTask, agentId } });
    }

    if (this._isActiveTaskStatus(task.status)) {
      // Manual resume of an in-flight task: send the prompt directly so the
      // agent actually picks up where it left off, instead of relying on the
      // 5s task loop (which can skip resume if executionStatus="watching" or
      // the workflow engine doesn't fire on_enter for the current column).
      const executorId = task.assignee || agentId;
      const executor = this.agents.get(executorId);

      if (!executor) {
        // Fall back to the workflow engine if the executor is gone
        this._checkAutoRefine({ ...task, agentId }, { by: 'resume' });
        return { taskId, response: null };
      }

      if (executor.status !== 'idle') {
        throw new Error(`Agent "${executor.name}" is busy — stop it first before resuming`);
      }

      if (!this._loopProcessing) this._loopProcessing = new Set();
      if (this._loopProcessing.has(executorId)) {
        throw new Error(`Agent "${executor.name}" is already processing another task`);
      }

      this._loopProcessing.add(executorId);
      // Fire-and-forget — caller (socket handler) doesn't await the agent run
      this._resumeActiveTask(agentId, executor, task)
        .catch((err: any) => console.error(`[Resume] _resumeActiveTask failed for "${task.text?.slice(0, 60)}":`, err.message))
        .finally(() => {
          this._loopProcessing.delete(executorId);
        });
    } else {
      this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
    }

    return { taskId, response: null };
  },

  async executeAllTasks(this: any, agentId: string, streamCallback: any): Promise<any[]> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    const tasks = await getTasksByAgent(agentId);
    const executable = tasks.filter((t: any) => t.status !== 'done' && !this._isActiveTaskStatus(t.status));
    if (executable.length === 0) throw new Error('No executable tasks');

    console.log(`▶️  Executing ${executable.length} task(s) for ${agent.name}`);
    this._emit('agent:task:executeAll:start', { agentId, count: executable.length });

    const results: any[] = [];
    for (const task of executable) {
      try {
        const result = await this.executeTask(agentId, task.id, streamCallback);
        results.push({ taskId: task.id, text: task.text, success: true, response: result.response });
      } catch (err: any) {
        results.push({ taskId: task.id, text: task.text, success: false, error: err.message });
      }
    }

    this._emit('agent:task:executeAll:complete', { agentId, results: results.map(r => ({ taskId: r.taskId, success: r.success })) });
    return results;
  },

  // ─── Task Loop ──────────────────────────────────────────────────────
  startTaskLoop(this: any, intervalMs: number = 5000): void {
    if (this._taskLoopInterval) return;
    this._loopProcessing = new Set();
    this._taskResumeFailures = new Map(); // taskId -> { count, lastFailedAt }
    this._workflowManagedStatuses = new Set();
    this._refreshWorkflowManagedStatuses();
    this._taskLoopInterval = setInterval(() => this._processNextPendingTasks(), intervalMs);
    this._recurrenceInterval = setInterval(() => this._processRecurringTasks(), 60000);
    this._workflowRefreshInterval = setInterval(() => this._refreshWorkflowManagedStatuses(), 30000);
    console.log(`🔄 Task loop started (every ${intervalMs / 1000}s)`);
  },

  _refreshWorkflowManagedStatuses(this: any): void {
    getAllBoardWorkflows().then((boardWorkflows: any) => {
      this._workflowManagedStatuses = getWorkflowManagedStatuses(boardWorkflows);
      if (this._workflowManagedStatuses.size > 0) {
        console.log(`🔄 [TaskLoop] Workflow-managed statuses: ${[...this._workflowManagedStatuses].join(', ')}`);
      }
    }).catch(() => {});
  },

  stopTaskLoop(this: any): void {
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

  async _processRecurringTasks(this: any): Promise<void> {
    const now = Date.now();
    const nowIso = new Date(now).toISOString();
    const recurringTasks = await getRecurringTasks();
    for (const t of recurringTasks) {
      const task: any = t;
      const rec = task.recurrence || {};
      const intervalMs = (rec.intervalMinutes || 1440) * 60 * 1000;

      // Reference timestamp: prefer the explicit lastResetAt (set on creation
      // and at every reset). Fall back to completedAt → startedAt → createdAt
      // so legacy tasks without lastResetAt still trigger correctly.
      const refIso = rec.lastResetAt || task.completedAt || task.startedAt || task.createdAt;
      const refMs = refIso ? Date.parse(refIso) : NaN;
      if (!Number.isFinite(refMs)) continue;
      if (now - refMs < intervalMs) continue;

      const resetStatus = rec.originalStatus || 'backlog';
      const prevStatus = task.status;

      // Purge old log entries before appending the reset event, so the new
      // event isn't itself eligible for purge on the next cycle.
      let prunedHistory = 0;
      let prunedCommits = 0;
      const retentionDays = normalizeRetention(rec.historyRetentionDays);
      if (retentionDays) {
        const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
        prunedHistory = pruneByDate(task.history, cutoffMs);
        prunedCommits = pruneByDate(task.commits, cutoffMs);
      }

      console.log(
        `🔁 [Recurrence] Resetting task "${(task.text || '').slice(0, 60)}" `
        + `${prevStatus} → ${resetStatus} (interval: ${rec.intervalMinutes}min`
        + (retentionDays ? `, retention: ${retentionDays}d, pruned: ${prunedHistory}h/${prunedCommits}c` : '')
        + `)`
      );

      task.status = resetStatus;
      task.completedAt = null;
      task.startedAt = null;
      task.executionStatus = null;
      task.completedActionIdx = null;
      task.actionRunning = false;
      task.actionRunningAgentId = null;
      task.actionRunningMode = null;
      task.error = null;
      task.errorFromStatus = null;
      if (!task.history) task.history = [];
      task.history.push({ from: prevStatus, status: resetStatus, at: nowIso, by: 'recurrence' });
      task.recurrence = { ...rec, lastResetAt: nowIso };

      // Drop ephemeral execution signals from the previous cycle so the
      // freshly-reset task isn't blocked by stale "stopped"/"watching" flags.
      clearTaskSignals(task.id);

      // Mirror the reset onto the in-memory copy used by the task loop, so
      // it doesn't keep seeing the pre-reset status (e.g. a stale `done`
      // would prevent the freshly-armed task from being picked up).
      const memTask = this._getAgentTasks(task.agentId).find((mt: any) => mt.id === task.id);
      if (memTask) {
        memTask.status = task.status;
        memTask.completedAt = task.completedAt;
        memTask.startedAt = task.startedAt;
        memTask.executionStatus = task.executionStatus;
        memTask.completedActionIdx = task.completedActionIdx;
        memTask.actionRunning = task.actionRunning;
        memTask.actionRunningAgentId = task.actionRunningAgentId;
        memTask.actionRunningMode = task.actionRunningMode;
        memTask.error = task.error;
        memTask.errorFromStatus = task.errorFromStatus;
        memTask.history = task.history;
        memTask.commits = task.commits;
        memTask.recurrence = task.recurrence;
      }

      await saveTaskToDb(task);
      const agent = this.agents.get(task.agentId);
      if (agent) this._emit('agent:updated', this._sanitize(agent));
      this._emit('task:updated', { agentId: task.agentId, task: { ...task } });
    }
  },

  _processNextPendingTasks(this: any): void {
    this._recheckConditionalTransitions();

    // Periodically purge stale task signals to prevent unbounded Map growth
    const allTaskIds = new Set<string>();
    for (const tasks of this._tasks.values()) {
      for (const t of tasks as any[]) allTaskIds.add(t.id);
    }
    purgeStaleTaskSignals(allTaskIds);

    // Use DB query to find tasks that need resume
    getTasksForResume().then(async (dbTasks: any[]) => {
      for (const dbTask of dbTasks) {
        const executorId = dbTask.assignee || dbTask.agentId;
        const executor = this.agents.get(executorId);
        if (!executor) continue;
        if (executor.status !== 'idle') continue;
        if (this._loopProcessing.has(executorId)) continue;
        if (!this._isActiveTaskStatus(dbTask.status)) continue;

        if (this._workflowManagedStatuses?.has(dbTask.status)) continue;

        if (dbTask.executionStatus === 'stopped' || getTaskSignal(dbTask.id, 'stopped')) {
          continue;
        }
        if (dbTask.executionStatus === 'watching' || getTaskSignal(dbTask.id, 'watching')) continue;

        // Circuit breaker: stop retrying tasks that fail repeatedly
        const MAX_RESUME_FAILURES = 3;
        const FAILURE_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
        const failureInfo = this._taskResumeFailures?.get(dbTask.id);
        if (failureInfo && failureInfo.count >= MAX_RESUME_FAILURES) {
          if (Date.now() - failureInfo.lastFailedAt < FAILURE_COOLDOWN_MS) {
            continue; // Still in cooldown, skip silently
          }
          // Cooldown expired — reset and allow one more attempt
          this._taskResumeFailures.delete(dbTask.id);
        }

        this._loopProcessing.add(executorId);
        console.log(`🔄 [TaskLoop] Agent "${executor.name}" is idle but has started task "${dbTask.text.slice(0, 60)}" (${dbTask.status}) — resuming`);
        this._resumeActiveTask(dbTask.agentId, this.agents.get(dbTask.agentId), dbTask).then(() => {
          // Successful resume — reset failure counter
          this._taskResumeFailures?.delete(dbTask.id);
        }).catch(() => {
          // Track consecutive failures for this task
          const prev = this._taskResumeFailures?.get(dbTask.id) || { count: 0 };
          const newCount = prev.count + 1;
          this._taskResumeFailures?.set(dbTask.id, { count: newCount, lastFailedAt: Date.now() });
          if (newCount >= MAX_RESUME_FAILURES) {
            console.log(`🔴 [TaskLoop] Circuit breaker: task "${dbTask.text.slice(0, 60)}" failed ${newCount} consecutive resumes — pausing for ${FAILURE_COOLDOWN_MS / 60000}min`);
          }
        }).finally(() => {
          this._loopProcessing.delete(executorId);
        });
      }
    }).catch((err: any) => {
      console.error('[TaskLoop] Failed to query tasks for resume:', err.message);
    });
  },

  async _waitForExecutionComplete(this: any, creatorAgentId: string, taskId: string, executorId: string, executorName: string, taskText: string): Promise<string> {
    const freshTask = this._getAgentTasks(creatorAgentId).find((t: any) => t.id === taskId);
    console.log(`🔍 [Execution] _waitForExecutionComplete: task=${taskId} creator=${creatorAgentId} executor=${executorName} _executionCompleted=${freshTask?._executionCompleted} status=${freshTask?.status}`);

    // Helper: check if task was completed via signal
    const _checkCompleted = async (): Promise<string | null> => {
      if (getTaskSignal(taskId, 'completed')) {
        const comment = getTaskSignal(taskId, 'comment') || '';
        clearTaskSignal(taskId, 'completed');
        clearTaskSignal(taskId, 'comment');
        console.log(`✅ [Execution] task_execution_complete for "${taskText.slice(0, 60)}"${comment ? ` (${comment.slice(0, 80)})` : ''}`);
        return 'completed';
      }
      return null;
    };

    // Early exit if the executor was stopped (e.g. user pressed Stop) before we
    // got here — otherwise we'd hold the workflow lock through the 10-min
    // reminder loop while the agent is already idle.
    if (getTaskSignal(taskId, 'stopped')) {
      clearTaskSignal(taskId, 'stopped');
      console.log(`🛑 [Execution] Task ${taskId} "${taskText.slice(0, 60)}" was stopped before wait started — exiting`);
      return 'stopped';
    }

    // Check immediate completion
    if (freshTask?.status === 'error') {
      console.log(`[Execution] Task ${taskId} "${taskText.slice(0, 60)}" ended with error — blocking transition`);
      return 'error';
    }

    if (freshTask?._executionCompleted) {
      const comment = freshTask._executionComment || '';
      delete freshTask._executionCompleted;
      delete freshTask._executionComment;
      console.log(`✅ [Execution] task ${taskId} completed via task_execution_complete${comment ? ` (${comment.slice(0, 80)})` : ''}`);
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

    // ── Immediate retry: if the agent went idle without producing any output
    // (empty response from coder-service, e.g. session corruption), re-send
    // the task immediately instead of waiting for the slow reminder loop.
    // Check if executor is already idle (not busy from another concurrent task).
    const immediateExecutor = this.agents.get(executorId);
    if (immediateExecutor && immediateExecutor.status === 'idle' && !getTaskSignal(taskId, 'stopped')) {
      // Brief delay to let any in-flight state settle (e.g. socket events)
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Re-check signals after the short wait
      const earlyCompleted = await _checkCompleted();
      if (earlyCompleted) return earlyCompleted;
      const earlyTask = await getTaskById(taskId);
      if (!earlyTask || !this._isActiveTaskStatus((earlyTask as any).status)) {
        return earlyTask ? 'moved' : 'deleted';
      }
      if (getTaskSignal(taskId, 'stopped')) {
        clearTaskSignal(taskId, 'stopped');
        return 'stopped';
      }

      if (immediateExecutor.status === 'idle') {
        console.log(`🔄 [Execution] Agent "${executorName}" went idle without completing task ${taskId} "${taskText.slice(0, 60)}" — retrying immediately`);
        this._emit('agent:stream:start', { agentId: executorId });
        try {
          const retryStartIdx = immediateExecutor.conversationHistory.length;
          const retryStartedAt = new Date().toISOString();
          await this.sendMessage(
            executorId,
            `[SYSTEM] You went idle without completing your task. Continue working on it now:\n"${taskText.slice(0, 500)}"\n\nUse your tools to complete the task. When done, call @task_execution_complete(summary).`,
            (chunk: any) => {
              this._emit('agent:stream:chunk', { agentId: executorId, chunk });
              this._emit('agent:thinking', { agentId: executorId, thinking: immediateExecutor.currentThinking || '' });
            }
          );
          // _saveExecutionLog moved to caller — captures full conversation including retries
        } catch (retryErr: any) {
          console.error(`🔄 [Execution] Immediate retry failed: ${retryErr.message}`);
        }
        this._emit('agent:stream:end', { agentId: executorId });
        this._emit('agent:updated', this._sanitize(immediateExecutor));

        // Check if the immediate retry completed the task
        const retryResult = await _checkCompleted();
        if (retryResult) return retryResult;
        const retryTask = this._getAgentTasks(creatorAgentId).find((t: any) => t.id === taskId);
        if (retryTask?._executionCompleted) {
          const comment = retryTask._executionComment || '';
          delete retryTask._executionCompleted;
          delete retryTask._executionComment;
          return 'completed';
        }
      }
    }

    const reminderConfig = await getReminderConfig();
    console.log(`🔔 [Execution] Agent "${executorName}" still idle after immediate retry for task ${taskId} "${taskText.slice(0, 60)}" — falling back to reminder loop (interval=${reminderConfig.intervalMinutes}min, cooldown=${reminderConfig.cooldownMinutes}min)`);
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
      // Check signals first (reliable in-memory coordination set by tool handler)
      const completedResult = await _checkCompleted();
      if (completedResult) return completedResult;
      // Also check the in-memory task object's legacy flag (set on the live task ref)
      const inMemoryTask = this._getAgentTasks(creatorAgentId).find((t: any) => t.id === taskId);
      if (inMemoryTask?._executionCompleted) {
        const comment = inMemoryTask._executionComment || '';
        delete inMemoryTask._executionCompleted;
        delete inMemoryTask._executionComment;
        console.log(`✅ [Execution] Task ${taskId} completed during wait (in-memory flag)${comment ? ` (${comment.slice(0, 80)})` : ''}`);
        return 'completed';
      }
      if (!this._isActiveTaskStatus((currentTask as any).status)) {
        console.log(`🔔 [Execution] Task status changed to "${(currentTask as any).status}" — exiting loop`);
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
          (chunk: any) => {
            this._emit('agent:stream:chunk', { agentId: executorId, chunk });
            this._emit('agent:thinking', { agentId: executorId, thinking: currentExecutor.currentThinking || '' });
          }
        );

        // _saveExecutionLog moved to caller — captures full conversation including reminders
      } catch (reminderErr: any) {
        console.error(`🔔 [Execution] Reminder failed: ${reminderErr.message}`);
      }
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(currentExecutor));

      const afterResult = await _checkCompleted();
      if (afterResult) return afterResult;
    }

    if (reminded >= MAX_REMINDERS) {
      const finalTask = await getTaskById(taskId);
      if (finalTask && this._isActiveTaskStatus((finalTask as any).status) && !getTaskSignal(taskId, 'completed')) {
        console.warn(`⚠️ [Execution] Max reminders (${MAX_REMINDERS}) reached for "${taskText.slice(0, 60)}" — task remains active (${(finalTask as any).status})`);
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

  async _resumeActiveTask(this: any, agentId: string, agent: any, task: any): Promise<void> {
    const executorId = task.assignee || agentId;
    const executor = this.agents.get(executorId) || agent;

    const streamCallback = (chunk: any) => {
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
      // Repo selection drives the executor's project context. The task carries
      // a `repoFullName` (hydrated from board_repos via the JOIN); if it
      // differs from the executor's current repo we switch sandbox + history.
      const taskRepo = task.repoFullName || null;
      if (taskRepo && taskRepo !== executor.project) {
        console.log(`🔄 [TaskLoop] Switching "${executor.name}" from "${executor.project || '(none)'}" to repo "${taskRepo}" for resume`);
        if (this._switchProjectContext) {
          this._switchProjectContext(executor, executor.project, taskRepo);
        }
        if (this.executionManager) {
          try {
            const gitUrl = task.repoHtmlUrl || (taskRepo ? `https://github.com/${taskRepo}.git` : null);
            if (gitUrl) {
              const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
              const gitCreds = await getGitHubCredentialsForAgent(executorId, executor.boardId || null);
              await this.executionManager.switchProject(executorId, taskRepo, gitUrl, gitCreds);
            }
            const envProject = this.executionManager.getProject(executorId);
            if (envProject && envProject !== taskRepo) {
              throw new Error(`Execution environment is on "${envProject}" but task requires "${taskRepo}"`);
            }
          } catch (switchErr: any) {
            console.error(`🔄 [TaskLoop] Execution env switch failed for "${executor.name}": ${switchErr.message}`);
            throw switchErr;
          }
        }
        executor.project = taskRepo;
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
        (msg: any) => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes(taskPrefix)
      );
      const messageToSend = alreadySent
        ? `[SYSTEM REMINDER] You have an active task that needs to be completed:\n"${task.text.slice(0, 300)}"\n\nContinue where you left off. When you are done, call @task_execution_complete(summary of what was done).`
        : task.text;

      const result = await this.sendMessage(executorId, messageToSend, streamCallback);

      // _saveExecutionLog moved after _waitForExecutionComplete — captures full conversation

      const waitResult = await this._waitForExecutionComplete(agentId, task.id, executorId, executor.name, task.text);

      // Save execution log AFTER wait completes — captures the full conversation
      // including retries, reminders, tool calls, and task_execution_complete
      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, waitResult !== "error" && waitResult !== "timeout");
    } catch (err: any) {
      const isUserStop = err.message === 'Agent stopped by user';
      console.error(`🔄 [TaskLoop] Error resuming task for ${executor.name}:`, err.message);
      this._emit('agent:stream:error', { agentId: executorId, error: err.message });

      // Save execution log for the error case — captures whatever conversation happened before the error
      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, false);

      const errorTimestamp = new Date().toISOString();

      if (isUserStop) {
        // User manually stopped — mark as stopped, keep in current column
        setTaskSignal(task.id, 'stopped', true);
        await updateTaskExecutionStatus(task.id, 'stopped');
        // Add stopped entry to history
        const stoppedTask = this._getAgentTasks(agentId).find((t: any) => t.id === task.id);
        if (stoppedTask) {
          if (!stoppedTask.history) stoppedTask.history = [];
          stoppedTask.history.push({
            status: stoppedTask.status,
            at: errorTimestamp,
            by: 'user',
            type: 'stopped',
          });
          stoppedTask.startedAt = null;
          stoppedTask.actionRunning = false;
          delete stoppedTask.actionRunningAgentId;
          delete stoppedTask.actionRunningMode;
          await saveTaskToDb({ ...stoppedTask, agentId });
          this._emit('task:updated', { agentId, task: { ...stoppedTask, agentId } });
        }
      } else {
        // Real error — keep task in current column, mark as error via errorFromStatus
        const errorTask = this._getAgentTasks(agentId).find((t: any) => t.id === task.id);
        if (errorTask) {
          const prevStatus = errorTask.status;
          errorTask.errorFromStatus = prevStatus;
          errorTask.status = 'error';
          errorTask.error = err.message;
          if (!errorTask.history) errorTask.history = [];
          errorTask.history.push({
            status: 'error',
            from: prevStatus,
            at: errorTimestamp,
            by: executor.name,
            type: 'error',
            error: err.message,
          });
          errorTask.actionRunning = false;
          delete errorTask.actionRunningAgentId;
          delete errorTask.actionRunningMode;
          await saveTaskToDb({ ...errorTask, agentId });
          this._emit('task:updated', { agentId, task: { ...errorTask, agentId } });
        } else {
          await this.setTaskStatus(agentId, task.id, 'error', { skipAutoRefine: true, by: executor.name });
          await updateTaskFields(task.id, { error: err.message });
        }
        this._emit('agent:error:report', {
          agentId: executorId,
          agentName: executor.name,
          project: executor.project || null,
          description: `[System Error] Task "${task.text?.slice(0, 100)}" failed: ${err.message}`,
          timestamp: errorTimestamp,
          isSystemError: true,
          taskId: task.id,
        });
      }
      if (executor.status === 'error') {
        this.setStatus(executorId, 'idle', 'Auto-recovered after resume error');
      }
    } finally {
      this._emit('agent:stream:end', { agentId: executorId });
      this._emit('agent:updated', this._sanitize(executor));
    }
  },

  /** Find a task by ID (from in-memory store) */
  getTask(this: any, taskId: string): any {
    const result = this._findTaskAcross((t: any) => t.id === taskId);
    if (!result) return null;
    return { ...result.task, agentId: result.agentId };
  },

  /** Save a task to the database (returns a promise for awaitable saves) */
  saveTaskDirectly(this: any, task: any): any {
    if (!task || !task.agentId) return;
    return saveTaskToDb(task);
  },

  _enqueueAgentTask(this: any, agentId: string, taskFn: () => Promise<any>): Promise<any> {
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
