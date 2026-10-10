import { waitForProjectSwitch } from './crud.js';
import { isAgentBusy, isTaskRunning, reserveAgentForTask } from '../workflow/agentSelector.js';
import {
  claimRun,
  releaseRun as releaseRunClaim,
  refreshClaimedAgents,
} from '../workflow/runClaims.js';
// ─── Tasks: CRUD, execution, task loop, queue, wait, resume ──────────────────
import { v4 as uuidv4 } from 'uuid';
import { enterRunProfileForTask } from '../security/externalRunProfile.js';
import {
  APPROVAL_REQUIRED_MESSAGE,
  needsApproval,
  taskContentForPrompt,
  type SecurityFlag,
  type TaskTrustLevel,
} from '../../lib/taskTrust.js';
import {
  saveAgent,
  saveTaskToDb,
  deleteTaskFromDb,
  deleteTasksByAgent,
  hardDeleteTaskFromDb,
  restoreTaskFromDb,
  getDeletedTasks,
  getTasksForResume,
  updateTaskExecutionStatus,
  getTaskById,
  getTasksByAgent,
  getAllTaskIds,
  getRecurringTasks,
  countUnfinishedOccurrences,
  purgeTemplateOccurrences,
  updateTaskFields,
  getBoardById,
  clearAllStaleActionRunning,
  mutateTaskCommits,
  transferTaskOwner,
} from '../database.js';
import {
  buildRecurrenceConfig,
  nextRunAt,
  normalizeRetention,
  normalizeKeepLast,
  normalizeOverlap,
} from '../taskRecurrence.js';
import { getWorkflowForBoard, getAllBoardWorkflows, getReminderConfig } from '../configManager.js';
import {
  isActiveStatus,
  getWorkflowManagedStatuses,
  getReassigningStatuses,
  isUserStopError,
  reArmInterruptedChains,
} from '../workflow/index.js';
import {
  clearTaskErrorForRun,
  enrichAssignee,
  emitTaskUpdated,
  isAssigneeOffBoard,
  persistTaskError,
  ASSIGNEE_BOARD_MISMATCH_ERROR,
} from '../taskMutations.js';
import {
  reconcileTaskCommits,
  getTaskCommitRun,
  startTaskCommitRun,
  finishTaskCommitRun,
} from './tools/gitReconcile.js';
import { normalizeSecondaryRepos } from '../taskRepos.js';
import { ensureAgentWorkspace, resolveAgentGitCredentials } from '../execution/agentWorkspace.js';
import { copyTaskAttachments } from '../database/taskAttachments.js';
import { deliverTaskAttachments } from '../execution/taskAttachmentDelivery.js';
import { errorMessage } from '../../lib/errors.js';
import type { Task, TaskWriteInput, TaskRecurrence } from '../database/tasks.js';
import type { RecurrenceInput, RecurrenceTask } from '../taskRecurrence.js';
import { getCurrentEnvironment, isEnvironmentLocked } from '../../lib/environment.js';
import { isCliRunner, SELF_COMPLETING_RUNNERS } from '../runners.js';
import {
  watchCliActivity,
  isCliRecentlyActive,
  isCliStalled,
  noteCliActivity,
  noteCliPromptInjected,
} from './cliActivity.js';
import { checkBoardAccess } from '../../middleware/authz.js';
import { checkAgentAccess, type AgentAccessSubject } from '../../lib/agentAccess.js';
import type { SessionClaims } from '../../middleware/session.js';

/** Task access is independent of the caller-selected execution agent. Resolve
 * current edit permission before logging task content or changing any state. */
async function requireTaskExecutionAccess(
  agents: Map<string, AgentAccessSubject>,
  task: Task,
  user: SessionClaims
): Promise<void> {
  if (!user?.userId) throw new Error('Access denied');
  if (task.boardId) {
    const access = await checkBoardAccess(task.boardId, user.userId, user.role, 'edit');
    if (!access.ok) throw new Error('Access denied');
    return;
  }
  // Legacy board-less tasks are scoped to their actual owning agent, never
  // to the agentId supplied by the client. Orphaned tasks are admin-only.
  if (user.role === 'admin') return;
  const owner = task.agentId ? agents.get(task.agentId) : undefined;
  if (!(await checkAgentAccess(owner, user, 'edit')).ok) throw new Error('Access denied');
}

async function bindAgentRunner(manager: any, agent: any): Promise<void> {
  if (!manager.executionManager?.bindAgent || !agent?.id) return;
  const llmConfig = manager.resolveLlmConfig?.(agent) || {};
  const providerType = agent.runner || (llmConfig.managesContext ? 'claudecode' : 'sandbox');
  const gitCreds = await resolveAgentGitCredentials(agent);
  manager.executionManager.bindAgent(agent.id, providerType, {
    ownerId: agent.ownerId || null,
    gitCredentials: gitCreds,
    permissions: agent.permissions || null,
    llmConfig: agent.llmConfigId ? llmConfig : null,
  });
}

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Cadence at which the reminder loop re-checks the task verdict while it waits
// out a reminder interval (signals are in-memory; the DB read is one row).
const VERDICT_POLL_SLICE_MS = envInt('VERDICT_POLL_SLICE_MS', 3000);

/** The per-board status sets kept by _refreshWorkflowManagedStatuses. */
interface StatusSetsHolder {
  _workflowManagedByBoard?: Map<string, Set<string>>;
  _workflowManagedStatuses?: Set<string>;
  _reassigningByBoard?: Map<string, Set<string>>;
  _reassigningStatuses?: Set<string>;
}

// A CLI whose PTY printed nothing for this long is waiting at its prompt.
const CLI_QUIET_SECONDS = envInt('CLI_QUIET_SECONDS', 6);
// How long a finished terminal run may hold its agent while the CLI wraps up.
const CLI_DRAIN_MAX_MS = envInt('CLI_DRAIN_MAX_MS', 10 * 60_000);
// After a Stop: re-interrupt a CLI still printing after this, give up after that.
const CLI_DRAIN_REINTERRUPT_MS = 20_000;
const CLI_DRAIN_STOP_MAX_MS = 60_000;
const CLI_DRAIN_POLL_MS = envInt('CLI_DRAIN_POLL_MS', 2_000);
// Interval between the terminal auth-error probes right after a CLI prompt.
const CLI_AUTH_PROBE_INTERVAL_MS = envInt('CLI_AUTH_PROBE_INTERVAL_MS', 3_000);
// Terminal-independent commit sweep cadence while a CLI run is watched.
const COMMIT_SWEEP_INTERVAL_MS = envInt('COMMIT_SWEEP_INTERVAL_MS', 60_000);

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

// Tasks whose execution wait accepts an agent's completion signal right now.
// recordTaskCompletion only raises 'completed' for these: a completion recorded
// while nothing waits (a manager's update_task, an agent's follow-up comment
// after its run ended) used to stay latched and end the NEXT run of the task the
// moment its prompt was pasted — freeing the agent while its CLI worked on.
const _awaitingCompletion = new Set<string>();

export function setAwaitingCompletion(taskId: string, waiting: boolean): void {
  if (waiting) _awaitingCompletion.add(taskId);
  else _awaitingCompletion.delete(taskId);
}

export function isAwaitingCompletion(taskId: string): boolean {
  return _awaitingCompletion.has(taskId);
}

/** Drop the run-scoped signals of a previous lifecycle (Stop, completion). */
export function clearRunSignals(taskId: string): void {
  clearTaskSignal(taskId, 'stopped');
  clearTaskSignal(taskId, 'completed');
  clearTaskSignal(taskId, 'comment');
}

/** Purge signals for task IDs that no longer exist in the active task set */
export function purgeStaleTaskSignals(activeTaskIds: Set<string>): void {
  for (const taskId of _taskSignals.keys()) {
    if (!activeTaskIds.has(taskId)) {
      _taskSignals.delete(taskId);
    }
  }
}

/** A run without the rule's files is better than no run: log and go on. */
async function copyAttachmentsBestEffort(fromTaskId: string, toTaskId: string) {
  try {
    await copyTaskAttachments(fromTaskId, toTaskId);
  } catch (err) {
    console.warn(
      `🔁 [Recurrence] Could not copy attachments ${fromTaskId} → ${toTaskId}: ${errorMessage(err)}`
    );
  }
}

/**
 * The fields a recurring rule and its runs share — everything that describes
 * WHAT to do (text, board, repo, storage, owner), never the state of one
 * attempt (status, assignee, history, commits, timestamps, execution flags).
 *
 * One list, used in both directions: card → rule when recurrence is switched
 * on, rule → run at every due date. `dueDate` is deliberately absent: a fixed
 * deadline copied onto every run would be wrong the moment the second one
 * starts.
 */
function pickTemplateFields(task: RecurrenceTask) {
  return {
    agentId: task.agentId || null,
    text: task.text || '',
    title: task.title || undefined,
    boardId: task.boardId || null,
    repoProvider: task.repoProvider || null,
    repoFullName: task.repoFullName || null,
    secondaryRepos: Array.isArray(task.secondaryRepos) ? task.secondaryRepos : [],
    storageProvider: task.storageProvider || null,
    storagePath: task.storagePath || null,
    taskType: task.taskType || null,
    priority: task.priority || undefined,
    source: task.source || null,
    isManual: task.isManual || false,
    environment: task.environment || getCurrentEnvironment(),
  };
}

/** @this {import('./index.js').AgentManager} */
export const tasksMethods = {
  async addTask(
    this: any,
    agentId: string | null,
    text: string,
    source: any,
    initialStatus?: string,
    {
      boardId,
      repoFullName,
      repoProvider,
      secondaryRepos,
      storagePath,
      storageProvider,
      skipAutoRefine = false,
      recurrence,
      taskType,
      isManual,
      environment,
      trustLevel,
      securityFlags,
    }: {
      boardId?: string;
      repoFullName?: string | null;
      repoProvider?: string | null;
      secondaryRepos?: any;
      storagePath?: string | null;
      storageProvider?: string | null;
      skipAutoRefine?: boolean;
      recurrence?: any;
      taskType?: string;
      isManual?: boolean;
      environment?: string | null;
      /** lib/taskTrust.ts — set by the external insert paths only. */
      trustLevel?: TaskTrustLevel | null;
      securityFlags?: SecurityFlag[];
    } = {}
  ): Promise<any> {
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
      repoProvider: repoFullName ? repoProvider || 'github' : null,
      // Secondary repos cloned alongside the primary; normalized (deduped,
      // primary-excluded, capped) so the stored shape is always clean.
      secondaryRepos: normalizeSecondaryRepos(secondaryRepos, repoFullName || null),
      storagePath: storagePath || null,
      storageProvider: storagePath ? storageProvider || 'onedrive' : null,
      source: source || null,
      boardId: boardId || null,
      isManual: isManual || false,
      // Fall back to the instance's locked environment when the caller (e.g.
      // recurring task reset, jira sync, MCP-triggered task) has no request
      // hostname to derive one from. Ensures the workflow engine of the same
      // replica still picks the task up.
      environment: environment || getCurrentEnvironment(),
      position: Date.now(),
      trustLevel: trustLevel || null,
      securityFlags: Array.isArray(securityFlags) ? securityFlags : [],
      createdAt: now,
      history: [{ status, at: now, by: source?.name || source?.type || 'user' }],
    };
    if (taskType) newTask.taskType = taskType;
    if (recurrence && recurrence.enabled) {
      // Recurring ⇒ this row is the RULE, not a card: it holds the schedule,
      // stays off the board and is never executed. The work the user described
      // happens in the runs it spawns, starting with one right now so enabling
      // recurrence has a visible effect instead of a wait of up to one period.
      newTask.recurrence = buildRecurrenceConfig(recurrence, { defaultStatus: status });
      newTask.isTemplate = true;
    }
    // Persist first; the DB row is the single source of truth (no in-memory store).
    // Awaiting the write guarantees downstream readers (_checkAutoRefine → workflow
    // processing, and the frontend's loadTasks() after agent:updated) observe the
    // committed row rather than racing a fire-and-forget save.
    await saveTaskToDb({ ...newTask, agentId }).catch(() => {});
    if (newTask.isTemplate) {
      // No task:updated for the rule — there is no card to render — and no
      // auto-refine: a rule never enters a workflow column. Both happen for the
      // run instead, inside _spawnOccurrence.
      const firstRun = await this._spawnOccurrence(
        { ...newTask, agentId },
        { by: source?.name || source?.type || 'user', skipAutoRefine }
      );
      if (agent) this._emit('agent:updated', this._sanitize(agent));
      return firstRun || newTask;
    }
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    // Emit task:updated after the DB write has committed so the frontend
    // can add the new task to its list in real-time (the handler must support
    // inserting tasks it hasn't seen before, not just patching existing ones).
    const taskPayload = { ...newTask, agentId };
    this._emit('task:updated', { agentId, task: taskPayload });
    // Column entry fires for a board-level task (agentId null) too:
    // processColumnEntry takes the owner from the board's workflow, exactly as
    // for a recurring run (_spawnOccurrence). The MCP/insert creators that must
    // stay inert on creation opt out with skipAutoRefine.
    if (!skipAutoRefine && !newTask.isManual) this._checkAutoRefine({ ...newTask, agentId });
    return newTask;
  },

  async toggleTask(this: any, agentId: string, taskId: string): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const prevStatus = task.status;
    const previousAssignee = task.assignee || null;
    const status = prevStatus === 'done' ? 'backlog' : 'done';
    const now = new Date().toISOString();
    const updated = await updateTaskFields(taskId, {
      status,
      ...(previousAssignee ? { assignee: null } : {}),
      ...(status === 'done' ? { completedAt: now } : {}),
      historyAppend: [
        {
          from: prevStatus,
          status,
          at: now,
          by: 'user',
          ...(previousAssignee ? { assignee: null, previousAssignee } : {}),
        },
      ],
    });
    this._emit('agent:updated', this._sanitize(agent));
    return updated || task;
  },

  async setTaskStatus(
    this: any,
    agentId: string,
    taskId: string,
    status: string,
    { skipAutoRefine = false, by = null }: { skipAutoRefine?: boolean; by?: string | null } = {}
  ): Promise<any> {
    // The task is addressed by id; `agentId` only names who asked. A task whose
    // owner agent was deleted must still be movable — refusing it stranded the
    // workflow's change_status action in an endless 'guard-blocked' retry.
    const agent = agentId ? this.agents.get(agentId) : null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const prevStatus = task.status;
    if (prevStatus === status) return task;
    const previousAssignee = task.assignee || null;
    // Clear the assignee on column entry ONLY when the destination column is
    // going to reassign it (a run_agent/assign_agent action, or a non-first/last
    // autoAssignRole — see getReassigningStatuses). Otherwise keep it so the
    // record of which agent took the task survives the move. Clearing
    // unconditionally was invisible while the assignee equalled the task owner
    // (e.g. a batch's member #1) but, for any other member, wiped the worker so
    // the board showed nobody had picked the task up.
    const clearAssignee =
      !!previousAssignee && this._isReassigningStatus(task.boardId || null, status);
    // Clear pending on enter signal
    clearTaskSignal(taskId, 'pendingOnEnter');
    // A completion recorded for the previous column must not end the next
    // column's run (see setAwaitingCompletion).
    clearTaskSignal(taskId, 'completed');
    clearTaskSignal(taskId, 'comment');
    // A column move starts a fresh chain — drop the decide no-decision counter
    // so a later re-entry into a decide column isn't penalised by stale attempts.
    this._decideNoDecisionCounts?.delete(taskId);
    const now = new Date().toISOString();
    // A TARGETED write of exactly what a move changes. The full-row save it
    // replaces wrote a snapshot read before the move, reverting whatever another
    // writer committed meanwhile (a linked commit, an assignment, a comment).
    const fields: Record<string, unknown> = {
      status,
      // Chain resume state belongs to the previous column: the new column's
      // on_enter chain starts fresh (a stale completedActionIdx would skip actions).
      pendingOnEnter: null,
      completedActionIdx: null,
      resumeTransitionIdx: null,
      // Execution state of the previous column: without this, a stale startedAt
      // makes the task loop resume a task that was moved (e.g. done → nextsprint).
      // The run claim itself is released by the run, never by a move.
      startedAt: null,
      executionStatus: null,
    };
    if (clearAssignee) fields.assignee = null;
    if (status === 'done') fields.completedAt = now;
    if (status === 'error') fields.errorFromStatus = prevStatus;
    if (prevStatus === 'error' && status !== 'error') {
      fields.errorFromStatus = null;
      fields.error = null;
    }
    fields.historyAppend = [
      {
        from: prevStatus,
        status,
        at: now,
        by: by || 'user',
        ...(clearAssignee ? { assignee: null, previousAssignee } : {}),
      },
    ];
    // Persist under the task's OWN owner (task.agentId is authoritative) — never
    // reassign ownership to the caller's agentId, which for delegated executions
    // (rate-limit handler, cross-agent assignee) is the executor, not the owner.
    // Persist first, then emit: the debounced agent:updated (300ms) triggers a
    // loadTasks() re-fetch, so emitting after the write commits guarantees that
    // fetch — and the task:updated payload — reflect the persisted row.
    const ownerId = task.agentId ?? null;
    const updated = await updateTaskFields(taskId, fields);
    if (!updated) return null;
    // Stamp updatedAt so the frontend can detect stale loadTasks() responses.
    updated.updatedAt = now;
    const ownerAgent = ownerId ? this.agents.get(ownerId) : agent;
    if (ownerAgent) this._emit('agent:updated', this._sanitize(ownerAgent));
    // Emit task:updated so the TasksBoard UI updates in real-time
    // (agent:updated alone is not enough — the board listens on task:updated).
    const taskPayload = enrichAssignee(this, { ...updated, agentId: ownerId });
    this._emit('task:updated', { agentId: ownerId, task: taskPayload });
    if (!skipAutoRefine && status !== 'error' && !updated.isManual)
      this._checkAutoRefine({ ...updated, agentId: ownerId }, { by: by || 'user' });
    return updated;
  },

  /** Shared field-edit helper for the simple updateTaskX methods: capture the
   * old value, assign the new one, push an {type:'edit', field, …} history
   * entry, persist, and emit agent:updated. `applyExtra` runs after the field
   * assignment (e.g. to set a paired provider default). Returns the task, or
   * null when the agent or task is missing. */
  async _editTaskField<K extends keyof Task>(
    this: any,
    agentId: string,
    taskId: string,
    field: K,
    value: Task[K],
    { by = 'user', applyExtra }: { by?: string; applyExtra?: (task: Task) => void } = {}
  ): Promise<Task | null> {
    // A board-level task (agentId null) has no owner to check; an id naming an
    // agent that does not exist is still refused (agent-scoped routes).
    const agent = agentId ? this.agents.get(agentId) : null;
    if (agentId && !agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const before: Record<string, unknown> = { ...task };
    const oldValue = task[field] || null;
    task[field] = value;
    applyExtra?.(task);
    // Write ONLY what this edit changed (+ an atomic history append): a full-row
    // save of the snapshot read above reverted concurrent writes — and, from a
    // run_agent action, resurrected the run claim the action had just released.
    const fields: Record<string, unknown> = { [field]: value ?? null };
    for (const [key, next] of Object.entries(task)) {
      if (key !== 'history' && JSON.stringify(next) !== JSON.stringify(before[key])) {
        fields[key] = next ?? null;
      }
    }
    fields.historyAppend = [
      {
        status: task.status,
        at: new Date().toISOString(),
        by,
        type: 'edit',
        field,
        oldValue,
        newValue: value ?? null,
      },
    ];
    const updated = await updateTaskFields(taskId, fields);
    if (!updated) return null;
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    emitTaskUpdated(this, { ...updated }, { emitAgent: false });
    return updated;
  },

  updateTaskTitle(this: any, agentId: string, taskId: string, title: string): any {
    return this._editTaskField(agentId, taskId, 'title', title);
  },

  updateTaskText(this: any, agentId: string, taskId: string, text: string): any {
    return this._editTaskField(agentId, taskId, 'text', text);
  },

  updateTaskRepo(
    this: any,
    agentId: string,
    taskId: string,
    repoFullName: string | null,
    repoProvider: string | null = null
  ): any {
    return this._editTaskField(agentId, taskId, 'repoFullName', repoFullName || null, {
      applyExtra: (task: Task) => {
        task.repoProvider = repoFullName ? repoProvider || task.repoProvider || 'github' : null;
        // Keep the invariant: a repo can't be both primary and secondary.
        if (repoFullName && Array.isArray(task.secondaryRepos)) {
          task.secondaryRepos = task.secondaryRepos.filter(r => r?.fullName !== repoFullName);
        }
      },
    });
  },

  async updateTaskSecondaryRepos(
    this: any,
    agentId: string,
    taskId: string,
    secondaryRepos: any
  ): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    const oldValue = task.secondaryRepos || [];
    const newValue = normalizeSecondaryRepos(secondaryRepos, task.repoFullName);
    const updated = await updateTaskFields(taskId, {
      secondaryRepos: newValue,
      historyAppend: [
        {
          status: task.status,
          at: new Date().toISOString(),
          by: 'user',
          type: 'edit',
          field: 'secondaryRepos',
          oldValue,
          newValue,
        },
      ],
    });
    this._emit('agent:updated', this._sanitize(agent));
    return updated || task;
  },

  updateTaskStorage(
    this: any,
    agentId: string,
    taskId: string,
    storagePath: string | null,
    storageProvider: string | null = null
  ): any {
    return this._editTaskField(agentId, taskId, 'storagePath', storagePath || null, {
      applyExtra: (task: Task) => {
        task.storageProvider = storagePath
          ? storageProvider || task.storageProvider || 'onedrive'
          : null;
      },
    });
  },

  updateTaskType(
    this: any,
    agentId: string,
    taskId: string,
    taskType: string,
    by: string = 'user'
  ): any {
    return this._editTaskField(agentId, taskId, 'taskType', taskType || null, { by });
  },

  /**
   * Turn recurrence on or off for a task, working on the caller's task object.
   *
   * Only a rule ever carries a `recurrence` config — a card never does — so the
   * three cases are distinct:
   *   • the row IS a rule → patch its schedule in place (the panel's editor);
   *   • enabling on a card → mint a rule from it and adopt the card as run #1,
   *     so the card the user is looking at stays exactly where it is;
   *   • disabling on a card → delete the rule that spawned it. The runs, this
   *     one included, are finished work and stay.
   *
   * The passed task is mutated (and its linkage persisted) rather than re-read,
   * so a caller that saves it afterwards — PUT /tasks/:id does — writes the new
   * `templateId` instead of clobbering it with a stale null.
   */
  async setTaskRecurrence(
    this: any,
    task: RecurrenceTask,
    recurrence: RecurrenceInput | null
  ): Promise<TaskWriteInput | null> {
    if (!task) return null;

    if (task.isTemplate) {
      if (recurrence && recurrence.enabled) {
        task.recurrence = buildRecurrenceConfig(recurrence, { prev: task.recurrence });
        await saveTaskToDb(task);
        return task;
      }
      // Disabling a rule removes it; its runs are untouched.
      await deleteTaskFromDb(task.id, null);
      return null;
    }

    if (recurrence && recurrence.enabled) {
      // A run edits the rule it belongs to — editing the schedule from the card
      // is the same act as editing it in the panel, and must not mint a second
      // rule. Only a card with no live rule behind it creates one.
      const existing = task.templateId ? await getTaskById(task.templateId) : null;
      if (existing?.isTemplate) {
        existing.recurrence = buildRecurrenceConfig(recurrence, { prev: existing.recurrence });
        await saveTaskToDb(existing);
        return existing;
      }
      return this._createTemplateFromTask(task, recurrence);
    }

    if (task.templateId) {
      await deleteTaskFromDb(task.templateId, null);
    }
    return null;
  },

  /** Agent-scoped wrapper — the websocket/agent route's entry point. */
  async updateTaskRecurrence(
    this: any,
    agentId: string,
    taskId: string,
    recurrence: any
  ): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    await this.setTaskRecurrence(task, recurrence);
    this._emit('agent:updated', this._sanitize(agent));
    return task;
  },

  /**
   * Mint a rule out of an existing card, and adopt that card as its first run.
   *
   * The rule is a copy, not a move: the card keeps its id, its column, its
   * history and whatever an agent is doing with it right now. It only gains the
   * back-link (`templateId`, run #1), which is what lets the UI show "run 1 of a
   * recurring rule" and the scheduler count it as in-flight for the overlap
   * check. `lastResetAt` starts now, so the second run is one full period away
   * rather than immediate.
   */
  async _createTemplateFromTask(
    this: any,
    task: RecurrenceTask,
    recurrence: RecurrenceInput | null
  ): Promise<TaskWriteInput | null> {
    const now = new Date().toISOString();
    const template: TaskWriteInput = {
      ...pickTemplateFields(task),
      id: uuidv4(),
      isTemplate: true,
      status: recurrence?.originalStatus || task.status || 'backlog',
      assignee: null,
      position: Date.now(),
      createdAt: now,
      commits: [],
      history: [{ status: 'template', at: now, by: 'user', from: task.id }],
      recurrence: buildRecurrenceConfig(recurrence, {
        defaultStatus: task.status || 'backlog',
      }),
    };
    const config = template.recurrence as TaskRecurrence;
    config.occurrenceCount = task.occurrenceSeq || 1;
    config.lastOccurrenceId = task.id;
    await saveTaskToDb(template);
    await copyAttachmentsBestEffort(task.id, template.id);

    // Adopt the card. updateTaskFields writes only these columns, so nothing
    // the agent is doing to the row in parallel is overwritten.
    await updateTaskFields(task.id, {
      templateId: template.id,
      occurrenceSeq: task.occurrenceSeq || 1,
    });
    task.templateId = template.id;
    task.occurrenceSeq = task.occurrenceSeq || 1;
    this._emit('task:updated', { agentId: task.agentId, task: { ...task } });
    console.log(
      `🔁 [Recurrence] Rule created from task ${task.id} ` +
        `(every ${config.intervalMinutes}min, starts in "${config.originalStatus}")`
    );
    return template;
  },

  /**
   * Spawn one run of a rule: a brand-new task, with an empty history, that
   * flows through the workflow like any other and is deleted by the retention
   * sweep once it is old enough. This is what replaced resetting a single row
   * forever.
   *
   * The rule's counters are advanced in the same call (`lastResetAt`,
   * `occurrenceCount`, `lastOccurrenceId`) so a crash between the two writes
   * costs at most a duplicate run, never a lost schedule.
   */
  async _spawnOccurrence(
    this: any,
    template: TaskWriteInput,
    {
      by = 'recurrence',
      advanceClock = true,
      skipAutoRefine = false,
    }: { by?: string; advanceClock?: boolean; skipAutoRefine?: boolean } = {}
  ): Promise<TaskWriteInput | null> {
    const rec: TaskRecurrence = template.recurrence || {};
    const nowIso = new Date().toISOString();
    const seq = (typeof rec.occurrenceCount === 'number' ? rec.occurrenceCount : 0) + 1;
    const status = (rec.originalStatus as string) || 'backlog';
    const occurrence: TaskWriteInput = {
      ...pickTemplateFields(template),
      id: uuidv4(),
      isTemplate: false,
      templateId: template.id,
      occurrenceSeq: seq,
      status,
      assignee: null,
      recurrence: null,
      commits: [],
      history: [{ status, at: nowIso, by, occurrence: seq }],
      position: Date.now(),
      createdAt: nowIso,
    };
    await saveTaskToDb(occurrence);
    await copyAttachmentsBestEffort(template.id, occurrence.id);

    template.recurrence = {
      ...rec,
      occurrenceCount: seq,
      lastOccurrenceId: occurrence.id,
      ...(advanceClock ? { lastResetAt: nowIso } : {}),
    };
    await saveTaskToDb(template);

    console.log(
      `🔁 [Recurrence] Run #${seq} of "${(template.text || '').slice(0, 60)}" ` +
        `spawned in "${status}" (task ${occurrence.id})`
    );

    const agent = occurrence.agentId ? this.agents.get(occurrence.agentId) : null;
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    this._emit('task:updated', { agentId: occurrence.agentId, task: { ...occurrence } });
    // A run entering its first column is an ordinary column entry — the same
    // signal addTask sends — so the workflow's on_enter actions fire for it.
    // processColumnEntry handles a board-level run (agentId null) too: it takes
    // the owner from the board's workflow and auto-assigns by column role.
    if (!skipAutoRefine && !occurrence.isManual) this._checkAutoRefine({ ...occurrence }, { by });
    return occurrence;
  },

  _isActiveTaskStatus(this: any, status: string): boolean {
    return isActiveStatus(status);
  },

  /** Resolve the first column ID of a board's workflow (used as default status) */
  async _getFirstColumnStatus(this: any, boardId: string): Promise<string> {
    try {
      const workflow = await getWorkflowForBoard(boardId);
      if (workflow?.columns && workflow.columns.length > 0) {
        return workflow.columns[0].id;
      }
    } catch {
      /* fall through */
    }
    return 'backlog';
  },

  async addTaskCommit(
    this: any,
    _agentId: string,
    taskId: string,
    hash: string,
    message: string,
    meta: { pushed?: boolean; repo?: string | null } = {}
  ): Promise<any> {
    // Read-modify-write under a row lock (mutateTaskCommits): concurrent linkers
    // — the mid-run sweep, update_task, the end-of-run reconcile — each used to
    // save the whole row from its own snapshot, so one link could erase another.
    let added = false;
    const result = await mutateTaskCommits(taskId, commits => {
      // Prefix-aware dedup: treat short and full hashes of the same commit as equal.
      // If a full hash is provided and a short hash already exists, upgrade it.
      const existing = commits.find(
        (c: any) => c.hash === hash || c.hash.startsWith(hash) || hash.startsWith(c.hash)
      );
      if (existing) {
        let mutated = false;
        // Upgrade: if the new hash is longer (full), replace the short one
        if (hash.length > existing.hash.length) {
          existing.hash = hash;
          if (message && !existing.message) existing.message = message;
          mutated = true;
        }
        // Refresh the pushed flag on re-link (a mid-run sweep links the commit as
        // unpushed; the end-of-run reconcile upgrades it once the CLI pushed it).
        if (meta.pushed !== undefined && existing.pushed !== meta.pushed) {
          existing.pushed = meta.pushed;
          mutated = true;
        }
        // A secondary-repo commit first linked by hash alone (update_task's
        // explicit list) learns its repo here — the diff view needs it.
        if (meta.repo && !existing.repo) {
          existing.repo = meta.repo;
          mutated = true;
        }
        return mutated ? commits : null;
      }
      added = true;
      commits.push({
        hash,
        message: message || '',
        date: new Date().toISOString(),
        ...(meta.pushed !== undefined ? { pushed: meta.pushed } : {}),
        ...(meta.repo ? { repo: meta.repo } : {}),
      });
      return commits;
    });
    if (!result) return null;
    const { task, changed } = result;
    if (!changed) return task;
    const ownerAgentId: string | null = task.agentId ?? null;
    if (added) {
      const agent = ownerAgentId ? this.agents.get(ownerAgentId) : null;
      if (agent) this._emit('agent:updated', this._sanitize(agent));
    }
    // Also emit the task itself so the kanban card shows the commit live —
    // commits linked by the terminal-independent reconcile have no other
    // event to piggyback on (no run_command result, no status move).
    emitTaskUpdated(
      this,
      { ...task, agentId: ownerAgentId },
      { emitAgent: false, stampUpdatedAt: true }
    );
    return task;
  },

  async removeTaskCommit(this: any, _agentId: string, taskId: string, hash: string): Promise<any> {
    const result = await mutateTaskCommits(taskId, commits => {
      const kept = commits.filter((c: any) => c.hash !== hash);
      return kept.length === commits.length ? null : kept;
    });
    if (!result || !result.changed) return null;
    const ownerAgentId: string | null = result.task.agentId ?? null;
    const agent = ownerAgentId ? this.agents.get(ownerAgentId) : null;
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return result.task;
  },

  async setTaskAssignee(
    this: any,
    agentId: string,
    taskId: string,
    assigneeId: string
  ): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;
    const task = await getTaskById(taskId);
    if (!task) return null;
    // Defense in depth behind the route check: never persist a cross-board assignee.
    if (assigneeId && isAssigneeOffBoard(this.agents.get(assigneeId), task.boardId)) {
      throw new Error(ASSIGNEE_BOARD_MISMATCH_ERROR);
    }
    const updated = await updateTaskFields(taskId, {
      assignee: assigneeId,
      historyAppend: [
        {
          status: task.status,
          at: new Date().toISOString(),
          by: 'user',
          type: 'reassign',
          assignee: assigneeId,
        },
      ],
    });
    this._emit('agent:updated', this._sanitize(agent));
    this._recheckConditionalTransitions();
    return updated || task;
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
    const updated =
      (await updateTaskFields(taskId, {
        historyAppend: [
          { status: restored.status, at: new Date().toISOString(), by: 'user', type: 'restored' },
        ],
      })) || restored;
    const agent = updated.agentId ? this.agents.get(updated.agentId) : null;
    if (agent) this._emit('agent:updated', this._sanitize(agent));
    return updated;
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

  async transferTask(
    this: any,
    fromAgentId: string,
    taskId: string,
    toAgentId: string
  ): Promise<any> {
    const fromAgent = this.agents.get(fromAgentId);
    const toAgent = this.agents.get(toAgentId);
    if (!fromAgent || !toAgent) return null;
    const taskToTransfer = await getTaskById(taskId);
    if (!taskToTransfer) return null;
    if (isAssigneeOffBoard(toAgent, taskToTransfer.boardId)) {
      throw new Error(ASSIGNEE_BOARD_MISMATCH_ERROR);
    }
    // A task being worked on is not handed over under the running agent's feet:
    // its commits would be linked to a task nobody runs anymore.
    if (isTaskRunning(taskId) || taskToTransfer.actionRunning) {
      throw new Error('Task is being executed — stop it before transferring it');
    }
    // In place: the task keeps its id, commits, history, comments, attachments and
    // provenance (re-creating the row dropped all of them).
    const moved = await transferTaskOwner(taskId, toAgentId, {
      status: taskToTransfer.status,
      at: new Date().toISOString(),
      by: fromAgent.name,
      type: 'transfer',
      from: fromAgentId,
      to: toAgentId,
    });
    if (!moved) return null;
    this._emit('agent:updated', this._sanitize(fromAgent));
    this._emit('agent:updated', this._sanitize(toAgent));
    emitTaskUpdated(this, { ...moved }, { emitAgent: false });
    this._checkAutoRefine({ ...moved, agentId: toAgentId });
    return moved;
  },

  async executeTask(
    this: any,
    agentId: string,
    taskId: string,
    _streamCallback: any,
    user: SessionClaims,
    options: { status?: string; executorId?: string } = {}
  ): Promise<any> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (!user?.userId || !(await checkAgentAccess(agent, user, 'edit')).ok) {
      throw new Error('Access denied');
    }
    const task = await getTaskById(taskId);
    if (!task) throw new Error('Task not found');
    await requireTaskExecutionAccess(this.agents, task, user);
    if (task.isTemplate) throw new Error('Use run_task_template to execute a recurring rule');
    if (task.status === 'done') throw new Error('Task already completed');
    // An explicit start is not an approval: approving is its own, audited act
    // (POST /api/tasks/:id/approve), so a click on "run" cannot skip reading
    // what an outsider wrote.
    if (needsApproval(task)) throw new Error(APPROVAL_REQUIRED_MESSAGE);
    // Stacks sharing the database each run their own environment's tasks; the
    // other stack's engine would run this one concurrently (and its runners hold
    // the task's working copy).
    const taskEnv = task.environment || 'prod';
    if (taskEnv !== getCurrentEnvironment()) {
      throw new Error(`Task belongs to the "${taskEnv}" environment — run it from there`);
    }
    if (task.actionRunning) {
      throw new Error('Task is already being executed — stop it first');
    }

    // Check before clearing Stop/watching signals: a rejected resume must not
    // disturb the workflow already owning this task or executor.
    await refreshClaimedAgents();
    const requestedExecutorId = options.executorId || task.assignee || agentId;
    const requestedExecutor = this.agents.get(requestedExecutorId);
    if (!requestedExecutor || !(await checkAgentAccess(requestedExecutor, user, 'edit')).ok) {
      throw new Error('Access denied to executor');
    }
    // Access and board scope are distinct questions: being allowed to edit an
    // agent does not let it run another board's task with its own repo/secrets.
    if (isAssigneeOffBoard(requestedExecutor, task.boardId)) {
      throw new Error(ASSIGNEE_BOARD_MISMATCH_ERROR);
    }
    if (requestedExecutor.enabled === false) throw new Error('Executor is disabled');
    if (isTaskRunning(task.id) || isAgentBusy(requestedExecutorId)) {
      throw new Error('Agent or task is already processing another execution');
    }
    // The run would decline a CLI still printing (_resumeActiveTask's pre-flight)
    // AFTER this request was accepted — and the explicit start leaves no retry
    // marker behind. Refuse it now, before touching the task.
    if (
      isCliRunner(requestedExecutor) &&
      this.executionManager?.sendTerminalInput &&
      !(await this._isCliQuiet(requestedExecutorId))
    ) {
      throw new Error(
        `Agent "${requestedExecutor.name}"'s terminal is still active — retry once it is idle`
      );
    }

    let explicitReservation: (() => void) | null = null;
    try {
      if (options.status !== undefined) {
        const board = task.boardId ? await getBoardById(task.boardId) : null;
        if (
          !board?.workflow?.columns?.some((c: { id: string }) => c.id === options.status) ||
          !this._isActiveTaskStatus(options.status)
        ) {
          throw new Error('Execution requires an active workflow column');
        }
        if (requestedExecutor.status !== 'idle') throw new Error('Executor is busy');
        explicitReservation = reserveAgentForTask(
          requestedExecutorId,
          task.id,
          `${task.agentId}:${task.id}:explicit`
        );
        if (!explicitReservation)
          throw new Error('Agent or task is already processing another execution');
        // Prepare the explicit run without firing on_enter as a second execution.
        const updated = await updateTaskFields(task.id, {
          status: options.status,
          assignee: requestedExecutorId,
          error: null,
          errorFromStatus: null,
          pendingOnEnter: null,
          completedActionIdx: null,
          resumeTransitionIdx: null,
          historyAppend: [
            {
              at: new Date().toISOString(),
              by: user.username || user.userId,
              type: 'execution_requested',
              from: task.status,
              status: options.status,
            },
          ],
        });
        if (!updated) throw new Error('Failed to prepare task execution');
        Object.assign(task, updated);
      }

      console.log(
        `[Workflow] Triggering execution for "${task.text.slice(0, 80)}" (status=${task.status})`
      );

      clearTaskSignal(taskId, 'stopped');
      clearTaskSignal(taskId, 'watching');
      await updateTaskExecutionStatus(taskId, null);

      // Reset the failure circuit breaker so a manual resume always gets a fresh attempt
      this._taskResumeFailures?.delete(taskId);

      // Notify frontend so the yellow "Stopped" state clears (executionStatus was
      // just cleared in the DB above; reflect it on the fetched task for the emit).
      task.executionStatus = null;
      this._emit('task:updated', { agentId: task.agentId, task });

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
        const release = explicitReservation;
        this._resumeActiveTask(
          options.status !== undefined ? task.agentId : agentId,
          executor,
          task,
          release || undefined
        )
          .catch((err: any) =>
            console.error(
              `[Resume] _resumeActiveTask failed for "${task.text?.slice(0, 60)}":`,
              err.message
            )
          )
          .finally(() => {
            this._loopProcessing.delete(executorId);
            release?.();
          });
        explicitReservation = null;
      } else {
        this._checkAutoRefine({ ...task, agentId }, { by: 'task-loop' });
      }

      return { taskId, response: null };
    } finally {
      explicitReservation?.();
    }
  },

  async executeAllTasks(
    this: any,
    agentId: string,
    streamCallback: any,
    user: SessionClaims
  ): Promise<any[]> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error('Agent not found');
    if (!user?.userId || !(await checkAgentAccess(agent, user, 'edit')).ok) {
      throw new Error('Access denied');
    }
    const tasks = await getTasksByAgent(agentId);
    const executable = tasks.filter(
      (t: any) => t.status !== 'done' && !this._isActiveTaskStatus(t.status)
    );
    if (executable.length === 0) throw new Error('No executable tasks');

    // Preflight the entire batch before emitting task IDs or running any task.
    for (const task of executable) {
      await requireTaskExecutionAccess(this.agents, task, user);
    }

    console.log(`▶️  Executing ${executable.length} task(s) for ${agent.name}`);
    this._emit('agent:task:executeAll:start', { agentId, count: executable.length });

    const results: any[] = [];
    for (const task of executable) {
      try {
        const result = await this.executeTask(agentId, task.id, streamCallback, user);
        results.push({
          taskId: task.id,
          text: task.text,
          success: true,
          response: result.response,
        });
      } catch (err: any) {
        results.push({ taskId: task.id, text: task.text, success: false, error: err.message });
      }
    }

    this._emit('agent:task:executeAll:complete', {
      agentId,
      results: results.map(r => ({ taskId: r.taskId, success: r.success })),
    });
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
    this._workflowRefreshInterval = setInterval(
      () => this._refreshWorkflowManagedStatuses(),
      30000
    );
    console.log(`🔄 Task loop started (every ${intervalMs / 1000}s)`);
  },

  _refreshWorkflowManagedStatuses(this: any): void {
    getAllBoardWorkflows()
      .then(boardWorkflows => {
        const next = getWorkflowManagedStatuses(boardWorkflows);
        this._workflowManagedStatuses = next;
        // Statuses whose entry will reassign the task — drives whether
        // setTaskStatus clears the assignee on a column move (see setTaskStatus).
        this._reassigningStatuses = getReassigningStatuses(boardWorkflows);
        // Column ids are unique only WITHIN a board ('review', 'todo' exist on
        // many): a column that runs actions on board B says nothing about the
        // same-named column of board A. Keep a set per board; the global sets
        // above only serve tasks with no board.
        const managedByBoard = new Map<string, Set<string>>();
        const reassigningByBoard = new Map<string, Set<string>>();
        for (const bw of boardWorkflows) {
          managedByBoard.set(bw.boardId, getWorkflowManagedStatuses([bw]));
          reassigningByBoard.set(bw.boardId, getReassigningStatuses([bw]));
        }
        this._workflowManagedByBoard = managedByBoard;
        this._reassigningByBoard = reassigningByBoard;
        // Log only when the managed-status set actually changes — this runs every
        // 30s, and re-printing the (long, static) list each time drowned the logs.
        const nextKey = [...next].sort().join(',');
        if (nextKey !== this._workflowManagedStatusesKey) {
          this._workflowManagedStatusesKey = nextKey;
          if (next.size > 0) {
            console.log(
              `🔄 [TaskLoop] Workflow-managed statuses (${next.size}): ${[...next].join(', ')}`
            );
          }
        }
      })
      .catch(() => {});
  },

  /** Whether entering `status` on `boardId` runs actions the task loop must not
   *  duplicate (per board — see _refreshWorkflowManagedStatuses). */
  _isWorkflowManagedStatus(
    this: StatusSetsHolder,
    boardId: string | null,
    status: string
  ): boolean {
    const perBoard = this._workflowManagedByBoard;
    if (boardId && perBoard?.has(boardId)) return perBoard.get(boardId)!.has(status);
    return this._workflowManagedStatuses?.has(status) ?? false;
  },

  /** Whether entering `status` on `boardId` will (re)assign the task. */
  _isReassigningStatus(this: StatusSetsHolder, boardId: string | null, status: string): boolean {
    const perBoard = this._reassigningByBoard;
    if (boardId && perBoard?.has(boardId)) return perBoard.get(boardId)!.has(status);
    return this._reassigningStatuses?.has(status) ?? false;
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

  /**
   * Scheduler tick: spawn the runs that are due, then bin the old ones.
   *
   * Reads rules only (`getRecurringTasks` filters on `is_template`), so nothing
   * a user can see on a board is touched here — the reason this loop no longer
   * needs to be careful about stealing a task from the agent working it.
   */
  async _processRecurringTasks(this: any): Promise<void> {
    // Until the instance knows its environment, getCurrentEnvironment() answers
    // the 'prod' default: a QA replica would spawn prod's runs (see
    // _processNextPendingTasks).
    if (!isEnvironmentLocked()) return;
    const now = Date.now();
    const ownEnv = getCurrentEnvironment();
    const templates = await getRecurringTasks();
    for (const template of templates) {
      // Environment isolation: only the matching replica runs the rule.
      // NULL env is treated as "prod" to preserve legacy behavior.
      const templateEnv = template.environment || 'prod';
      if (templateEnv !== ownEnv) continue;
      const rec = template.recurrence;
      if (!rec) continue;

      // Retention first: it is independent of the schedule, so a rule whose
      // period is long still has its old runs collected on every tick.
      await this._purgeOccurrences(template);

      const dueAt = nextRunAt(rec, template.createdAt);
      if (dueAt === null || now < dueAt) continue;

      if (normalizeOverlap(rec.onOverlap) === 'skip') {
        const inFlight = await countUnfinishedOccurrences(template.id);
        if (inFlight > 0) {
          // Drop this cycle rather than queue it: the next run is measured from
          // now, so a slow workflow produces fewer runs instead of a backlog
          // that can never drain. The run in progress is left strictly alone.
          console.log(
            `🔁 [Recurrence] Skipping "${(template.text || '').slice(0, 60)}" — ` +
              `${inFlight} run(s) still in flight (overlap=skip)`
          );
          template.recurrence = { ...rec, lastResetAt: new Date(now).toISOString() };
          await saveTaskToDb(template);
          continue;
        }
      }

      await this._spawnOccurrence(template, { by: 'recurrence' });
    }
  },

  /**
   * Apply a rule's retention limits to its finished runs. Nothing happens
   * unless the rule sets at least one of them — a rule with no limit keeps
   * every run, which is a choice the user makes per rule.
   */
  async _purgeOccurrences(this: any, template: TaskWriteInput): Promise<number> {
    const rec: TaskRecurrence = template.recurrence || {};
    const retentionDays = normalizeRetention(rec.historyRetentionDays);
    const keepLast = normalizeKeepLast(rec.keepLastOccurrences);
    if (!retentionDays && !keepLast) return 0;
    const purged = await purgeTemplateOccurrences(template.id, { retentionDays, keepLast });
    if (purged > 0) {
      console.log(
        `🧹 [Recurrence] Deleted ${purged} old run(s) of "${(template.text || '').slice(0, 60)}" ` +
          `(retention: ${retentionDays ? retentionDays + 'd' : 'none'}, ` +
          `keepLast: ${keepLast ?? 'none'})`
      );
      // The board never showed these rows, but an open run list should stop
      // showing them too.
      const agent = template.agentId ? this.agents.get(template.agentId) : null;
      if (agent) this._emit('agent:updated', this._sanitize(agent));
    }
    return purged;
  },

  _processNextPendingTasks(this: any): void {
    // Nothing runs until the instance knows its environment. Before the lock
    // (APP_ENVIRONMENT unset and no public request seen yet) getCurrentEnvironment()
    // answers the 'prod' default, and a QA replica sharing the database used to
    // re-arm, clear and EXECUTE prod's tasks — on prod's agents, in QA's runners —
    // for every boot until someone opened the QA site.
    if (!isEnvironmentLocked()) {
      if (!this._envLockWarned) {
        this._envLockWarned = true;
        console.warn(
          '⚠️  [TaskLoop] Environment not known yet (APP_ENVIRONMENT unset): the workflow engine waits for the first public request to lock it. Set APP_ENVIRONMENT to run it from boot.'
        );
      }
      return;
    }
    // One-shot startup cleanup, now that the environment is known: re-arm the
    // chains a previous process left mid-way, then drop the markers that died
    // with it. Claims still heartbeating (the previous replica of a start-first
    // update is still running them) are left alone — the stale-claim healer
    // takes them over once their heartbeat stops.
    if (!this._staleActionCleanupDone) {
      this._staleActionCleanupDone = true;
      const env = getCurrentEnvironment();
      reArmInterruptedChains(this, env)
        .catch((err: any) => console.error('[TaskLoop] chain re-arm failed:', err.message))
        .finally(() => {
          clearAllStaleActionRunning(env)
            .then((cleared: number) => {
              if (cleared > 0)
                console.log(`🔄 Cleared ${cleared} stale execution markers for env="${env}"`);
            })
            .catch((err: any) =>
              console.error('[TaskLoop] stale action cleanup failed:', err.message)
            );
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
    getTasksForResume(getCurrentEnvironment())
      .then(async (dbTasks: any[]) => {
        if (dbTasks.length > 0) await refreshClaimedAgents();
        for (const dbTask of dbTasks) {
          const executorId = dbTask.assignee || dbTask.agentId;
          const executor = this.agents.get(executorId);
          if (!executor) continue;
          if (executor.status !== 'idle') continue;
          if (
            this._loopProcessing.has(executorId) ||
            isAgentBusy(executorId) ||
            isTaskRunning(dbTask.id)
          )
            continue;
          if (!this._isActiveTaskStatus(dbTask.status)) continue;

          if (this._isWorkflowManagedStatus(dbTask.boardId || null, dbTask.status)) continue;

          if (dbTask.executionStatus === 'stopped' || getTaskSignal(dbTask.id, 'stopped')) {
            continue;
          }
          if (dbTask.executionStatus === 'watching' || getTaskSignal(dbTask.id, 'watching'))
            continue;

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
          console.log(
            `🔄 [TaskLoop] Agent "${executor.name}" is idle but has started task "${dbTask.text.slice(0, 60)}" (${dbTask.status}) — resuming`
          );
          this._resumeActiveTask(dbTask.agentId, this.agents.get(dbTask.agentId), dbTask)
            .then(() => {
              // Successful resume — reset failure counter
              this._taskResumeFailures?.delete(dbTask.id);
            })
            .catch(() => {
              // Track consecutive failures for this task
              const prev = this._taskResumeFailures?.get(dbTask.id) || { count: 0 };
              const newCount = prev.count + 1;
              this._taskResumeFailures?.set(dbTask.id, {
                count: newCount,
                lastFailedAt: Date.now(),
              });
              if (newCount >= MAX_RESUME_FAILURES) {
                console.log(
                  `🔴 [TaskLoop] Circuit breaker: task "${dbTask.text.slice(0, 60)}" failed ${newCount} consecutive resumes — pausing for ${FAILURE_COOLDOWN_MS / 60000}min`
                );
              }
            })
            .finally(() => {
              this._loopProcessing.delete(executorId);
            });
        }
      })
      .catch((err: any) => {
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
      return typeof err === 'string' && err.trim() ? err.trim() : null;
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
    return typeof err === 'string' && err.trim() ? err.trim() : null;
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

  /** Drop every run-scoped signal (stopped, completed, comment) left by a prior
   *  lifecycle — called when a fresh run starts. See clearRunSignals. */
  _clearRunSignals(this: unknown, taskId: string): void {
    clearRunSignals(taskId);
  },

  /** Seconds since the executor's PTY last printed: Infinity when it has no
   *  session (nothing can be running), null when the runner cannot tell. */
  async _cliIdleSeconds(
    this: { executionManager?: { getTerminalSession?: (id: string) => Promise<unknown> } },
    executorId: string
  ): Promise<number | null> {
    if (!this.executionManager?.getTerminalSession) return Number.POSITIVE_INFINITY;
    let session: { alive?: boolean; idle_seconds?: unknown } | null;
    try {
      session = (await this.executionManager.getTerminalSession(executorId)) as typeof session;
    } catch {
      return null;
    }
    if (!session || session.alive === false) return Number.POSITIVE_INFINITY;
    const idle = session.idle_seconds;
    if (idle === null || idle === undefined) return Number.POSITIVE_INFINITY; // never printed
    return typeof idle === 'number' && Number.isFinite(idle) ? idle : null;
  },

  /**
   * Whether a CLI executor's terminal is quiet: its screen did not change for
   * CLI_QUIET_SECONDS. The CLI TUIs redraw continuously while they think or run
   * a tool (spinner, elapsed timer), so a still screen means the CLI waits at its
   * prompt. An unreachable runner counts as quiet — the paste would fail anyway.
   * So does a STALLED CLI (no model activity for CLI_STALL_MS, see
   * cliActivity.isCliStalled): a screen that keeps moving with nobody working
   * must not hold the agent — and the board's next task — forever.
   */
  async _isCliQuiet(
    this: { _cliIdleSeconds(id: string): Promise<number | null> },
    executorId: string
  ): Promise<boolean> {
    if (isCliStalled(executorId)) return true;
    const idle = await this._cliIdleSeconds(executorId);
    return idle === null || idle >= CLI_QUIET_SECONDS;
  },

  /**
   * Hold a terminal-driven run until the CLI is really done.
   *
   * The execution wait ends on a VERDICT — the agent moved the card, recorded
   * its completion, the user pressed Stop — which comes before the CLI finishes
   * its turn: it still writes its summary, pushes, sometimes commits again.
   * Releasing the agent at the verdict let the next task be pasted into a busy
   * TUI (two tasks at once), and closed the commit window early: the tail
   * commits were lost, or linked to the next task. So the run is released only
   * once the PTY has been quiet for CLI_QUIET_SECONDS. After a Stop the CLI is
   * re-interrupted if it keeps going; either way the wait is bounded.
   */
  async _drainCliRun(
    this: any,
    executorId: string,
    executorName: string,
    taskId: string,
    { stopped = false }: { stopped?: boolean } = {}
  ): Promise<void> {
    const started = Date.now();
    let interruptAt = stopped ? started + CLI_DRAIN_REINTERRUPT_MS : Number.POSITIVE_INFINITY;
    let deadline = started + (stopped ? CLI_DRAIN_STOP_MAX_MS : CLI_DRAIN_MAX_MS);
    let logged = false;
    for (;;) {
      if (await this._isCliQuiet(executorId)) {
        if (logged) {
          console.log(
            `🧘 [Execution] "${executorName}" is quiet after ${Math.round((Date.now() - started) / 1000)}s — releasing task ${taskId}`
          );
        }
        return;
      }
      const now = Date.now();
      // A Stop arriving while we drain switches to the (shorter) stop budget.
      if (!stopped && getTaskSignal(taskId, 'stopped')) {
        stopped = true;
        interruptAt = now;
        deadline = Math.min(deadline, now + CLI_DRAIN_STOP_MAX_MS);
      }
      if (now >= interruptAt) {
        interruptAt = Number.POSITIVE_INFINITY;
        const interrupt =
          this.executionManager?.interruptCliTerminalSessions ||
          this.executionManager?.interruptTerminalSession;
        if (interrupt) {
          Promise.resolve(interrupt.call(this.executionManager, executorId)).catch(() => {});
        }
      }
      if (now >= deadline) {
        console.warn(
          `⚠️ [Execution] "${executorName}" still active ${Math.round((now - started) / 1000)}s after task ${taskId} ended — releasing it anyway; nothing new is injected until its terminal is quiet`
        );
        return;
      }
      if (!logged) {
        logged = true;
        console.log(
          `⏳ [Execution] "${executorName}" is still working after the verdict on task ${taskId} — waiting for its terminal to go quiet`
        );
      }
      await new Promise(resolve => setTimeout(resolve, CLI_DRAIN_POLL_MS));
    }
  },

  /**
   * The ONE canonical "is this wait finished?" check, used at every poll site in
   * the execution wait. Returns the verdict in a FIXED priority order —
   * completed > stopped > deleted > moved — or null when the task is still
   * active on its start column. Consuming the 'completed'/'stopped' signals here
   * (read-and-clear) keeps the clearing behavior identical everywhere, which is
   * what the four hand-ordered copies used to get subtly wrong ("task stuck" /
   * "resumed twice"). `startStatus` is the column the wait began on, so an
   * active→active move (off that column) still counts as 'moved'.
   */
  async _pollTaskVerdict(
    this: any,
    taskId: string,
    taskText: string,
    startStatus: string | undefined,
    // Only a wait registered with setAwaitingCompletion (a resume run) ends on
    // the agent's completion signal; workflow actions end on the status move.
    { acceptCompletion = isAwaitingCompletion(taskId) }: { acceptCompletion?: boolean } = {}
  ): Promise<'completed' | 'stopped' | 'moved' | 'deleted' | null> {
    if (getTaskSignal(taskId, 'completed')) {
      const comment = getTaskSignal(taskId, 'comment') || '';
      clearTaskSignal(taskId, 'completed');
      clearTaskSignal(taskId, 'comment');
      if (acceptCompletion) {
        console.log(
          `✅ [Execution] update_task completed "${taskText.slice(0, 60)}"${comment ? ` (${comment.slice(0, 80)})` : ''}`
        );
        return 'completed';
      }
      // A workflow action finishes on the status move; its own agent cannot raise
      // this signal (no signal while an action mode runs), so one seen here is a
      // leftover of a previous lifecycle — ending the run on it freed the agent
      // the moment its prompt was pasted.
      console.warn(
        `[Execution] Ignoring a stale completion signal for task ${taskId} "${taskText.slice(0, 60)}"`
      );
    }
    if (getTaskSignal(taskId, 'stopped')) {
      clearTaskSignal(taskId, 'stopped');
      return 'stopped';
    }
    const task = await getTaskById(taskId);
    if (!task) return 'deleted';
    // A Stop persisted by another process (the sibling stack, the next replica
    // of a rolling update) raises no signal here: the row is the only trace.
    if (task.executionStatus === 'stopped') return 'stopped';
    const status = (task as any).status;
    // Off the column the wait started on — the only "moved". A run started in an
    // inactive column (an on_enter on backlog) is not done just because it is there.
    if (startStatus !== undefined) return status !== startStatus ? 'moved' : null;
    return this._isActiveTaskStatus(status) ? null : 'moved';
  },

  /**
   * Sleeps `ms` in short slices, polling the verdict between them. Returns the
   * first verdict seen (so the caller exits at once), or null once the full
   * interval elapsed with the task still active on its start column.
   */
  async _waitIntervalOrVerdict(
    this: any,
    taskId: string,
    taskText: string,
    startStatus: string | undefined,
    ms: number,
    onSlice: (() => Promise<void>) | null = null
  ): Promise<'completed' | 'stopped' | 'moved' | 'deleted' | null> {
    const deadline = Date.now() + ms;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      await new Promise(resolve => setTimeout(resolve, Math.min(VERDICT_POLL_SLICE_MS, remaining)));
      const verdict = await this._pollTaskVerdict(taskId, taskText, startStatus);
      if (verdict) return verdict;
      if (onSlice) await onSlice().catch(() => {});
    }
  },

  /**
   * Stream-wrapped prompt send shared by the immediate-retry and the reminder
   * loop: agent:stream:start → send → agent:stream:end + agent:updated, with the
   * send failure swallowed (logged) so the wait continues. Uses the CLI
   * terminal-input path for terminal-driven CLI runners, else sendMessage.
   */
  async _sendPromptStreamed(
    this: any,
    executorId: string,
    executor: any,
    prompt: string,
    { terminalDriven = false, label = 'Send' }: { terminalDriven?: boolean; label?: string } = {}
  ): Promise<void> {
    this._emit('agent:stream:start', { agentId: executorId });
    try {
      if (terminalDriven && isCliRunner(executor) && this.executionManager?.sendTerminalInput) {
        await bindAgentRunner(this, executor);
        await this.executionManager.sendTerminalInput(executorId, prompt, { submit: true });
        noteCliPromptInjected(this, executorId, 'CLI prompt injected');
      } else {
        await this.sendMessage(executorId, prompt, (chunk: any) => {
          this._emit('agent:stream:chunk', { agentId: executorId, chunk });
          this._emit('agent:thinking', {
            agentId: executorId,
            thinking: executor.currentThinking || '',
          });
        });
      }
      // _saveExecutionLog moved to caller — captures full conversation including retries/reminders
    } catch (err: any) {
      console.error(`🔁 [Execution] ${label} failed: ${err.message}`);
    }
    this._emit('agent:stream:end', { agentId: executorId });
    this._emit('agent:updated', this._sanitize(executor));
  },

  /**
   * Terminal-driven auth/error probe phase. CLI runners (claudecode, …) execute
   * inside a shared PTY. An auth failure (expired token, "Please run /login",
   * invalid key) renders to the terminal and then the CLI goes quiet — which
   * otherwise looks identical to a finished task, so the workflow would advance
   * as if it succeeded. Poll the runner's session status for the latched
   * auth_error; it surfaces within the first seconds after injection. Returns a
   * terminal verdict ('completed'|'stopped'|'moved'|'deleted'|'error') or null
   * to continue to the reminder loop.
   */
  async _probeCliAuth(
    this: any,
    taskId: string,
    executorId: string,
    executorName: string,
    taskText: string,
    startStatus: string | undefined
  ): Promise<string | null> {
    const AUTH_PROBE_ATTEMPTS = 8;
    for (let i = 0; i < AUTH_PROBE_ATTEMPTS; i++) {
      await new Promise(resolve => setTimeout(resolve, CLI_AUTH_PROBE_INTERVAL_MS));
      const verdict = await this._pollTaskVerdict(taskId, taskText, startStatus);
      if (verdict) return verdict;
      const authErr = await this._checkTerminalAuthError(executorId);
      if (authErr) {
        setTaskSignal(taskId, 'authError', authErr);
        console.warn(
          `🔐 [Execution] CLI auth failure for "${executorName}" on task ${taskId} "${taskText.slice(0, 60)}": ${authErr}`
        );
        return 'error';
      }
    }
    return null;
  },

  /**
   * Immediate-retry phase (non-terminal runners only): if the agent went idle
   * without producing any output (empty response from coder-service, e.g.
   * session corruption), re-send the task immediately instead of waiting for the
   * slow reminder loop. Returns a terminal verdict or null to continue.
   */
  async _immediateIdleRetry(
    this: any,
    taskId: string,
    executorId: string,
    executorName: string,
    taskText: string,
    startStatus: string | undefined
  ): Promise<string | null> {
    const executor = this.agents.get(executorId);
    if (!(executor && executor.status === 'idle' && !getTaskSignal(taskId, 'stopped'))) return null;

    // Brief delay to let any in-flight state settle (e.g. socket events)
    await new Promise(resolve => setTimeout(resolve, 5000));

    const verdict = await this._pollTaskVerdict(taskId, taskText, startStatus);
    if (verdict) return verdict;

    if (executor.status === 'idle') {
      console.log(
        `🔄 [Execution] Agent "${executorName}" went idle without completing task ${taskId} "${taskText.slice(0, 60)}" — retrying immediately`
      );
      await this._sendPromptStreamed(
        executorId,
        executor,
        `[SYSTEM] You went idle without completing your task. Continue working on it now:\n"${taskText.slice(0, 500)}"\n\nUse your tools to complete the task. When done, use the native update_task tool with the task ID, final column, and summary.`,
        { label: 'Immediate retry' }
      );
      const retryResult = await this._pollTaskVerdict(taskId, taskText, startStatus);
      if (retryResult) return retryResult;
    }
    return null;
  },

  /**
   * Reminder-loop phase: periodically nudge the executor until it completes,
   * moves, or the reminder budget is exhausted. The budget is checked AFTER a
   * full wait, so the agent gets a whole interval to react to the last reminder
   * (ending the run right after sending it closed the commit window on the
   * very work the reminder asked for). While it waits, CLI runs get a
   * terminal-independent commit sweep every COMMIT_SWEEP_INTERVAL_MS.
   */
  async _reminderLoop(
    this: any,
    taskId: string,
    executorId: string,
    executorName: string,
    taskText: string,
    startStatus: string | undefined,
    {
      terminalDriven = false,
      gitBaselineHead = null,
    }: { terminalDriven?: boolean; gitBaselineHead?: string | null } = {}
  ): Promise<string> {
    const reminderConfig = await getReminderConfig();
    console.log(
      `🔔 [Execution] Agent "${executorName}" still idle after immediate retry for task ${taskId} "${taskText.slice(0, 60)}" — falling back to reminder loop (interval=${reminderConfig.intervalMinutes}min, cooldown=${reminderConfig.cooldownMinutes}min)`
    );
    const {
      intervalMs: REMINDER_INTERVAL_MS,
      maxReminders: MAX_REMINDERS,
      cooldownMs: COOLDOWN_MS,
    } = reminderConfig;
    let reminded = 0;
    let lastReminderSentAt = 0;

    // Terminal-independent commit sweep for CLI runners: a runner commits
    // silently inside its PTY (nothing parseable ever reaches the terminal), so
    // poll the repo itself and link what appeared since the run's baseline —
    // often enough that an API restart loses at most a minute of links.
    let lastSweepAt = Date.now();
    const sweep = terminalDriven
      ? async () => {
          if (Date.now() - lastSweepAt < COMMIT_SWEEP_INTERVAL_MS) return;
          lastSweepAt = Date.now();
          const run = getTaskCommitRun(this, executorId);
          if (run?.taskId !== taskId) return;
          await reconcileTaskCommits(this, executorId, taskId, {
            ...run,
            baselineHead: run.baselineHead ?? gitBaselineHead,
            label: 'MidRunSweep',
          });
        }
      : null;

    for (;;) {
      // Wait one reminder interval, but watch the verdict all along: the agent
      // usually finishes (update_task → next column) long before the interval
      // ends, and a blind sleep here kept the decide holding its column lock +
      // busy flag — the task sat "busy" in verify and never advanced.
      const verdict = await this._waitIntervalOrVerdict(
        taskId,
        taskText,
        startStatus,
        REMINDER_INTERVAL_MS,
        sweep
      );
      if (verdict) {
        console.log(
          `🔔 [Execution] Task ${taskId} verdict "${verdict}" during reminder wait — exiting loop`
        );
        return verdict;
      }

      if (reminded >= MAX_REMINDERS) {
        const finalTask = await getTaskById(taskId);
        if (finalTask && this._isActiveTaskStatus((finalTask as any).status)) {
          console.warn(
            `⚠️ [Execution] Max reminders (${MAX_REMINDERS}) reached for "${taskText.slice(0, 60)}" — task remains active (${(finalTask as any).status})`
          );
          this.addActionLog(
            executorId,
            'warning',
            `Task reminder limit reached — task remains active`,
            taskText.slice(0, 200)
          );
        }
        return 'timeout';
      }

      const currentExecutor = this.agents.get(executorId);
      if (
        !currentExecutor ||
        currentExecutor.status === 'busy' ||
        (terminalDriven && isCliRecentlyActive(executorId))
      ) {
        console.log(`🔔 [Execution] Executor "${executorName}" is busy — skipping reminder`);
        continue;
      }
      if (currentExecutor.status === 'error') {
        console.log(
          `🔔 [Execution] Executor "${executorName}" is in error — exiting reminder loop`
        );
        return 'error';
      }

      // Late CLI auth failure (token expired mid-run, re-auth needed). Surface
      // it the same way as the early probe so the task is failed, not left to
      // exhaust the reminder loop and time out as if "done".
      if (terminalDriven) {
        const loopAuthErr = await this._checkTerminalAuthError(executorId);
        if (loopAuthErr) {
          setTaskSignal(taskId, 'authError', loopAuthErr);
          console.warn(
            `🔐 [Execution] CLI auth failure (mid-run) for "${executorName}" on task ${taskId}: ${loopAuthErr}`
          );
          return 'error';
        }
      }

      // Cooldown: skip if a reminder was sent too recently
      const now = Date.now();
      if (COOLDOWN_MS > 0 && lastReminderSentAt > 0 && now - lastReminderSentAt < COOLDOWN_MS) {
        console.log(
          `🔔 [Execution] Cooldown active for "${executorName}" — skipping redundant reminder`
        );
        continue;
      }

      reminded++;
      lastReminderSentAt = now;
      console.log(
        `🔔 [Execution] Reminding "${executorName}" to complete task (attempt ${reminded}/${MAX_REMINDERS})`
      );

      const reminderPrompt = `[SYSTEM REMINDER] You have an active task that is not yet complete:\n"${taskText.slice(0, 300)}"\n\nPlease finish your work on this task. When you are done, you MUST use the native update_task tool with the task ID, final column, and summary. Moving it to the final column with a summary signals completion.\n\nIf you have already finished all the work, use update_task now to move the task to its final column with a summary of what was accomplished.`;
      await this._sendPromptStreamed(executorId, currentExecutor, reminderPrompt, {
        terminalDriven,
        label: 'Reminder',
      });

      const afterResult = await this._pollTaskVerdict(taskId, taskText, startStatus);
      if (afterResult) return afterResult;
    }
  },

  async _waitForExecutionComplete(
    this: any,
    creatorAgentId: string,
    taskId: string,
    executorId: string,
    executorName: string,
    taskText: string,
    options: any = {}
  ): Promise<string> {
    const terminalDriven = Boolean(options.terminalDriven);
    // HEAD snapshot taken by executeRunAgent before the run started — anchors
    // the terminal-independent commit sweep in the reminder loop (gitReconcile.ts).
    const gitBaselineHead: string | null = options.gitBaselineHead || null;
    // The prompt was just pasted: the CLI is working NOW, whatever the wait below
    // concludes. Without this an early exit (task already moved, Stop during the
    // injection) left the agent "idle" — selectable — while its CLI worked.
    if (terminalDriven) noteCliPromptInjected(this, executorId, 'CLI task injected');
    let verdict: string;
    try {
      verdict = await this._awaitExecutionVerdict(
        creatorAgentId,
        taskId,
        executorId,
        executorName,
        taskText,
        { terminalDriven, gitBaselineHead }
      );
    } finally {
      // The 'watching' marker only lives as long as this wait, whichever phase
      // ended it (it used to survive an early verdict and hide the task from the
      // task loop and the workflow recheck). A Stop recorded meanwhile wins: the
      // reset only applies while the row still says 'watching'.
      if (getTaskSignal(taskId, 'watching')) {
        clearTaskSignal(taskId, 'watching');
        await updateTaskFields(
          taskId,
          { executionStatus: null },
          { expect: { executionStatus: 'watching' } }
        );
      }
    }
    if (terminalDriven) {
      await this._drainCliRun(executorId, executorName, taskId, {
        stopped: verdict === 'stopped',
      });
    }
    return verdict;
  },

  /** The verdict part of _waitForExecutionComplete (see there). */
  async _awaitExecutionVerdict(
    this: any,
    creatorAgentId: string,
    taskId: string,
    executorId: string,
    executorName: string,
    taskText: string,
    { terminalDriven, gitBaselineHead }: { terminalDriven: boolean; gitBaselineHead: string | null }
  ): Promise<string> {
    const freshTask = await getTaskById(taskId);
    // The column this wait started on. A workflow transition is finished as soon
    // as the agent moves the task OFF this column — even to another ACTIVE column
    // (e.g. a decide moving testclaudepaid → testopencode). Verdict checks that
    // only caught a move to an INACTIVE status would leave an active→active move
    // invisible, blocking the transition until the 15-min stale-lock eviction —
    // holding the per-task processing lock + agent busy flag and starving the
    // next column / every other assignment ("no idle agent"). `startStatus`
    // threads into _pollTaskVerdict so an off-column move always reads as 'moved'.
    const startStatus: string | undefined = freshTask?.status;
    console.log(
      `🔍 [Execution] _waitForExecutionComplete: task=${taskId} creator=${creatorAgentId} executor=${executorName} completionSignal=${Boolean(getTaskSignal(taskId, 'completed'))} status=${freshTask?.status}`
    );

    // Early exit if the executor was stopped (e.g. user pressed Stop) before we
    // got here — otherwise we'd hold the workflow lock through the reminder loop
    // while the agent is already idle.
    if (getTaskSignal(taskId, 'stopped')) {
      clearTaskSignal(taskId, 'stopped');
      console.log(
        `🛑 [Execution] Task ${taskId} "${taskText.slice(0, 60)}" was stopped before wait started — exiting`
      );
      return 'stopped';
    }
    // Task already failed — block the transition (checked before the verdict poll
    // because 'error' is an inactive status the poll would otherwise read as 'moved').
    if (freshTask?.status === 'error') {
      console.log(
        `[Execution] Task ${taskId} "${taskText.slice(0, 60)}" ended with error — blocking transition`
      );
      return 'error';
    }
    // Immediate completion / already-moved.
    const immediate = await this._pollTaskVerdict(taskId, taskText, startStatus);
    if (immediate) {
      if (immediate === 'moved')
        console.log(
          `[Execution] Task ${taskId} "${taskText.slice(0, 60)}" already moved — accepting`
        );
      return immediate;
    }

    // Mark task as watching so the task loop doesn't re-send. Cleared by
    // _waitForExecutionComplete's finally, whichever phase ends the wait; never
    // over a Stop persisted in the meantime.
    setTaskSignal(taskId, 'watching', true);
    await updateTaskFields(
      taskId,
      { executionStatus: 'watching' },
      { expect: { executionStatus: null } }
    );

    // Keep the executor's busy/idle status in step with the CLI's real activity
    // for the whole wait (it never goes through sendMessage, which is what
    // marks the other runners busy).
    const stopActivityWatch = terminalDriven ? watchCliActivity(this, executorId) : null;
    try {
      return await this._watchExecutionPhases(
        taskId,
        executorId,
        executorName,
        taskText,
        startStatus,
        { terminalDriven, gitBaselineHead }
      );
    } finally {
      stopActivityWatch?.();
    }
  },

  /** Phases 1–3 of _waitForExecutionComplete, run once the task is being watched. */
  async _watchExecutionPhases(
    this: any,
    taskId: string,
    executorId: string,
    executorName: string,
    taskText: string,
    startStatus: string | undefined,
    { terminalDriven, gitBaselineHead }: { terminalDriven: boolean; gitBaselineHead: string | null }
  ): Promise<string> {
    // ── Phase 1: terminal-driven auth/error probe ──────────────────────────
    if (terminalDriven) {
      const probeVerdict = await this._probeCliAuth(
        taskId,
        executorId,
        executorName,
        taskText,
        startStatus
      );
      if (probeVerdict) return probeVerdict;
    }

    // ── Phase 2: immediate idle retry (non-terminal runners) ───────────────
    if (!terminalDriven) {
      const retryVerdict = await this._immediateIdleRetry(
        taskId,
        executorId,
        executorName,
        taskText,
        startStatus
      );
      if (retryVerdict) return retryVerdict;
    }

    // ── Phase 3: reminder loop (owns the watching finally lifecycle) ───────
    return this._reminderLoop(taskId, executorId, executorName, taskText, startStatus, {
      terminalDriven,
      gitBaselineHead,
    });
  },

  async _resumeActiveTask(
    this: any,
    agentId: string,
    agent: any,
    task: any,
    reserved?: () => void
  ): Promise<void> {
    // Last line of defence: every path that sends a task's text to an agent for
    // execution ends here. The workflow queries already exclude unapproved
    // external tasks; a stale in-memory copy must not slip past them.
    if (needsApproval(task)) {
      reserved?.();
      throw new Error(APPROVAL_REQUIRED_MESSAGE);
    }
    const executorId = task.assignee || agentId;
    const executor = this.agents.get(executorId) || agent;
    const releaseRun =
      reserved || reserveAgentForTask(executorId, task.id, `${task.agentId}:${task.id}:resume`);
    if (!releaseRun) {
      throw new Error(`Agent or task already reserved: agent="${executorId}" task="${task.id}"`);
    }

    // CLI runners always resume through their interactive PTY (not headless
    // sendMessage), regardless of the transient agent.status.
    const terminalDriven = !!(isCliRunner(executor) && this.executionManager?.sendTerminalInput);
    // A task the loop resumes was started earlier and stays "started" after this
    // run (the loop keeps nudging it until it leaves the column); an explicit run
    // of a never-started task leaves no start stamp behind.
    let keepStartedAt = !!task.startedAt;
    let claim: Awaited<ReturnType<typeof claimRun>> | null = null;
    try {
      // Never paste a task into a CLI that is still busy — after an API restart
      // its previous turn may still be running in the runner's PTY, and the
      // runner pastes anyway once its readiness wait times out.
      if (terminalDriven && !(await this._isCliQuiet(executorId))) {
        console.log(
          `⏸️ [TaskLoop] "${executor.name}"'s terminal is still active — not resuming task ${task.id} yet`
        );
        // Busy until its CLI goes quiet: nothing else is pasted into it meanwhile.
        noteCliActivity(this, executorId, 'CLI still active');
        return;
      }
      // The durable claim: makes the run visible (spinner, Stop, the move/delete
      // guards, update_task's current-task resolution) and exclusive across the
      // stacks and replicas sharing the database — and only while the task is
      // still in the column this resume was decided for.
      claim = await claimRun(task.id, executorId, 'resume', {
        expectStatus: task.status,
        onLost: () => setTaskSignal(task.id, 'stopped', true),
      });
      if (!claim.ok) {
        if (reserved) {
          console.warn(
            `⚠️ [Resume] explicit run of task ${task.id} declined (${claim.reason}) — nothing was started`
          );
        }
        return;
      }
      emitTaskUpdated(this, { ...claim.task }, { emitAgent: false, stampUpdatedAt: true });

      // Confine (or release) the executor BEFORE anything below reads its history
      // or sends it the task — see security/externalRunProfile.ts.
      await enterRunProfileForTask(this, executor, task);

      const streamCallback = (chunk: any) => {
        this._emit('agent:stream:chunk', { agentId: executorId, chunk });
        this._emit('agent:thinking', {
          agentId: executorId,
          thinking: executor.currentThinking || '',
        });
      };

      this._emit('agent:stream:start', { agentId: executorId });

      let startMsgIdx = executor.conversationHistory.length;
      let executionStartedAt = new Date().toISOString();
      let commitRunStarted = false;
      // Prompt pasted into a CLI runner's terminal. Hoisted so BOTH the success
      // and the error path can hand it to _saveExecutionLog — a terminal-driven
      // run leaves no conversation history, so this is the only record of what
      // the agent was asked.
      let injectedPrompt: string | null = null;
      // Ensure startedAt is set for managesContext history scoping
      if (!task.startedAt) {
        task.startedAt = claim.task.startedAt || executionStartedAt;
      }

      try {
        await waitForProjectSwitch(executor);
        // Repo selection drives the executor's project context. The task carries
        // a `repoFullName` (hydrated from board_repos via the JOIN); if it
        // differs from the executor's current repo we switch sandbox + history.
        // Secondary repos are cloned alongside the primary. Hand the keep-set to
        // the execution layer first so every subsequent ensure (even primary-only
        // ones) preserves them; then re-ensure when the primary changed OR there
        // are secondaries to (re)clone.
        const taskRepo = task.repoFullName || null;
        const secondaryRepos = normalizeSecondaryRepos(task.secondaryRepos, taskRepo);
        // Runs on EVERY execution, including when the executor is already recorded
        // as being on the task's repo: `executor.project` is API-side state that
        // outlives the runner container, so that case is exactly the one where a
        // recycled runner has no clone and no ~/.git-credentials, and every push
        // fails with "could not read Username". The ensure is idempotent and
        // TTL-debounced — see services/execution/agentWorkspace.ts.
        if (this.executionManager) {
          try {
            // Provision the same container that will receive the task prompt.
            // Without binding first, a fresh API process defaults to sandbox.
            await bindAgentRunner(this, executor);
            const gitCreds = await resolveAgentGitCredentials(executor);
            const { switched } = await ensureAgentWorkspace(this.executionManager, executor, {
              repo: taskRepo,
              repoHtmlUrl: task.repoHtmlUrl,
              secondaryRepos,
              gitCredentials: gitCreds,
            });
            if (switched) {
              console.log(
                `🔄 [TaskLoop] Switching "${executor.name}" from "${executor.project || '(none)'}" to repo "${taskRepo}" for resume`
              );
              this._switchProjectContext?.(executor, executor.project, taskRepo);
              executor.projectChangedAt = new Date().toISOString();
            }
            // Same container as the prompt: copy the task's files next to it.
            task.materializedAttachments = await deliverTaskAttachments(
              this.executionManager,
              executor.id,
              task.id
            );
          } catch (switchErr: any) {
            console.error(
              `🔄 [TaskLoop] Execution env switch failed for "${executor.name}": ${switchErr.message}`
            );
            throw switchErr;
          }
        }
        if (taskRepo) {
          executor.project = taskRepo;
          await saveAgent(executor);
          this._emit('agent:updated', this._sanitize(executor));
        }

        await clearTaskErrorForRun(this, task);
        clearTaskSignal(task.id, 'completed');
        clearTaskSignal(task.id, 'comment');

        startMsgIdx = executor.conversationHistory.length;
        executionStartedAt = new Date().toISOString();

        // Check if the agent already started working on this task (has the task
        // text in its conversation history).  If so, send a continuation nudge
        // instead of the original message, which would cause a full reasoning reset.
        const taskPrefix = task.text.slice(0, 80);
        // API history can survive a repo switch while the interactive CLI has
        // restarted. Always send the complete task to CLI runners.
        const alreadySent =
          !isCliRunner(executor) &&
          executor.conversationHistory.some(
            (msg: any) =>
              msg.role === 'user' &&
              typeof msg.content === 'string' &&
              msg.content.includes(taskPrefix)
          );
        const messageToSend = alreadySent
          ? `[SYSTEM REMINDER] You have an active task that needs to be completed:\n${taskContentForPrompt(task, 300)}\n\nContinue where you left off. When you are done, use the native update_task tool with the task ID, final column, and summary to complete it.`
          : `Task ID: ${task.id}\n\n${taskContentForPrompt(task)}`;

        // Snapshot the repo HEAD(s) before the run: the wait-loop sweep and the
        // finally reconcile below link every commit the executor makes — the only
        // detection that works for CLI runners, whose git activity happens
        // silently inside their PTY.
        await startTaskCommitRun(this, executorId, task, executionStartedAt);
        commitRunStarted = true;

        // A Stop received during workspace preparation cancels prompt injection.
        if (getTaskSignal(task.id, 'stopped')) {
          keepStartedAt = false;
          return;
        }

        // From here the agent's completion signal (update_task with a summary)
        // ends this wait — and only this wait (see setAwaitingCompletion).
        setAwaitingCompletion(task.id, true);
        if (terminalDriven) {
          injectedPrompt = messageToSend;
          await bindAgentRunner(this, executor);
          await this.executionManager.sendTerminalInput(executorId, messageToSend, {
            submit: true,
          });
        } else {
          await this.sendMessage(executorId, messageToSend, streamCallback);
        }

        // CLI runners like opencode, openclaw, hermes, and codex manage their own
        // internal tool pipeline and exit when their work is done. For those
        // runners, process exit is enough to satisfy the task wait; otherwise the
        // loop would treat the idle runner as unfinished and keep reminding it.
        if (!terminalDriven && executor.runner && SELF_COMPLETING_RUNNERS.has(executor.runner)) {
          if (!getTaskSignal(task.id, 'completed') && !getTaskSignal(task.id, 'stopped')) {
            console.log(
              `✅ [TaskLoop] CLI runner "${executor.runner}" finished — auto-signaling task completion`
            );
            setTaskSignal(task.id, 'completed', true);
          }
        }

        // _saveExecutionLog moved after _waitForExecutionComplete — captures full conversation

        const waitResult = await this._waitForExecutionComplete(
          agentId,
          task.id,
          executorId,
          executor.name,
          task.text,
          {
            terminalDriven,
            gitBaselineHead: getTaskCommitRun(this, executorId)?.baselineHead ?? null,
          }
        );
        if (waitResult === 'stopped' || waitResult === 'moved' || waitResult === 'deleted') {
          keepStartedAt = false;
        }

        // A detected CLI auth failure (or other hard error) must fail the task
        // rather than silently complete. Throw so the catch below runs the
        // standard error path (markTaskError + error report + execution log).
        if (waitResult === 'error') {
          const authError = this._consumeTaskAuthError(task.id);
          throw new Error(authError || 'CLI execution ended in error');
        }

        // Save execution log AFTER wait completes — captures the full conversation
        // including retries, reminders, and tool calls.
        this._saveExecutionLog(
          agentId,
          task.id,
          executorId,
          startMsgIdx,
          executionStartedAt,
          waitResult !== 'error' && waitResult !== 'timeout',
          undefined,
          { prompt: injectedPrompt }
        );
      } catch (err: any) {
        const isUserStop = isUserStopError(err);
        keepStartedAt = false;
        console.error(`🔄 [TaskLoop] Error resuming task for ${executor.name}:`, err.message);
        this._emit('agent:stream:error', { agentId: executorId, error: err.message });

        // Save execution log for the error case — captures whatever conversation happened before the error
        this._saveExecutionLog(
          agentId,
          task.id,
          executorId,
          startMsgIdx,
          executionStartedAt,
          false,
          undefined,
          { prompt: injectedPrompt }
        );

        const errorTimestamp = new Date().toISOString();

        if (isUserStop) {
          // User manually stopped — mark as stopped, keep in current column.
          // Targeted write: a full save of a re-read snapshot reverted whatever
          // landed in between (the claim release, a linked commit).
          const stoppedTask = await updateTaskFields(task.id, {
            executionStatus: 'stopped',
            historyAppend: [
              { status: task.status, at: errorTimestamp, by: 'user', type: 'stopped' },
            ],
          });
          setTaskSignal(task.id, 'stopped', true);
          if (stoppedTask) emitTaskUpdated(this, { ...stoppedTask }, { emitAgent: false });
        } else {
          // Real error — keep task in its originating column via errorFromStatus.
          // persistTaskError (markTaskError) guards against the disappearance bug
          // (errorFromStatus clobbered to 'error', or set to a deleted column).
          await persistTaskError(this, task.id, err.message, {
            by: executor.name,
            agentName: executor.name,
          });
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
        setAwaitingCompletion(task.id, false);
        // End-of-run commit/push reconcile — mirrors executeRunAgent's finally.
        // Runs after the CLI went quiet (_waitForExecutionComplete drains it), so
        // the run's last commits land on THIS task, not on the next one the agent
        // gets. Idempotent.
        if (commitRunStarted)
          await finishTaskCommitRun(this, executorId, task.id, 'ResumeEndReconcile');
        this._emit('agent:stream:end', { agentId: executorId });
        this._emit('agent:updated', this._sanitize(executor));
      }
    } finally {
      if (claim?.ok) {
        claim.stopHeartbeat();
        const released = await releaseRunClaim(task.id, executorId, { keepStartedAt });
        if (released)
          emitTaskUpdated(this, { ...released }, { emitAgent: false, stampUpdatedAt: true });
      }
      releaseRun();
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
    this._taskQueues.set(
      agentId,
      resultPromise.catch(() => {})
    );
    return resultPromise;
  },
};
