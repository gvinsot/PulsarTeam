import { getPool } from './connection.js';

/**
 * Cross-replica per-task advisory locks for the workflow tick.
 *
 * When several replicas share the DB, the DB-backed workflow recheck
 * (getActiveWorkflowTasks → recheckPendingTransitions) makes every replica see
 * the same tasks, so they would race to process (and double-run) the same one.
 * Postgres session-level advisory locks coordinate them: a replica that holds
 * `pg_try_advisory_lock(hashtext(task_id))` is the one processing that task; the
 * others skip it. The in-process `_conditionProcessing` / `_processingTasks`
 * maps still guard same-process re-entrancy — this only adds the cross-replica
 * dimension.
 *
 * The lock is session-scoped, so it lives on a dedicated connection held for the
 * duration of the task's chain (a run_agent chain can run for minutes), released
 * when the chain settles. To avoid starving the shared app pool (pg default
 * max=10), concurrent held locks are capped — past the cap we skip the task this
 * tick and retry on the next one. A held lock is also released automatically if
 * the process dies (Postgres drops session locks on disconnect).
 */

// taskId -> the dedicated PoolClient holding its advisory lock.
const _heldLocks = new Map<string, any>();

// Backstop against exhausting the shared pool (default max 10): never hold more
// than this many lock connections at once. Pairs with the pool size — raise both
// together if a deployment runs many concurrent workflow agents per replica.
const MAX_CONCURRENT_TASK_LOCKS = 6;

/**
 * Try to take the cross-replica lock for a task. Returns true if acquired (the
 * caller MUST call releaseTaskLock when done) or if there is no shared DB
 * (single-process dev — nothing to coordinate). Returns false when another
 * replica/process holds it, when this process already holds it, when the
 * concurrency cap is reached, or on any error (fail safe: skip, don't double-run).
 */
export async function tryAcquireTaskLock(taskId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true; // no shared DB → no cross-replica concern
  if (_heldLocks.has(taskId)) return false; // this process is already processing it
  if (_heldLocks.size >= MAX_CONCURRENT_TASK_LOCKS) return false; // protect the pool
  let client: any;
  try {
    client = await pool.connect();
  } catch {
    return false; // pool exhausted → skip this tick (safe; retried next tick)
  }
  try {
    const r = await client.query('SELECT pg_try_advisory_lock(hashtext($1)) AS ok', [taskId]);
    if (r.rows?.[0]?.ok) {
      _heldLocks.set(taskId, client);
      return true;
    }
    client.release();
    return false; // a sibling replica holds it
  } catch {
    try { client.release(); } catch { /* already released */ }
    return false;
  }
}

/** Release a task's advisory lock + return its connection to the pool. No-op if
 *  not held (e.g. the no-DB path, or a double release). */
export async function releaseTaskLock(taskId: string): Promise<void> {
  const client = _heldLocks.get(taskId);
  if (!client) return;
  _heldLocks.delete(taskId);
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [taskId]);
  } catch {
    /* connection may be dead; release() below still returns/destroys it and
       Postgres drops the session lock when the connection closes */
  }
  try { client.release(); } catch { /* already released */ }
}

/** Number of task locks this process currently holds (for diagnostics/tests). */
export function heldTaskLockCount(): number {
  return _heldLocks.size;
}
