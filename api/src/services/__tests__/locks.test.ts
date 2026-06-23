/**
 * Cross-replica per-task advisory lock helper (database/locks.ts).
 *
 * Verifies acquire/release lifecycle, same-process re-entrancy guard, the
 * concurrency cap that protects the shared pool, the sibling-holds-it case
 * (pg_try_advisory_lock → false), and the no-DB (single-process dev) path.
 */

import test, { mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Controllable fake pool: `state.ok` decides whether pg_try_advisory_lock grants
// the lock; `state.hasPool` toggles the no-DB path; `state.released` counts
// returned connections so we can assert the connection is never leaked.
const state = { ok: true, hasPool: true, released: 0, connects: 0 };

function fakeClient() {
  return {
    query: async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ ok: state.ok }] };
      return { rows: [] }; // unlock
    },
    release: () => { state.released++; },
  };
}
const fakePool = { connect: async () => { state.connects++; return fakeClient(); } };

mock.module('../database/connection.js', {
  namedExports: {
    getPool: () => (state.hasPool ? fakePool : null),
    setPool: () => {},
    isDatabaseConnected: () => true,
    setDatabaseConnected: () => {},
  },
});

const { tryAcquireTaskLock, releaseTaskLock, heldTaskLockCount } = await import('../database/locks.js');

beforeEach(async () => {
  // Reset shared module state between tests (release anything still held).
  state.ok = true; state.hasPool = true; state.released = 0; state.connects = 0;
  for (let i = 0; i < 50; i++) await releaseTaskLock(`t${i}`);
  for (let i = 0; i < 50; i++) await releaseTaskLock(`c${i}`);
  await releaseTaskLock('task-a');
  await releaseTaskLock('task-b');
});

test('acquire then release: holds, then frees the connection + lock', async () => {
  assert.equal(await tryAcquireTaskLock('task-a'), true);
  assert.equal(heldTaskLockCount(), 1);
  await releaseTaskLock('task-a');
  assert.equal(heldTaskLockCount(), 0);
  assert.equal(state.released, 1); // connection returned to the pool
});

test('same process cannot double-acquire the same task', async () => {
  assert.equal(await tryAcquireTaskLock('task-a'), true);
  assert.equal(await tryAcquireTaskLock('task-a'), false); // already held here
  assert.equal(heldTaskLockCount(), 1);
  await releaseTaskLock('task-a');
});

test('sibling replica holds it (pg_try_advisory_lock=false): not acquired, connection released', async () => {
  state.ok = false;
  assert.equal(await tryAcquireTaskLock('task-b'), false);
  assert.equal(heldTaskLockCount(), 0);
  assert.equal(state.released, 1); // connection must not leak on a denied lock
});

test('concurrency cap: never holds more than the cap at once', async () => {
  let acquired = 0;
  for (let i = 0; i < 12; i++) {
    if (await tryAcquireTaskLock(`c${i}`)) acquired++;
  }
  // Cap is 6 (see MAX_CONCURRENT_TASK_LOCKS) — extra tasks are skipped this tick.
  assert.equal(acquired, 6);
  assert.equal(heldTaskLockCount(), 6);
  for (let i = 0; i < 12; i++) await releaseTaskLock(`c${i}`);
  assert.equal(heldTaskLockCount(), 0);
});

test('no DB (single-process dev): acquires without holding a connection', async () => {
  state.hasPool = false;
  assert.equal(await tryAcquireTaskLock('task-a'), true); // nothing to coordinate
  assert.equal(heldTaskLockCount(), 0); // no connection held
  await releaseTaskLock('task-a'); // no-op, must not throw
});

test('release of an unheld task is a no-op', async () => {
  await releaseTaskLock('never-held');
  assert.equal(heldTaskLockCount(), 0);
});
