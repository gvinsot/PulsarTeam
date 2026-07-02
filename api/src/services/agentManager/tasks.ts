// ─── Tasks: CRUD, execution, task loop, queue, wait, resume ──────────────────
import { v4 as uuidv4 } from 'uuid';
import { saveTaskToDb, deleteTaskFromDb, deleteTasksByAgent, hardDeleteTaskFromDb, restoreTaskFromDb, getDeletedTasks, getDeletedTaskById, getTasksForResume, updateTaskExecutionStatus, getTaskById, getTasksByAgent, getAllTaskIds, getActiveTasksByAgent, getActiveTaskForExecutor, getTasksByAssignee, getTaskByActionRunningAgent, getRecurringTasks, hasActiveTask, updateTaskFields, clearAllStaleActionRunning } from '../database.js';
import { getWorkflowForBoard, getAllBoardWorkflows, getReminderConfig } from '../configManager.js';
import { isActiveStatus, getWorkflowManagedStatuses, getReassigningStatuses, markTaskError, isUserStopError, reArmInterruptedChains } from '../workflow/index.js';
import { getCurrentEnvironment } from '../../lib/environment.js';
import { isCliRunner, SELF_COMPLETING_RUNNERS } from '../runners.js';

async function bindAgentRunner(manager: any, agent: any): Promise<void> {
  if (!manager.executionManager?.bindAgent || !agent?.id) return;
  const llmConfig = manager.resolveLlmConfig?.(agent) || {};
  const providerType = agent.runner || (llmConfig.managesContext ? 'claudecode' : 'sandbox');
  let gitCreds = null;
  try {
    const { getGitHubCredentialsForAgent } = await import('../../routes/github.js');
    gitCreds = await getGitHubCredentialsForAgent(agent.id, agent.boardId || null);
  } catch {
    gitCreds = null;
  }
  manager.executionManager.bindAgent(agent.id, providerType, {
    ownerId: agent.ownerId || null,
    gitCredentials: gitCreds,
    permissions: agent.permissions || null,
    llmConfig: agent.llmConfigId ? llmConfig : null,
  });
}

// ── Ephemeral task signals ──────────────────────────────────────────────────
// Transient coordination flags between async coroutines (NOT persisted).
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

// Same "owner/repo" shape the primary repo is validated against (routes/agents.ts).
const REPO_FULLNAME_RE = /^[\w.-]+\/[\w.-]+$/;
const MAX_SECONDARY_REPOS = 10;

/**
 * Coerce an arbitrary secondaryRepos input into a clean [{provider, fullName}]:
 * accept either bare "owner/repo" strings or {provider, fullName} objects, keep
 * only well-formed entries, default provider to 'github', drop the primary repo,
 * dedupe by fullName, and cap the count so clone time stays bounded. Always
 * returns an array (never null).
 */
export function normalizeSecondaryRepos(input: any, primaryFullName?: string | null): Array<{ provider: string; fullName: string }> {
  if (!Array.isArray(input)) return [];
  const primary = primaryFullName || null;
  const seen = new Set<string>();
  const out: Array<{ provider: string; fullName: string }> = [];
  for (const raw of input) {
    const fullName = typeof raw === 'string'
      ? raw
      : (raw && typeof raw.fullName === 'string' ? raw.fullName : null);
    if (!fullName || !REPO_FULLNAME_RE.test(fullName)) continue;
    if (primary && fullName === primary) continue;
    if (seen.has(fullName)) continue;
    seen.add(fullName);
    const provider = (raw && typeof raw === 'object' && typeof raw.provider === 'string' && raw.provider)
      ? raw.provider
      : 'github';
    out.push({ provider, fullName });
    if (out.length >= MAX_SECONDARY_REPOS) break;
  }
  return out;
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

  async addTask(this: any, agentId: string | null, text: string, source: any, initialStatus?: string, { boardId, repoFullName, repoProvider, secondaryRepos, storagePath, storageProvider, skipAutoRefine = false, recurrence, taskType, isManual, environment }: { boardId?: string; repoFullName?: string | null; repoProvider?: string | null; secondaryRepos?: any; storagePath?: string | null; storageProvider?: string | null; skipAutoRefine?: boolean; recurrence?: any; taskType?: string; isManual?: boolean; environment?: string | null } = {}): Promise<any> {
    // agentId === null → unassigned task: lives on a board, waits to be picked up.
    // Requires a boardId to make sense (the board IS its home in that case).
    const agent = agentId ? this.agents.get(agentId) : null;
    if (agentId && !agent) return null;
    if (!agentId && !boardId) return null;
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
      // Secondary repos cloned alongside the primary; normalized (deduped,
      // primary-excluded, capped) so the stored shape is always clean.
      secondaryRepos: normalizeSecondaryRepos(secondaryRepos, repoFullName || null),
      storagePath: storagePath || null,
      storageProvider: storagePath ? (storageProvider || 'onedrive') : null,
      source: source || null,
      boardId: boardId || null,
      isManual: isManual || false,
      // Fall back to the instance's locked environment when the caller (e.g.
      // recurring task reset, jira sync, MCP-triggered task) has no request
      // hostname to derive one from. Ensures the workflow engine of the same
      // replica still picks the task up.
      environment: environment || getCurrentEnvironment(),
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
    // Persist first; the DB row is the single source of truth (no in-memory store).
    // Awaiting the write guarantees downstream readers (_checkAutoRefine → workflow
    // processing, and the frontend's loadTasks() after agent:updated) observe the
    // committed row rather than racing a fire-and-forget save.
    await saveTaskToDb({ ...newTask, agentId }).catch(() => {});
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    // Emit task:updated after the DB write has committed so the frontend
    // can add the new task to its list in real-time (the handler must support
    // inserting tasks it hasn't seen before, not just patching existing ones).
    const taskPayload = { ...newTask, agentId };
    this._emit('task:updated', { agentId, task: taskPayload });
    // Skip auto-refine for unassigned tasks — there's no agent to refine for yet.
    if (agentId && !skipAutoRefine && !newTask.isManual) this._checkAutoRefine({ ...newTask, agentId });
    return newTask;
  },

  async toggleTask(this: any, agentId: string, taskId: string): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const prevStatus = task.status;
    const previousAssignee = task.assignee || null;
    task.status = prevStatus === 'done' ? 'backlog' : 'done';
    if (previousAssignee) task.assignee = null;
    if (task.status === 'done') task.completedAt = new Date().toISOString();
    const now = new Date().toISOString();
    if (!task.history) task.history = [];
    task.history.push({
      from: prevStatus,
      status: task.status,
      at: now,
      by: 'user',
      ...(previousAssignee ? { assignee: null, previousAssignee } : {}),
    });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async setTaskStatus(this: any, agentId: string, taskId: string, status: string, { skipAutoRefine = false, by = null }: { skipAutoRefine?: boolean; by?: string | null } = {}): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const prevStatus = task.status;
    if (prevStatus === status) return task;
    const previousAssignee = task.assignee || null;
    task.status = status;
    // Clear the assignee on column entry ONLY when the destination column is
    // going to reassign it (a run_agent/assign_agent action, or a non-first/last
    // autoAssignRole — see getReassigningStatuses). Otherwise keep it so the
    // record of which agent took the task survives the move. Clearing
    // unconditionally was invisible while the assignee equalled the task owner
    // (e.g. a batch's member #1) but, for any other member, wiped the worker so
    // the board showed nobody had picked the task up.
    const clearAssignee = !!previousAssignee && (this._reassigningStatuses?.has(status) ?? false);
    if (clearAssignee) task.assignee = null;
    // Clear pending on enter signal
    clearTaskSignal(taskId, 'pendingOnEnter');
    delete task._pendingOnEnter;
    // Clear chain resume state so a new on_enter chain starts fresh.
    // Without this, a stale completedActionIdx from a previous chain
    // (e.g. refine) could cause the new chain (e.g. code) to skip actions.
    task.completedActionIdx = null;
    // A column move starts a fresh chain — drop the decide no-decision counter
    // so a later re-entry into a decide column isn't penalised by stale attempts.
    this._decideNoDecisionCounts?.delete(taskId);
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
    task.history.push({
      from: prevStatus,
      status,
      at: now,
      by: by || 'user',
      ...(clearAssignee ? { assignee: null, previousAssignee } : {}),
    });
    // Stamp updatedAt so the frontend can detect stale loadTasks() responses.
    // The DB sets its own updated_at = NOW() inside saveTaskToDb, but a SELECT
    // on a parallel pool connection may run before that UPDATE commits and
    // return a stale row. By including this client-side timestamp in the
    // task:updated payload, the frontend can compare and reject stale data.
    task.updatedAt = now;
    // Persist under the task's OWN owner (task.agentId is authoritative) — never
    // reassign ownership to the caller's agentId, which for delegated executions
    // (rate-limit handler, cross-agent assignee) is the executor, not the owner.
    // Persist first, then emit: the debounced agent:updated (300ms) triggers a
    // loadTasks() re-fetch, so emitting after the write commits guarantees that
    // fetch — and the task:updated payload — reflect the persisted row.
    const ownerId = task.agentId ?? null;
    await saveTaskToDb(task).catch(() => {});
    const ownerAgent = ownerId ? this.agents.get(ownerId) : agent;
    if (ownerAgent) this._emit('agent:updated', this._sanitize(ownerAgent));
    // Emit task:updated so the TasksBoard UI updates in real-time
    // (agent:updated alone is not enough — the board listens on task:updated).
    const taskPayload = { ...task, agentId: ownerId };
    if (task.assignee) {
      const assigneeAgent = this.agents.get(task.assignee);
      taskPayload.assigneeName = assigneeAgent?.name || null;
      taskPayload.assigneeIcon = assigneeAgent?.icon || null;
    } else {
      taskPayload.assigneeName = null;
      taskPayload.assigneeIcon = null;
    }
    this._emit('task:updated', { agentId: ownerId, task: taskPayload });
    if (!skipAutoRefine && status !== 'error' && !task.isManual) this._checkAutoRefine({ ...task, agentId: ownerId }, { by: by || 'user' });
    return task;
  },

  /** Shared field-edit helper for the simple updateTaskX methods: capture the
   * old value, assign the new one, push an {type:'edit', field, …} history
   * entry, persist, and emit agent:updated. `applyExtra` runs after the field
   * assignment (e.g. to set a paired provider default). Returns the task, or
   * null when the agent or task is missing. */
  async _editTaskField(
    this: any,
    agentId: string,
    taskId: string,
    field: string,
    value: any,
    { by = 'user', applyExtra }: { by?: string; applyExtra?: (task: any) => void } = {},
  ): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldValue = task[field] || null;
    task[field] = value;
    applyExtra?.(task);
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by, type: 'edit', field, oldValue, newValue: value ?? null });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskTitle(this: any, agentId: string, taskId: string, title: string): any {
    return this._editTaskField(agentId, taskId, 'title', title);
  },

  updateTaskText(this: any, agentId: string, taskId: string, text: string): any {
    return this._editTaskField(agentId, taskId, 'text', text);
  },

  updateTaskRepo(this: any, agentId: string, taskId: string, repoFullName: string | null, repoProvider: string | null = null): any {
    return this._editTaskField(agentId, taskId, 'repoFullName', repoFullName || null, {
      applyExtra: (task: any) => {
        task.repoProvider = repoFullName ? (repoProvider || task.repoProvider || 'github') : null;
        // Keep the invariant: a repo can't be both primary and secondary.
        if (repoFullName && Array.isArray(task.secondaryRepos)) {
          task.secondaryRepos = task.secondaryRepos.filter((r: any) => r?.fullName !== repoFullName);
        }
      },
    });
  },

  async updateTaskSecondaryRepos(this: any, agentId: string, taskId: string, secondaryRepos: any): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldValue = task.secondaryRepos || [];
    const newValue = normalizeSecondaryRepos(secondaryRepos, task.repoFullName);
    task.secondaryRepos = newValue;
    if (!task.history) task.history = [];
    task.history.push({ status: task.status, at: new Date().toISOString(), by: 'user', type: 'edit', field: 'secondaryRepos', oldValue, newValue });
    await saveTaskToDb({ ...task, agentId });
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  updateTaskStorage(this: any, agentId: string, taskId: string, storagePath: string | null, storageProvider: string | null = null): any {
    return this._editTaskField(agentId, taskId, 'storagePath', storagePath || null, {
      applyExtra: (task: any) => { task.storageProvider = storagePath ? (storageProvider || task.storageProvider || 'onedrive') : null; },
    });
  },

  updateTaskType(this: any, agentId: string, taskId: string, taskType: string, by: string = 'user'): any {
    return this._editTaskField(agentId, taskId, 'taskType', taskType || null, { by });
  },

  async updateTaskRecurrence(this: any, agentId: string, taskId: string, recurrence: any): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
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
    await saveTaskToDb({ ...task, agentId });
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

    // Priority 1: Task actively running via this agent (DB flag action_running_agent_id).
    // We INTENTIONALLY do not require _isActiveTaskStatus here — if the flag is
    // still pointing at this agent, the action is in flight and the link is valid
    // even if the status briefly transitioned (e.g. to "error" via a rate-limit
    // handler or to "done" via @update_task).
    const running = await getTaskByActionRunningAgent(agentId);
    if (running) {
      console.log(`🔗 [Commit] Found task via actionRunningAgentId: "${(running as any).text?.slice(0, 50)}" (status=${(running as any).status})`);
      return { task: running, ownerAgentId: (running as any).agentId };
    }

    // Priorities 2-4 operate on the tasks this agent executes: those assigned to
    // it (from any owner) plus its own unassigned tasks. getTasksByAssignee is
    // exactly that set (assignee = agentId OR (assignee IS NULL AND owner)).
    const assignedTasks = await getTasksByAssignee(agentId);

    // Priority 2/3: Active assigned/own task, preferring the most recently started.
    let bestActive: any = null;
    for (const task of assignedTasks) {
      if (!this._isActiveTaskStatus(task.status)) continue;
      if (!bestActive || (task.startedAt && (!bestActive.startedAt || new Date(task.startedAt) > new Date(bestActive.startedAt)))) {
        bestActive = task;
      }
    }
    if (bestActive) {
      console.log(`🔗 [Commit] Found task via assignee/own active: "${bestActive.text?.slice(0, 50)}" (owner=${(bestActive.agentId || '').slice(0, 8)})`);
      return { task: bestActive, ownerAgentId: bestActive.agentId };
    }

    // Priority 4: Recently active task (any status) within RECENT_ACTIVE_MS.
    // Catches the case where a task transitioned to error/done between the
    // commit being made and the run_command handler processing the result.
    let bestRecent: { task: any; ts: number } | null = null;
    for (const task of assignedTasks) {
      const ref = task.completedAt || task.startedAt;
      if (!ref) continue;
      const ts = new Date(ref).getTime();
      if (now - ts > RECENT_ACTIVE_MS) continue;
      if (!bestRecent || ts > bestRecent.ts) {
        bestRecent = { task, ts };
      }
    }
    if (bestRecent) {
      console.log(`🔗 [Commit] Found recently-active task: "${bestRecent.task.text?.slice(0, 50)}" (status=${bestRecent.task.status}, age=${Math.round((now - bestRecent.ts) / 1000)}s)`);
      return { task: bestRecent.task, ownerAgentId: bestRecent.task.agentId };
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

  async addTaskCommit(this: any, agentId: string, taskId: string, hash: string, message: string): Promise<any> {
    const task: any = await getTaskById(taskId);
    if (!task) return null;
    const ownerAgentId: string = task.agentId;
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
        await saveTaskToDb({ ...task, agentId: ownerAgentId });
      }
      return task;
    }
    task.commits.push({ hash, message: message || '', date: new Date().toISOString() });
    await saveTaskToDb({ ...task, agentId: ownerAgentId });
    const agent = ownerAgentId ? this.agents.get(ownerAgentId) : null;
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async removeTaskCommit(this: any, agentId: string, taskId: string, hash: string): Promise<any> {
    const task: any = await getTaskById(taskId);
    if (!task) return null;
    const ownerAgentId: string = task.agentId;
    if (!task.commits) return null;
    const before = task.commits.length;
    task.commits = task.commits.filter((c: any) => c.hash !== hash);
    if (task.commits.length === before) return null;
    await saveTaskToDb({ ...task, agentId: ownerAgentId });
    const agent = ownerAgentId ? this.agents.get(ownerAgentId) : null;
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  async setTaskAssignee(this: any, agentId: string, taskId: string, assigneeId: string): Promise<any> {
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

  async deleteTask(this: any, agentId: string | null, taskId: string): Promise<boolean> {
    // The DB row is the single source of truth; soft-delete goes straight to it
    // (works uniformly for owned and unassigned/board-level tasks).
    const dbDeleted = await deleteTaskFromDb(taskId);
    if (!dbDeleted) return false;
    clearTaskSignals(taskId);
    this._decideNoDecisionCounts?.delete(taskId);
    const agent = agentId ? this.agents.get(agentId) : null;
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
    const agent = restored.agentId ? this.agents.get(restored.agentId) : null;
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
    deleteTasksByAgent(agentId);
    this._emit('agent:updated', this._sanitize(agent));
    return true;
  },

  async transferTask(this: any, fromAgentId: string, taskId: string, toAgentId: string): Promise<any> {
    const fromAgent = this.agents.get(fromAgentId);
    const toAgent = this.agents.get(toAgentId);
    if (!fromAgent || !toAgent) return null;
    const taskToTransfer = await getTaskById(taskId);
    if (!taskToTransfer) return null;
    const prevStatus = taskToTransfer.status;
    await deleteTaskFromDb(taskId);
    this._emit('agent:updated', this._sanitize(fromAgent));
    const newTask = await this.addTask(toAgentId, taskToTransfer.text, { type: 'transfer', name: fromAgent.name, id: fromAgent.id }, prevStatus, { boardId: taskToTransfer.boardId, repoFullName: taskToTransfer.repoFullName, repoProvider: taskToTransfer.repoProvider, storagePath: taskToTransfer.storagePath, storageProvider: taskToTransfer.storageProvider });
    if (newTask) {
      newTask.assignee = toAgentId;
      await saveTaskToDb({ ...newTask, agentId: toAgentId });
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

    // Notify frontend so the yellow "Stopped" state clears (executionStatus was
    // just cleared in the DB above; reflect it on the fetched task for the emit).
    task.executionStatus = null;
    this._emit('task:updated', { agentId, task: { ...task, agentId } });

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
    this._reassigningStatuses = new Set();
    this._refreshWorkflowManagedStatuses();
    this._taskLoopInterval = setInterval(() => this._processNextPendingTasks(), intervalMs);
    this._recurrenceInterval = setInterval(() => this._processRecurringTasks(), 60000);
    this._workflowRefreshInterval = setInterval(() => this._refreshWorkflowManagedStatuses(), 30000);
    console.log(`🔄 Task loop started (every ${intervalMs / 1000}s)`);
  },

  _refreshWorkflowManagedStatuses(this: any): void {
    getAllBoardWorkflows().then((boardWorkflows: any) => {
      const next = getWorkflowManagedStatuses(boardWorkflows);
      this._workflowManagedStatuses = next;
      // Statuses whose entry will reassign the task — drives whether
      // setTaskStatus clears the assignee on a column move (see setTaskStatus).
      this._reassigningStatuses = getReassigningStatuses(boardWorkflows);
      // Log only when the managed-status set actually changes — this runs every
      // 30s, and re-printing the (long, static) list each time drowned the logs.
      const nextKey = [...next].sort().join(',');
      if (nextKey !== this._workflowManagedStatusesKey) {
        this._workflowManagedStatusesKey = nextKey;
        if (next.size > 0) {
          console.log(`🔄 [TaskLoop] Workflow-managed statuses (${next.size}): ${[...next].join(', ')}`);
        }
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
    const ownEnv = getCurrentEnvironment();
    const recurringTasks = await getRecurringTasks();
    for (const t of recurringTasks) {
      const task: any = t;
      // Environment isolation: only the matching replica resets the task.
      // NULL env is treated as "prod" to preserve legacy behavior.
      const taskEnv = task.environment || 'prod';
      if (taskEnv !== ownEnv) continue;
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
      const previousAssignee = task.assignee || null;
      if (previousAssignee) task.assignee = null;
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
      task.history.push({
        from: prevStatus,
        status: resetStatus,
        at: nowIso,
        by: 'recurrence',
        ...(previousAssignee ? { assignee: null, previousAssignee } : {}),
      });
      task.recurrence = { ...rec, lastResetAt: nowIso };

      // Drop ephemeral execution signals from the previous cycle so the
      // freshly-reset task isn't blocked by stale "stopped"/"watching" flags.
      clearTaskSignals(task.id);

      await saveTaskToDb(task);
      const agent = task.agentId ? this.agents.get(task.agentId) : null;
      if (agent) this._emit('agent:updated', this._sanitize(agent));
      this._emit('task:updated', { agentId: task.agentId, task: { ...task } });
    }
  },

  _processNextPendingTasks(this: any): void {
    // One-shot startup cleanup of stale action_running flags. Deferred until
    // here so the instance's environment is known (locked by the first HTTP
    // request, or set via APP_ENVIRONMENT) and we don't clear a sibling
    // replica's locks when several deployments share the database.
    if (!this._staleActionCleanupDone) {
      this._staleActionCleanupDone = true;
      const env = getCurrentEnvironment();
      // Re-arm interrupted chains BEFORE clearing stale action_running — the
      // re-arm relies on that flag to detect a crash mid-run. It persists a
      // durable pending_on_enter, so after the clear the task becomes visible to
      // getActiveWorkflowTasks and recheckPendingTransitions resumes it.
      reArmInterruptedChains(this, env)
        .catch((err: any) => console.error('[TaskLoop] chain re-arm failed:', err.message))
        .finally(() => {
          clearAllStaleActionRunning(env)
            .then((cleared: number) => {
              if (cleared > 0) console.log(`🔄 Cleared ${cleared} stale action_running flags for env="${env}"`);
            })
            .catch((err: any) => console.error('[TaskLoop] stale action cleanup failed:', err.message));
        });
    }

    this._recheckConditionalTransitions();

    // Periodically purge stale task signals to prevent unbounded Map growth.
    // The task set now lives in the DB, so fetch live ids — but only roughly
    // once a minute (every ~12th 5s tick) to avoid a full-table scan each tick.
    this._signalPurgeTick = ((this._signalPurgeTick || 0) + 1) % 12;
    if (this._signalPurgeTick === 1) {
      getAllTaskIds()
        .then((ids: string[]) => purgeStaleTaskSignals(new Set(ids)))
        .catch(() => {});
    }

    // Use DB query to find tasks that need resume — filtered to our environment
    // so a sibling replica sharing the DB doesn't steal each other's tasks.
    getTasksForResume(getCurrentEnvironment()).then(async (dbTasks: any[]) => {
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

  /**
   * Probe the runner's shared-PTY session for a latched CLI auth failure.
   * Returns the auth-error message (e.g. "Please run /login") or null. Used by
   * the terminal-driven execution path so an expired/rejected token fails the
   * task instead of looking like a silently-finished run.
   */
  async _checkTerminalAuthError(this: any, executorId: string): Promise<string | null> {
    if (!this.executionManager?.getTerminalSession) return null;
    try {
      const status = await this.executionManager.getTerminalSession(executorId);
      const err = status?.auth_error;
      return (typeof err === 'string' && err.trim()) ? err.trim() : null;
    } catch {
      return null;
    }
  },

  /** Read-and-clear the auth error stashed on a task by _waitForExecutionComplete.
   *  Exposed as a manager method so workflow/actionExecutor can consume it
   *  without importing this module (avoids a circular import). */
  _consumeTaskAuthError(this: any, taskId: string): string | null {
    const err = getTaskSignal(taskId, 'authError');
    if (err) clearTaskSignal(taskId, 'authError');
    return (typeof err === 'string' && err.trim()) ? err.trim() : null;
  },

  /** Drop the in-memory 'stopped' interrupt signal for a task. Called when a
   *  fresh run_agent execution begins (executeRunAgent), AFTER the durable
   *  executionStatus='stopped' gate has already been cleared/passed. Without
   *  this, a stale signal from a PRIOR lifecycle — e.g. the user pressed Stop
   *  and then moved the task to a new column (PUT /tasks/:id re-sets the signal
   *  to interrupt the now-gone old run) — survives into the new column's
   *  on_enter execution and trips _waitForExecutionComplete's early-stop check,
   *  aborting the run before the agent does anything. A genuine Stop DURING the
   *  new run sets the signal again, after this point, and is still honored.
   *  Exposed as a manager method to avoid a circular import (see above). */
  _clearStopSignal(this: any, taskId: string): void {
    clearTaskSignal(taskId, 'stopped');
  },

  async _waitForExecutionComplete(this: any, creatorAgentId: string, taskId: string, executorId: string, executorName: string, taskText: string, options: any = {}): Promise<string> {
    const terminalDriven = Boolean(options.terminalDriven);
    const freshTask = await getTaskById(taskId);
    // The column this wait started on. A workflow transition is finished as soon
    // as the agent moves the task OFF this column — even to another ACTIVE column
    // (e.g. a decide moving testclaudepaid → testopencode). The checks below
    // otherwise only catch a move to an INACTIVE status, so an active→active move
    // was invisible and the transition blocked until the 15-min stale-lock
    // eviction — holding the per-task processing lock + agent busy flag and
    // starving the next column / every other assignment ("no idle agent").
    const startStatus: string | undefined = freshTask?.status;
    const movedAway = (s: any): boolean =>
      typeof s === 'string' && startStatus !== undefined && s !== startStatus;
    console.log(`🔍 [Execution] _waitForExecutionComplete: task=${taskId} creator=${creatorAgentId} executor=${executorName} completionSignal=${Boolean(getTaskSignal(taskId, 'completed'))} status=${freshTask?.status}`);

    // Helper: check if task was completed via update_task's signal.
    const _checkCompleted = async (): Promise<string | null> => {
      if (getTaskSignal(taskId, 'completed')) {
        const comment = getTaskSignal(taskId, 'comment') || '';
        clearTaskSignal(taskId, 'completed');
        clearTaskSignal(taskId, 'comment');
        console.log(`✅ [Execution] update_task completed "${taskText.slice(0, 60)}"${comment ? ` (${comment.slice(0, 80)})` : ''}`);
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

    const immediateResult = await _checkCompleted();
    if (immediateResult) return immediateResult;
    if (freshTask && !this._isActiveTaskStatus(freshTask.status)) {
      console.log(`[Execution] Task ${taskId} "${taskText.slice(0, 60)}" already moved to "${freshTask.status}" — accepting`);
      return 'moved';
    }

    // Mark task as watching so the task loop doesn't re-send
    setTaskSignal(taskId, 'watching', true);
    updateTaskExecutionStatus(taskId, 'watching');

    // ── Terminal-driven auth/error probe ──────────────────────────────────
    // CLI runners (claudecode, …) execute inside a shared PTY. An auth failure
    // (expired token, "Please run /login", invalid key) renders to the
    // terminal and then the CLI goes quiet — which otherwise looks identical
    // to a finished task, so the workflow would advance as if it succeeded.
    // Poll the runner's session status for the latched auth_error; it surfaces
    // within the first seconds after injection.
    if (terminalDriven) {
      const AUTH_PROBE_ATTEMPTS = 8;
      const AUTH_PROBE_INTERVAL_MS = 3000;
      for (let i = 0; i < AUTH_PROBE_ATTEMPTS; i++) {
        await new Promise(resolve => setTimeout(resolve, AUTH_PROBE_INTERVAL_MS));
        const probeCompleted = await _checkCompleted();
        if (probeCompleted) return probeCompleted;
        if (getTaskSignal(taskId, 'stopped')) { clearTaskSignal(taskId, 'stopped'); return 'stopped'; }
        const probeTask = await getTaskById(taskId);
        if (!probeTask) return 'deleted';
        if (!this._isActiveTaskStatus((probeTask as any).status) || movedAway((probeTask as any).status)) return 'moved';
        const authErr = await this._checkTerminalAuthError(executorId);
        if (authErr) {
          setTaskSignal(taskId, 'authError', authErr);
          console.warn(`🔐 [Execution] CLI auth failure for "${executorName}" on task ${taskId} "${taskText.slice(0, 60)}": ${authErr}`);
          return 'error';
        }
      }
    }

    // ── Immediate retry: if the agent went idle without producing any output
    // (empty response from coder-service, e.g. session corruption), re-send
    // the task immediately instead of waiting for the slow reminder loop.
    // Check if executor is already idle (not busy from another concurrent task).
    const immediateExecutor = this.agents.get(executorId);
    if (!terminalDriven && immediateExecutor && immediateExecutor.status === 'idle' && !getTaskSignal(taskId, 'stopped')) {
      // Brief delay to let any in-flight state settle (e.g. socket events)
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Re-check signals after the short wait
      const earlyCompleted = await _checkCompleted();
      if (earlyCompleted) return earlyCompleted;
      const earlyTask = await getTaskById(taskId);
      if (!earlyTask || !this._isActiveTaskStatus((earlyTask as any).status) || movedAway((earlyTask as any).status)) {
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
            `[SYSTEM] You went idle without completing your task. Continue working on it now:\n"${taskText.slice(0, 500)}"\n\nUse your tools to complete the task. When done, call @update_task(taskId, <final column>, summary) to move it to its final column and finish it.`,
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
      if (!this._isActiveTaskStatus((currentTask as any).status) || movedAway((currentTask as any).status)) {
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

      // Late CLI auth failure (token expired mid-run, re-auth needed). Surface
      // it the same way as the early probe so the task is failed, not left to
      // exhaust the reminder loop and time out as if "done".
      if (terminalDriven) {
        const loopAuthErr = await this._checkTerminalAuthError(executorId);
        if (loopAuthErr) {
          setTaskSignal(taskId, 'authError', loopAuthErr);
          console.warn(`🔐 [Execution] CLI auth failure (mid-run) for "${executorName}" on task ${taskId}: ${loopAuthErr}`);
          return 'error';
        }
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

        const reminderPrompt = `[SYSTEM REMINDER] You have an active task that is not yet complete:\n"${taskText.slice(0, 300)}"\n\nPlease finish your work on this task. When you are done, you MUST call @update_task(taskId, <final column>, summary of what was done) — moving it to its final column with a summary signals completion.\n\nIf you have already finished all the work, call @update_task now to move the task to its final column with a summary of what was accomplished.`;

        if (terminalDriven && isCliRunner(currentExecutor) && this.executionManager?.sendTerminalInput) {
          await bindAgentRunner(this, currentExecutor);
          await this.executionManager.sendTerminalInput(executorId, reminderPrompt, { submit: true });
        } else {
          await this.sendMessage(
            executorId,
            reminderPrompt,
            (chunk: any) => {
              this._emit('agent:stream:chunk', { agentId: executorId, chunk });
              this._emit('agent:thinking', { agentId: executorId, thinking: currentExecutor.currentThinking || '' });
            }
          );
        }

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
      // Always clear the watching flag so the task loop can resume if needed.
      clearTaskSignal(taskId, 'watching');
      // Don't clobber an executionStatus that was set to 'stopped' by stopAgent
      // (or by the catch in _resumeActiveTask) — leaving it as 'stopped' is
      // what keeps the next task-loop tick from picking the task up again.
      // Only clear to NULL when the task is in some other transient state.
      const finalTask = await getTaskById(taskId);
      if (finalTask?.executionStatus !== 'stopped') {
        updateTaskExecutionStatus(taskId, null);
      }
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
      // Secondary repos are cloned alongside the primary. Hand the keep-set to
      // the execution layer first so every subsequent ensure (even primary-only
      // ones) preserves them; then re-ensure when the primary changed OR there
      // are secondaries to (re)clone.
      const taskRepo = task.repoFullName || null;
      const secondaryRepos = normalizeSecondaryRepos(task.secondaryRepos, taskRepo);
      this.executionManager?.setSecondaryRepos?.(executorId, secondaryRepos);
      const needsPrimarySwitch = !!taskRepo && taskRepo !== executor.project;
      const needsSecondaryEnsure = secondaryRepos.length > 0;
      if (taskRepo && (needsPrimarySwitch || needsSecondaryEnsure)) {
        if (needsPrimarySwitch) {
          console.log(`🔄 [TaskLoop] Switching "${executor.name}" from "${executor.project || '(none)'}" to repo "${taskRepo}" for resume`);
          if (this._switchProjectContext) {
            this._switchProjectContext(executor, executor.project, taskRepo);
          }
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
        ? `[SYSTEM REMINDER] You have an active task that needs to be completed:\n"${task.text.slice(0, 300)}"\n\nContinue where you left off. When you are done, call @update_task(taskId, <final column>, summary of what was done) to move it to its final column and finish it.`
        : task.text;

      // CLI runners always resume through their interactive PTY (not headless
      // sendMessage), regardless of the transient agent.status — the runner
      // gates the inject on the TUI being input-ready (PTY-is-free).
      const terminalDriven = isCliRunner(executor) && this.executionManager?.sendTerminalInput;
      if (terminalDriven) {
        await bindAgentRunner(this, executor);
        await this.executionManager.sendTerminalInput(executorId, messageToSend, { submit: true });
      } else {
        await this.sendMessage(executorId, messageToSend, streamCallback);
      }

      // CLI runners like opencode, openclaw, hermes, and codex manage their own
      // internal tool pipeline and exit when their work is done. For those
      // runners, process exit is enough to satisfy the task wait; otherwise the
      // loop would treat the idle runner as unfinished and keep reminding it.
      if (!terminalDriven && executor.runner && SELF_COMPLETING_RUNNERS.has(executor.runner)) {
        if (!getTaskSignal(task.id, 'completed') && !getTaskSignal(task.id, 'stopped')) {
          console.log(`✅ [TaskLoop] CLI runner "${executor.runner}" finished — auto-signaling task completion`);
          setTaskSignal(task.id, 'completed', true);
        }
      }

      // _saveExecutionLog moved after _waitForExecutionComplete — captures full conversation

      const waitResult = await this._waitForExecutionComplete(agentId, task.id, executorId, executor.name, task.text, {
        terminalDriven,
      });

      // A detected CLI auth failure (or other hard error) must fail the task
      // rather than silently complete. Throw so the catch below runs the
      // standard error path (markTaskError + error report + execution log).
      if (waitResult === 'error') {
        const authError = this._consumeTaskAuthError(task.id);
        throw new Error(authError || 'CLI execution ended in error');
      }

      // Save execution log AFTER wait completes — captures the full conversation
      // including retries, reminders, and tool calls.
      this._saveExecutionLog(agentId, task.id, executorId, startMsgIdx, executionStartedAt, waitResult !== "error" && waitResult !== "timeout");
    } catch (err: any) {
      const isUserStop = isUserStopError(err);
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
        const stoppedTask = await getTaskById(task.id);
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
        // Real error — keep task in its originating column via errorFromStatus.
        // markTaskError guards against the disappearance bug (errorFromStatus
        // clobbered to 'error' when the task was already errored, or set to a
        // status that no longer exists in the workflow).
        const errorTask = await getTaskById(task.id);
        if (errorTask) {
          // Load the workflow so markTaskError can validate the fallback column.
          // Best-effort: if it fails the helper still works (just no validation).
          let wf: any = null;
          if (errorTask.boardId) {
            try { wf = await getWorkflowForBoard(errorTask.boardId); } catch { /* ignore */ }
          }
          const mutated = markTaskError(errorTask, err.message, {
            by: executor.name,
            agentName: executor.name,
            workflow: wf,
          });
          if (mutated) {
            await saveTaskToDb({ ...errorTask, agentId });
            this._emit('task:updated', { agentId, task: { ...errorTask, agentId } });
          }
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

  /** Find a task by ID (from the DB — the single source of truth). Returns the
   * task (with its `agentId` owner, null for board-level tasks) or null. */
  async getTask(this: any, taskId: string): Promise<any> {
    return getTaskById(taskId);
  },

  /** Save a task to the database (returns a promise for awaitable saves) */
  saveTaskDirectly(this: any, task: any): any {
    if (!task || !task.id) return;
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
