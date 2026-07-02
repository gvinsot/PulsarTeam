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
  { emitAgent = true, stampUpdatedAt = false }: { emitAgent?: boolean; stampUpdatedAt?: boolean } = {},
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
  { fields = null, emitAgent = false, stampUpdatedAt = true }:
    { fields?: Record<string, any> | null; emitAgent?: boolean; stampUpdatedAt?: boolean } = {},
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
  { toStatus, now = new Date().toISOString(), full = false }: { toStatus?: string; now?: string; full?: boolean } = {},
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
