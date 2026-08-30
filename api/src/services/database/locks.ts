import type { PoolClient } from 'pg';
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
 * when the chain settles. To avoid starving the shared app pool (POOL_MAX = 20,
 * see connection.ts), concurrent held locks are capped — past the cap we skip the
 * task this tick and retry on the next one. A held lock is also released
 * automatically if the process dies (Postgres drops session locks on disconnect).
 */

// taskId -> the dedicated PoolClient holding its advisory lock.
const _heldLocks = new Map<string, PoolClient>();

// taskIds whose acquisition is IN FLIGHT. This exists because the cap below
// used to be checked and then honoured two awaits later (pool.connect, then the
// pg_try_advisory_lock query), and the caller — workflowEngine's
// _dispatchUnderLock — fires acquisitions as detached promises without awaiting
// them in sequence. Every dispatch in the same tick therefore read the same
// pre-increment size and passed: a busy board could put far more connections
// than the cap into minutes-long lock holds, starving the pool the cap exists to
// protect. The slot is now reserved here SYNCHRONOUSLY, before the first await,
// and counted against the cap until it either becomes a held lock or is given
// back.
const _acquiringLocks = new Set<string>();

// Backstop against exhausting the shared pool (POOL_MAX = 20): never hold more
// than this many lock connections at once. Pairs with the pool size — raise both
// together if a deployment runs many concurrent workflow agents per replica, and
// keep a wide margin, since these connections are held for minutes while normal
// HTTP traffic draws from the same pool.
const MAX_CONCURRENT_TASK_LOCKS = 6;

/**
 * Try to take the cross-replica lock for a task. Returns true if acquired (the
 * caller MUST call releaseTaskLock when done) or if there is no shared DB
 * (single-process dev — nothing to coordinate). Returns false when another
 * replica/process holds it, when this process already holds it or is in the
 * middle of acquiring it, when the concurrency cap is reached, or on any error
 * (fail safe: skip, don't double-run).
 */
export async function tryAcquireTaskLock(taskId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true; // no shared DB → no cross-replica concern

  // ─── This block must stay synchronous: no await between the cap test and the
  // reservation, or concurrent callers all read the same size and all pass.
  if (_heldLocks.has(taskId) || _acquiringLocks.has(taskId)) return false;
  if (_heldLocks.size + _acquiringLocks.size >= MAX_CONCURRENT_TASK_LOCKS) return false;
  _acquiringLocks.add(taskId);
  // ───────────────────────────────────────────────────────────────────────────

  try {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch {
      // Pool exhausted or the checkout timed out (connectionTimeoutMillis) →
      // skip this tick; safe, the task is retried on the next one.
      return false;
    }
    try {
      const r = await client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock(hashtext($1)) AS ok',
        [taskId]
      );
      if (r.rows[0]?.ok) {
        // Hand the reservation over to _heldLocks. No await separates the two,
        // so the pair is never observed as double-counted, nor as a gap.
        _heldLocks.set(taskId, client);
        return true;
      }
      client.release();
      return false; // a sibling replica holds it
    } catch {
      try {
        client.release();
      } catch {
        /* already released */
      }
      return false;
    }
  } finally {
    // Give the slot back on EVERY path — granted (it is now a held lock),
    // denied, connect failure, and thrown exception. A reservation that leaked
    // would shrink the cap permanently and eventually block the workflow tick
    // outright: a counter that leaks is worse than no counter.
    _acquiringLocks.delete(taskId);
  }
}

/** Release a task's advisory lock + return its connection to the pool. No-op if
 *  not held (e.g. the no-DB path, or a double release). */
export async function releaseTaskLock(taskId: string): Promise<void> {
  const client = _heldLocks.get(taskId);
  if (!client) return;
  // Delete FIRST (synchronously): the slot is freed for the next tick even if
  // the unlock below hangs or throws.
  _heldLocks.delete(taskId);
  try {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [taskId]);
  } catch {
    /* connection may be dead; release() below still returns/destroys it and
       Postgres drops the session lock when the connection closes */
  }
  try {
    client.release();
  } catch {
    /* already released */
  }
}

/** Number of task locks this process currently holds (for diagnostics/tests).
 *  In-flight acquisitions are deliberately not counted — this reports locks
 *  actually held, not slots reserved against the cap. */
export function heldTaskLockCount(): number {
  return _heldLocks.size;
}
