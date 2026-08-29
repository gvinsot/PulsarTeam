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
import { saveTaskToDb, updateTaskFields } from './database.js';

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
 * @param unassignOnStatusChange drop the assignee when the status changes
 *   (default true; PUT passes false when the request explicitly sets `agentId`).
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
  }: {
    targetBoard?: { id: string; name?: string | null; oldName?: string | null } | null;
    targetColumn?: string;
    username: string;
    now?: string;
    bulk?: boolean;
    editedFields?: string[];
    unassignOnStatusChange?: boolean;
    setTaskSignal?: (taskId: string, key: string, value: any) => void;
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
  let previousAssignee: string | null = null;
  if (statusChanged && unassignOnStatusChange && task.assignee) {
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
    if (statusChanged) {
      historyEntry.from = oldStatus;
      if (previousAssignee) {
        historyEntry.previousAssignee = previousAssignee;
        historyEntry.assignee = null;
      }
      fields.push('status');
    }
    if (!task.history) task.history = [];
    task.history.push(historyEntry);
  }

  // Persist to the single source of truth BEFORE the move side-effects — the
  // auto-refine path reads the committed row.
  await agentManager.saveTaskDirectly(task);

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
