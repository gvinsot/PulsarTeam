/**
 * Task error helpers — single source of truth for marking tasks as errored
 * and distinguishing user-triggered stops from real failures.
 *
 * Why this exists:
 *   Three different catches (workflowEngine, actionExecutor, _resumeActiveTask)
 *   used to directly mutate `task.status = 'error'` and `task.errorFromStatus`.
 *   Each had subtle bugs:
 *     - missing "already in error" guard → errorFromStatus could be clobbered
 *       to 'error' itself, orphaning the task from every workflow column and
 *       making it invisible on the board;
 *     - missing isUserStop check (actionExecutor) → user-stopped tasks were
 *       being marked as errored instead of stopped;
 *     - no column validation → a stale status from an old workflow could end
 *       up in errorFromStatus, same disappearance bug.
 *   Centralising the logic here guarantees the same invariants everywhere.
 */

const USER_STOP_MESSAGE = 'Agent stopped by user';

/**
 * Detect whether an error was raised by stopAgent() aborting an in-flight
 * stream. Returns true for the exact message thrown by llmProviders and chat.
 */
export function isUserStopError(err: any): boolean {
  if (!err) return false;
  const msg = typeof err === 'string' ? err : err?.message;
  return msg === USER_STOP_MESSAGE;
}

interface MarkTaskErrorOptions {
  by: string;
  mode?: string | null;
  actionIndex?: number | null;
  agentName?: string | null;
  workflow?: { columns?: any[] } | null;
}

/**
 * Mark a task as errored while guaranteeing it remains visible on the board.
 *
 * Invariants enforced:
 *   1. If the task is already in 'error', preserve `errorFromStatus` — never
 *      overwrite it (especially with 'error' itself, which has no column).
 *   2. When setting `errorFromStatus`, validate it against the workflow's
 *      column ids when a workflow is provided; otherwise fall back to the
 *      first column. A task whose source column was renamed/deleted in the
 *      workflow editor still renders.
 *   3. Always append a history entry with the error context.
 *   4. Always clear actionRunning flags so the UI can offer recovery actions
 *      instead of a useless Stop button.
 *
 * Caller is responsible for saveTaskToDb + emit('task:updated').
 *
 * @returns true if the task was mutated (so caller can persist)
 */
export function markTaskError(task: any, message: string, opts: MarkTaskErrorOptions): boolean {
  if (!task) return false;
  const errMessage = message || 'Unknown error';
  const now = new Date().toISOString();
  const columnIds: string[] = Array.isArray(opts.workflow?.columns)
    ? opts.workflow!.columns!.map((c: any) => c?.id).filter(Boolean)
    : [];

  // Build a history entry with whatever context the caller provided.
  const historyEntry: any = {
    status: 'error',
    at: now,
    by: opts.by,
    type: 'error',
    error: errMessage,
  };
  if (opts.mode != null) historyEntry.actionMode = opts.mode;
  if (opts.actionIndex != null) historyEntry.actionIndex = opts.actionIndex;
  if (opts.agentName) historyEntry.agentName = opts.agentName;

  // Already errored: refresh the message and append the history entry, but
  // DO NOT touch errorFromStatus — that's the original column we'd lose.
  if (task.status === 'error') {
    task.error = errMessage;
    historyEntry.from = task.errorFromStatus || null;
    if (!task.history) task.history = [];
    task.history.push(historyEntry);
    return true;
  }

  const prevStatus = task.status;
  // Resolve a valid errorFromStatus. Prefer the real previous column. If it
  // isn't a known column (workflow was edited), fall back to the first one.
  let errorFrom = prevStatus;
  if (columnIds.length && (!prevStatus || !columnIds.includes(prevStatus))) {
    errorFrom = columnIds[0];
    console.warn(
      `[taskErrors] Task ${task.id} previous status "${prevStatus}" is not in the ` +
      `current workflow — using fallback column "${errorFrom}" so the task stays visible.`
    );
  }

  task.errorFromStatus = errorFrom;
  task.status = 'error';
  task.error = errMessage;
  task.actionRunning = false;
  task.actionRunningAgentId = null;
  task.actionRunningMode = null;

  historyEntry.from = prevStatus;
  if (!task.history) task.history = [];
  task.history.push(historyEntry);
  return true;
}
