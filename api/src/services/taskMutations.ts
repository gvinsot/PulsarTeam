// ─── Canonical task-mutation helpers ─────────────────────────────────────────
// One home for the "modify task → clean execution state → persist → enrich →
// emit task:updated" pattern that was copy-pasted across routes/tasks.ts,
// routes/boards.ts, workflow/actionExecutor.ts, swarmApiMcp.ts and the
// agentManager mutators. Centralizing it removes the subtle divergences (full vs
// shorter execution reset, whether agent:updated fires, stamp-vs-no-stamp) that
// crept in when each site maintained its own copy.
//
// All functions take the AgentManager instance so they can read the agent
// registry (assignee enrichment), emit over the WS layer, and (for the persist
// variants) hit the DB accessors. The DB is the single source of truth — there
// is no in-memory task store.
import { saveTaskToDb, updateTaskFields, appendTaskComment, getTaskById } from './database.js';
import { markTaskError } from './workflow/taskErrors.js';
import type { Task, TaskHistoryEntry } from './database/tasks.js';
import { recordTaskComment, type TaskComment, type TaskCommentInput } from '../lib/taskComments.js';

export { recordTaskComment };

/** Error surfaced when an assignee is linked to a different board than its task. */
export const ASSIGNEE_BOARD_MISMATCH_ERROR = "Assignee agent does not belong to this task's board";

/**
 * True when `assignee` is linked to a board other than `taskBoardId`. A task may
 * only be assigned to an agent of its OWN board — a data-integrity rule that
 * holds for every role and every write path (PUT /tasks/:id, the agent-scoped
 * assignee/transfer routes, board moves). Board-less agents or tasks are exempt.
 */
export function isAssigneeOffBoard(
  assignee: { boardId?: string | null } | null | undefined,
  taskBoardId: string | null | undefined
): boolean {
  return !!(assignee?.boardId && taskBoardId && assignee.boardId !== taskBoardId);
}

/** Attach assigneeName/assigneeIcon to a task IN PLACE, resolved from the agent
 * registry (null when unassigned or the agent is gone). Returns the task. */
export function enrichAssignee(agentManager: any, task: any): any {
  const assigneeAgent = task.assignee ? agentManager.agents.get(task.assignee) : null;
  task.assigneeName = assigneeAgent?.name || null;
  task.assigneeIcon = assigneeAgent?.icon || null;
  return task;
}

/**
 * Emit `task:updated` for a task (assignee-enriched), and — by default — an
 * `agent:updated` for its owner so the owner's board refreshes.
 *
 * @param stampUpdatedAt refresh `task.updatedAt` to now so the frontend's
 *   timestamp-based merge keeps this update over a stale loadTasks() response.
 *   Use when NO setTaskStatus/updateTaskFields(NOW()) already stamped it.
 * @param emitAgent also emit `agent:updated` for the owner (false for
 *   mid-chain workflow emits, which only need the card refreshed).
 *
 * Mutates `task` (enrich + optional stamp) — pass a copy if the caller must keep
 * the original pristine.
 */
export function emitTaskUpdated(
  agentManager: any,
  task: any,
  {
    emitAgent = true,
    stampUpdatedAt = false,
  }: { emitAgent?: boolean; stampUpdatedAt?: boolean } = {}
): void {
  if (stampUpdatedAt) task.updatedAt = new Date().toISOString();
  enrichAssignee(agentManager, task);
  const ownerId = task.agentId ?? null;
  agentManager._emit('task:updated', { agentId: ownerId, task });
  if (emitAgent && ownerId) {
    const agent = agentManager.agents.get(ownerId);
    if (agent) agentManager._emit('agent:updated', agentManager._sanitize(agent));
  }
}

/**
 * Persist a task THEN emit — the ordering the frontend relies on: a loadTasks()
 * triggered by the emit must read the committed row (otherwise a stale SELECT on
 * a parallel pool connection can overwrite the real-time update). Pass `fields`
 * for a TARGETED column update (updateTaskFields) instead of the full upsert.
 *
 * Emits a COPY so the caller's `task` object is not mutated by enrichment/stamp.
 * Persistence failures are swallowed (logged by the accessor) so the live UI is
 * still driven by the emit. Returns the promise so callers may await if needed.
 */
export function persistThenEmit(
  agentManager: any,
  task: any,
  {
    fields = null,
    emitAgent = false,
    stampUpdatedAt = true,
  }: { fields?: Record<string, any> | null; emitAgent?: boolean; stampUpdatedAt?: boolean } = {}
): Promise<void> {
  const ownerId = task.agentId ?? null;
  const payload = { ...task, agentId: ownerId };
  const persist = fields ? updateTaskFields(task.id, fields) : saveTaskToDb(payload);
  return Promise.resolve(persist)
    .catch(() => {})
    .then(() => emitTaskUpdated(agentManager, payload, { emitAgent, stampUpdatedAt }));
}

/**
 * Put a task in error (markTaskError's invariants: errorFromStatus kept valid
 * and visible) with a TARGETED write of exactly what that changes, plus an
 * atomic history append, then emit. The full-row saves this replaces wrote a
 * snapshot back — dropping commits linked meanwhile, or reverting a move.
 * Leaves the run claim alone: the run that failed releases it. Returns the fresh
 * row, or null when the task is gone.
 */
export async function persistTaskError(
  agentManager: Parameters<typeof emitTaskUpdated>[0],
  taskId: string,
  message: string | undefined,
  opts: {
    by: string;
    mode?: string | null;
    actionIndex?: number | null;
    agentName?: string | null;
    actionType?: string | null;
    workflow?: Parameters<typeof markTaskError>[2]['workflow'];
  }
): Promise<Task | null> {
  const task = await getTaskById(taskId);
  if (!task) return null;
  let workflow = opts.workflow ?? null;
  if (!workflow && task.boardId) {
    try {
      // Imported lazily: this module stays out of configManager's import graph
      // (consumers mock the database module with only what they use).
      const { getWorkflowForBoard } = await import('./configManager.js');
      workflow = await getWorkflowForBoard(task.boardId);
    } catch {
      /* best-effort: markTaskError still works without column validation */
    }
  }
  const draft: Task & { history: TaskHistoryEntry[] } = { ...task, history: [] };
  if (!markTaskError(draft, message, { ...opts, workflow })) return task;
  const entry = draft.history[draft.history.length - 1];
  if (entry && opts.actionType) entry.actionType = opts.actionType;
  const updated = await updateTaskFields(taskId, {
    status: draft.status,
    error: draft.error,
    errorFromStatus: draft.errorFromStatus ?? null,
    assignee: draft.assignee ?? null,
    historyAppend: entry ? [entry] : [],
  });
  if (updated) emitTaskUpdated(agentManager, { ...updated }, { stampUpdatedAt: true });
  return updated;
}

/** Retire a previous run's error only after the next run's preparation succeeds.
 * Keep the history intact, and persist before a prompt or UI can read the task.
 */
export async function clearTaskErrorForRun(agentManager: any, task: any): Promise<void> {
  if (!task.error && !task.errorFromStatus) return;
  task.error = null;
  task.errorFromStatus = null;
  await persistThenEmit(agentManager, task, {
    fields: { error: null, errorFromStatus: null },
  });
}

/**
 * Clear a task's execution state when it moves columns, so the task loop / workflow
 * engine doesn't resume its prior run. This is the "SHORTER" reset used by user/
 * workflow moves: it drops the run flags but KEEPS the persisted
 * completedActionIdx / _pendingOnEnter so an interrupted chain can still resume
 * after a restart. Pass `full` to also wipe those (fresh-start semantics).
 * Sets completedAt when moving to `done`. Mutates `task` in place.
 */
export function clearExecutionOnMove(
  task: any,
  {
    toStatus,
    now = new Date().toISOString(),
    full = false,
  }: { toStatus?: string; now?: string; full?: boolean } = {}
): void {
  task.startedAt = null;
  task.executionStatus = null;
  task.actionRunning = false;
  delete task.actionRunningAgentId;
  delete task.actionRunningMode;
  if (full) {
    task.completedActionIdx = null;
    delete task._pendingOnEnter;
  }
  if (toStatus === 'done') task.completedAt = now;
}

// Columns a move never writes: they change only through their own atomic
// accessors (history is appended, comments/commits/claim have dedicated writers),
// or are not columns at all (derived/transient fields of the task object).
const MOVE_NEVER_WRITES = new Set([
  'history',
  'comments',
  'commits',
  'actionRunning',
  'actionRunningAgentId',
  'actionRunningMode',
  'actionHeartbeatAt',
  'commitRun',
  'trustLevel',
  'securityFlags',
  'updatedAt',
  'createdAt',
  'deletedAt',
  'deletedBy',
  'project',
  'projectId',
  'repoHtmlUrl',
  'humanViewedAt',
  'assigneeName',
  'assigneeIcon',
  'materializedAttachments',
  '_pendingOnEnter',
]);

/**
 * Shared task-move core for PUT /tasks/:id and POST /tasks/bulk-move.
 *
 * Applies the destination board/column to `task` IN PLACE, unassigns on a status
 * change, clears execution state so the moved task doesn't resume, records a
 * single history entry, PERSISTS via `mgr.saveTaskDirectly`, then fires the
 * move side-effects (stop signal + auto-refine). It does NOT emit `task:updated`
 * or write the audit log — the caller owns those so it can add route-specific
 * payloads (`task:moved` / `task:bulk-moved`, audit details).
 *
 * The caller is responsible for the HTTP-facing validations that precede a move
 * (board access, column validity) and for resolving them into `targetBoard` /
 * `targetColumn`. This keeps the mutation semantics in ONE place so the two
 * handlers can no longer drift (the previous copies disagreed on the history
 * `fields` array and the entry `type`).
 *
 * @param targetBoard destination board `{ id, name, oldName }` when the board
 *   changes, else null. `oldName` is the human name of the task's previous board.
 * @param targetColumn resolved (already-validated) destination column id, or
 *   undefined to leave the status untouched.
 * @param editedFields extra non-move field markers to fold into the history
 *   entry (PUT's field-edit phase). This array IS mutated: an `assignee` marker
 *   is appended when a status move unassigns, so the caller's audit log sees it.
 * @param unassignOnStatusChange drop the assignee when the status or board
 *   changes (default true; PUT passes false when the request explicitly sets
 *   `agentId`). An assignee from another board is dropped on a board move
 *   regardless of this flag.
 * @param setTaskSignal injected `agentManager/tasks#setTaskSignal` used to raise
 *   the `stopped` flag on a status move. Injected (rather than imported) so this
 *   module stays free of the heavy agentManager import graph — importing it here
 *   would drag `database.js` into every consumer's module-mock and break the MCP
 *   unit tests. No-ops when omitted.
 * @returns `{ statusChanged, boardChanged, historyEntry, previousAssignee }`.
 */
export async function applyTaskMove(
  agentManager: any,
  task: any,
  {
    targetBoard = null,
    targetColumn,
    username,
    now = new Date().toISOString(),
    bulk = false,
    editedFields = [],
    unassignOnStatusChange = true,
    setTaskSignal,
    baseline = null,
  }: {
    targetBoard?: { id: string; name?: string | null; oldName?: string | null } | null;
    targetColumn?: string;
    username: string;
    now?: string;
    bulk?: boolean;
    editedFields?: string[];
    unassignOnStatusChange?: boolean;
    setTaskSignal?: (taskId: string, key: string, value: any) => void;
    /** The task as read before the caller edited it: only what differs from it
     *  is written (see the persistence step below). */
    baseline?: object | null;
  }
): Promise<{
  statusChanged: boolean;
  boardChanged: boolean;
  historyEntry: any;
  previousAssignee: string | null;
}> {
  const oldBoardId = task.boardId || null;
  const oldStatus = task.status;

  const boardChanged = !!(targetBoard && targetBoard.id !== oldBoardId);
  if (targetBoard) task.boardId = targetBoard.id;
  if (targetColumn !== undefined) task.status = targetColumn;
  const statusChanged = task.status !== oldStatus;

  // Unassign on a status move so a different column's owner doesn't inherit the
  // previous agent. (PUT suppresses this when the request explicitly reassigns.)
  // A board move also drops the assignee: the old board's agent must never stay
  // attached to a task living on another board — even when the target board's
  // first column shares the current status id (so `statusChanged` is false), and
  // even when the caller asked to keep it, if it does not belong to the new board.
  let previousAssignee: string | null = null;
  const moved = statusChanged || boardChanged;
  const offBoard =
    boardChanged &&
    !!task.assignee &&
    isAssigneeOffBoard(agentManager.agents?.get(task.assignee), task.boardId);
  if (((moved && unassignOnStatusChange) || offBoard) && task.assignee) {
    previousAssignee = task.assignee;
    task.assignee = null;
    if (!editedFields.includes('assignee')) editedFields.push('assignee');
  }

  // Clear execution state on a status change so the moved task doesn't resume.
  // The SHORTER reset keeps the persisted completedActionIdx/_pendingOnEnter so
  // an interrupted chain can still resume after a restart.
  if (statusChanged) clearExecutionOnMove(task, { toStatus: task.status, now });
  task.updatedAt = now;

  // ── Single history entry (board move, status move, and/or field edits) ──
  let historyEntry: any = null;
  const hasChanges = boardChanged || statusChanged || editedFields.length > 0;
  if (hasChanges) {
    const fields = [...editedFields];
    historyEntry = {
      at: now,
      by: username,
      type: boardChanged ? 'board_move' : 'edit',
      status: task.status,
      fields,
    };
    if (bulk) historyEntry.bulk = true;
    if (boardChanged) {
      historyEntry.fromBoard = oldBoardId;
      historyEntry.toBoard = task.boardId;
      historyEntry.fromBoardName = targetBoard?.oldName ?? null;
      historyEntry.toBoardName = targetBoard?.name ?? null;
    }
    if (previousAssignee) {
      historyEntry.previousAssignee = previousAssignee;
      historyEntry.assignee = null;
    }
    if (statusChanged) {
      historyEntry.from = oldStatus;
      fields.push('status');
    }
    if (!task.history) task.history = [];
    task.history.push(historyEntry);
  }

  // Persist to the single source of truth BEFORE the move side-effects — the
  // auto-refine path reads the committed row. Only what this request changed is
  // written (the fields that differ from `baseline`), plus the execution reset of
  // a column move and an atomic history append: the full-row save of the
  // request's snapshot it replaces reverted every write that landed while the
  // request was in flight — a linked commit, the agent's own status move, a claim.
  const reference = (baseline || (await getTaskById(task.id)) || {}) as Record<string, unknown>;
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(task)) {
    if (MOVE_NEVER_WRITES.has(key)) continue;
    if (JSON.stringify(value) !== JSON.stringify(reference[key])) fields[key] = value ?? null;
  }
  if (statusChanged) {
    // A column move starts the new column fresh: no run state, no chain resume
    // marker of the previous column (kept, it made a later re-entry resume the
    // old chain mid-way).
    Object.assign(fields, {
      status: task.status,
      startedAt: null,
      executionStatus: null,
      pendingOnEnter: null,
      completedActionIdx: null,
      resumeTransitionIdx: null,
    });
    if (task.status === 'done') fields.completedAt = task.completedAt || now;
  }
  // An emptied date field arrives as '' from the forms; the column wants NULL
  // (an '' made the whole update fail, silently).
  if (fields.dueDate === '') fields.dueDate = null;
  if (historyEntry) fields.historyAppend = [historyEntry];
  const persisted = await updateTaskFields(task.id, fields);
  if (!persisted && (historyEntry || statusChanged)) {
    // Nothing reached the database: reporting success would show the user a
    // move that never happened, and fire the new column's actions on it.
    throw new Error('Failed to persist the task change');
  }
  if (persisted) Object.assign(task, persisted);

  if (statusChanged) {
    // Signal the reminder loop / execution wait to exit — the executing agent
    // should no longer work on this task.
    setTaskSignal?.(task.id, 'stopped', true);
    if (task.status !== 'error') {
      agentManager._checkAutoRefine({ ...task }, { by: username });
    }
  }

  return { statusChanged, boardChanged, historyEntry, previousAssignee };
}

// ─── Comments ────────────────────────────────────────────────────────────────
// A task's comment thread is separate from its description (lib/taskComments.ts).

/**
 * Add a comment and persist it: atomic append on `comments`, the history entry,
 * then emit task:updated. Shared by REST (POST /tasks/:id/comments) and the MCP
 * tools. Returns the comment and the re-read task, or null for a blank body.
 */
export async function addTaskComment(
  agentManager: any,
  task: any,
  input: TaskCommentInput
): Promise<{ comment: TaskComment; task: any } | null> {
  const historyBefore = (task.history || []).length;
  const comment = recordTaskComment(task, input);
  if (!comment) return null;
  await appendTaskComment(task.id, comment);
  // Append only the comment's history entry: rewriting the whole array from the
  // caller's snapshot dropped entries written meanwhile.
  const updated =
    (await updateTaskFields(task.id, {
      historyAppend: (task.history || []).slice(historyBefore),
    })) || task;
  emitTaskUpdated(agentManager, updated, { emitAgent: false });
  return { comment, task: updated };
}
