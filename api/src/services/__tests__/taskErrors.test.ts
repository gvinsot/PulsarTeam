/**
 * taskErrors tests
 *
 * Locks in the invariants of markTaskError + isUserStopError:
 *
 *  - A task whose status is set to 'error' must always have an
 *    errorFromStatus that maps to a real workflow column. Otherwise the
 *    frontend's kanban grouping cannot place it anywhere and it disappears
 *    from the board.
 *  - The "already errored" path must NEVER clobber errorFromStatus (would
 *    overwrite the original column with 'error', same disappearance bug).
 *  - User-stop must be detected so callers can short-circuit error handling
 *    on a stopped task.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { markTaskError, isUserStopError } from '../workflow/taskErrors.js';

function makeWorkflow(colIds: string[]) {
  return { columns: colIds.map(id => ({ id, label: id })) };
}

test('isUserStopError matches the exact stop message', () => {
  assert.equal(isUserStopError(new Error('Agent stopped by user')), true);
  assert.equal(isUserStopError({ message: 'Agent stopped by user' }), true);
  assert.equal(isUserStopError('Agent stopped by user'), true);
});

test('isUserStopError rejects unrelated errors and falsy inputs', () => {
  assert.equal(isUserStopError(new Error('Network failure')), false);
  assert.equal(isUserStopError(new Error('')), false);
  assert.equal(isUserStopError(null), false);
  assert.equal(isUserStopError(undefined), false);
  assert.equal(isUserStopError({}), false);
});

test('markTaskError flips an active task to error and records errorFromStatus', () => {
  const task: any = { id: 't1', status: 'code', history: [] };
  const workflow = makeWorkflow(['backlog', 'code', 'done']);

  const mutated = markTaskError(task, 'boom', { by: 'workflow', workflow });

  assert.equal(mutated, true);
  assert.equal(task.status, 'error');
  assert.equal(task.errorFromStatus, 'code');
  assert.equal(task.error, 'boom');
  assert.equal(task.actionRunning, false);
  assert.equal(task.history.length, 1);
  assert.equal(task.history[0].type, 'error');
  assert.equal(task.history[0].from, 'code');
});

test('markTaskError NEVER overwrites errorFromStatus on a task already in error', () => {
  // This is the core "tasks disappear from boards" bug: if the catch fires
  // twice (or fires on a task that was already errored), the previous valid
  // errorFromStatus must be preserved. Setting it to 'error' (the current
  // status) would orphan the task from every column on the frontend.
  const task: any = {
    id: 't1',
    status: 'error',
    errorFromStatus: 'code',
    error: 'first failure',
    history: [{ type: 'error', from: 'code', at: '2026-01-01T00:00:00Z' }],
  };
  const workflow = makeWorkflow(['backlog', 'code', 'done']);

  const mutated = markTaskError(task, 'second failure', { by: 'workflow', workflow });

  assert.equal(mutated, true);
  assert.equal(task.status, 'error');
  // Critically: errorFromStatus stays at 'code', not 'error'.
  assert.equal(task.errorFromStatus, 'code');
  assert.equal(task.error, 'second failure');
  assert.equal(task.history.length, 2);
  assert.equal(task.history[1].from, 'code');
});

test('markTaskError falls back to first column when prevStatus is not a real column', () => {
  // Scenario: workflow column was renamed/deleted in the editor; the task
  // still carries the old status. Without the fallback, errorFromStatus
  // would be set to a stale string that no column matches → invisible task.
  const task: any = { id: 't1', status: 'old-renamed-column', history: [] };
  const workflow = makeWorkflow(['backlog', 'code', 'done']);

  const mutated = markTaskError(task, 'boom', { by: 'workflow', workflow });

  assert.equal(mutated, true);
  assert.equal(task.status, 'error');
  // Fell back to the first column so the task remains visible.
  assert.equal(task.errorFromStatus, 'backlog');
});

test('markTaskError skips column validation when no workflow is provided', () => {
  const task: any = { id: 't1', status: 'code', history: [] };
  const mutated = markTaskError(task, 'boom', { by: 'workflow' });
  assert.equal(mutated, true);
  // No workflow → no validation → errorFromStatus mirrors prevStatus as-is.
  assert.equal(task.errorFromStatus, 'code');
});

test('markTaskError clears actionRunning flags so UI can offer recovery', () => {
  const task: any = {
    id: 't1',
    status: 'code',
    actionRunning: true,
    actionRunningAgentId: 'a1',
    actionRunningMode: 'decide',
    history: [],
  };

  markTaskError(task, 'boom', { by: 'workflow' });

  assert.equal(task.actionRunning, false);
  assert.equal(task.actionRunningAgentId, null);
  assert.equal(task.actionRunningMode, null);
});

test('markTaskError attaches optional context (mode, actionIndex, agentName)', () => {
  const task: any = { id: 't1', status: 'code', history: [] };
  markTaskError(task, 'boom', {
    by: 'agent-1',
    mode: 'decide',
    actionIndex: 2,
    agentName: 'Worker',
  });
  const entry = task.history[0];
  assert.equal(entry.actionMode, 'decide');
  assert.equal(entry.actionIndex, 2);
  assert.equal(entry.agentName, 'Worker');
});

test('markTaskError returns false on null task', () => {
  assert.equal(markTaskError(null, 'boom', { by: 'workflow' }), false);
});
