/**
 * _pollTaskVerdict tests
 *
 * Locks in the single canonical verdict order extracted from
 * _waitForExecutionComplete's four hand-ordered check blocks (the source of the
 * "task stuck / resumed twice" bugs). The fixed priority is:
 *   completed > stopped > deleted > moved > (null = still active here)
 * and the 'completed'/'stopped' signals must be read-AND-cleared so a later poll
 * site doesn't re-trip on a stale signal. An off-column move (status !==
 * startStatus) counts as 'moved' even when the new column is itself active.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as realDb from '../database.js';

// _pollTaskVerdict only reads getTaskById; keep the rest of database.js real
// (its full export surface is needed by tasks.ts's transitive imports) and
// override just getTaskById with a mutable holder each case controls.
const dbState: { task: any } = { task: null };
mock.module('../database.js', {
  namedExports: { ...realDb, getTaskById: async () => dbState.task },
});

const { tasksMethods, setTaskSignal, getTaskSignal, clearTaskSignals, setAwaitingCompletion } =
  await import('../agentManager/tasks.js');

// Minimal `this`: only _isActiveTaskStatus is consulted by _pollTaskVerdict.
const ctx = {
  _isActiveTaskStatus: (s: string) => ['refine', 'execute', 'code', 'verify'].includes(s),
};
const poll = (taskId: string, startStatus: string | undefined) =>
  (tasksMethods as any)._pollTaskVerdict.call(ctx, taskId, 'some task text', startStatus);

test("'completed' wins and clears the completed+comment signals", async () => {
  const id = 't-completed';
  clearTaskSignals(id);
  // A resume wait registers itself as the consumer of the completion signal.
  setAwaitingCompletion(id, true);
  dbState.task = { id, status: 'execute' };
  setTaskSignal(id, 'completed', true);
  setTaskSignal(id, 'comment', 'done it');
  // stopped set too — completed still wins (higher priority)
  setTaskSignal(id, 'stopped', true);

  assert.equal(await poll(id, 'execute'), 'completed');
  assert.equal(getTaskSignal(id, 'completed'), undefined, 'completed cleared');
  assert.equal(getTaskSignal(id, 'comment'), undefined, 'comment cleared');
  // stopped left intact (only consumed when it is the winning verdict)
  assert.equal(getTaskSignal(id, 'stopped'), true);
  setAwaitingCompletion(id, false);
});

test('a completion nobody waits for is discarded, never taken as the verdict', async () => {
  // Raised by an update_task while no run awaited it (a manager, or the agent
  // after its run ended): it must not end the NEXT run of the task the moment
  // its prompt is pasted — that freed the agent while its CLI kept working.
  const id = 't-stale-completed';
  clearTaskSignals(id);
  dbState.task = { id, status: 'code' };
  setTaskSignal(id, 'completed', true);
  setTaskSignal(id, 'comment', 'old summary');

  assert.equal(await poll(id, 'code'), null);
  assert.equal(getTaskSignal(id, 'completed'), undefined, 'stale signal consumed');
  assert.equal(getTaskSignal(id, 'comment'), undefined);
});

test('a run that starts in an inactive column is not "moved" while it stays there', async () => {
  const id = 't-backlog-start';
  clearTaskSignals(id);
  dbState.task = { id, status: 'backlog' };
  assert.equal(await poll(id, 'backlog'), null);
  dbState.task = { id, status: 'code' };
  assert.equal(await poll(id, 'backlog'), 'moved');
});

test("'stopped' wins over deleted/moved and clears the stopped signal", async () => {
  const id = 't-stopped';
  clearTaskSignals(id);
  dbState.task = null; // would be 'deleted' if stopped weren't checked first
  setTaskSignal(id, 'stopped', true);

  assert.equal(await poll(id, 'execute'), 'stopped');
  assert.equal(getTaskSignal(id, 'stopped'), undefined, 'stopped cleared');
});

test("null task → 'deleted'", async () => {
  const id = 't-deleted';
  clearTaskSignals(id);
  dbState.task = null;
  assert.equal(await poll(id, 'execute'), 'deleted');
});

test("inactive status → 'moved'", async () => {
  const id = 't-inactive';
  clearTaskSignals(id);
  dbState.task = { id, status: 'done' };
  assert.equal(await poll(id, 'execute'), 'moved');
});

test("off-column move to another ACTIVE status → 'moved'", async () => {
  const id = 't-offcolumn';
  clearTaskSignals(id);
  dbState.task = { id, status: 'verify' }; // active, but != startStatus
  assert.equal(await poll(id, 'execute'), 'moved');
});

test('still active on the start column → null', async () => {
  const id = 't-active';
  clearTaskSignals(id);
  dbState.task = { id, status: 'execute' };
  assert.equal(await poll(id, 'execute'), null);
});

test('undefined startStatus never spuriously reports moved for an active task', async () => {
  const id = 't-nostart';
  clearTaskSignals(id);
  dbState.task = { id, status: 'execute' };
  assert.equal(await poll(id, undefined), null);
});

// ── _waitIntervalOrVerdict ────────────────────────────────────────────────────
// The reminder loop used to sleep the whole interval (10 min) before its first
// verdict check, so a task the agent had already moved to the next column stayed
// "busy" (column lock + agent busy flag held) until the sleep ended.

const waitCtx = { ...ctx, _pollTaskVerdict: (tasksMethods as any)._pollTaskVerdict };
const waitInterval = (taskId: string, startStatus: string | undefined, ms: number) =>
  (tasksMethods as any)._waitIntervalOrVerdict.call(
    waitCtx,
    taskId,
    'some task text',
    startStatus,
    ms
  );

test('_waitIntervalOrVerdict returns the verdict long before the interval ends', async () => {
  const id = 't-wait-early';
  clearTaskSignals(id);
  dbState.task = { id, status: 'execute' };
  setTimeout(() => {
    dbState.task = { id, status: 'verify' }; // agent moved it mid-wait
  }, 100);
  const started = Date.now();
  const verdict = await waitInterval(id, 'execute', 60_000);
  assert.equal(verdict, 'moved');
  assert.ok(Date.now() - started < 10_000, 'exited via the poll slice, not the 60s interval');
});

test('_waitIntervalOrVerdict returns null once the interval elapses on an unchanged task', async () => {
  const id = 't-wait-null';
  clearTaskSignals(id);
  dbState.task = { id, status: 'execute' };
  assert.equal(await waitInterval(id, 'execute', 50), null);
});
