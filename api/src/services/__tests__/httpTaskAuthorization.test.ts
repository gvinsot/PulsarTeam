// ── HTTP task authorization (routes/tasks.ts requireTaskAccess) ──────────────
//
// The websocket twin of these tests is socketTaskAuthorization.test.ts; this
// file states the same policy for the /tasks REST routes, which used to be
// fail-OPEN on two cases the socket path already closed:
//
//   • an agent whose `ownerId` is NULL — agents created before the column
//     existed, or whose owner row was deleted (`agents.owner_id` is
//     `ON DELETE SET NULL`, services/database/baseSchema.ts) — granted every
//     authenticated user read/edit/delete on that agent's tasks, across tenants;
//   • a task with neither agent nor board was open to everyone "so it stays
//     deletable".
//
// Only DB access and the transport are faked: the authorization code under test
// (requireTaskAccess → checkBoardAccess / checkAgentAccess) is the real one.

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { SessionClaims } from '../../middleware/session.js';
import { createRouteHarness } from './helpers/routeHarness.js';
import { makeTaskDbFake } from './helpers/taskDbFake.js';

const realDb = await import('../database.js');
const { rows, exports: taskDb } = makeTaskDbFake();
const boards = new Map<string, { id: string; user_id: string }>();
const shares = new Map<string, { permission: string }>();
let failBoardLookup = false;

mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...taskDb,
    // Pool-less: auditLog and the `deleted_by` write both no-op, which keeps
    // these tests about the guard rather than about SQL.
    getPool: () => null,
    getOAuthToken: () => null,
    getBoardById: async (id: string) => {
      if (failBoardLookup) throw new Error('Database unavailable');
      return boards.get(id) || null;
    },
    getBoardShare: async (id: string, userId: string) => shares.get(`${id}:${userId}`) || null,
    getBoardsByUser: async () => [...boards.values()],
  },
});

const tasksRouter = (await import('../../routes/tasks.js')).default;

const alice: SessionClaims = { userId: 'alice', username: 'alice', role: 'advanced', csrf: 'test' };
const admin: SessionClaims = { userId: 'root', username: 'root', role: 'admin', csrf: 'test' };

const deleteTask = mock.fn(async (_agentId: string | null, taskId: string) =>
  taskDb.deleteTaskFromDb(taskId)
);

/** Agents as `agentManager.agents` holds them — the shapes the guard reads. */
function makeAgents() {
  return new Map<string, { id: string; ownerId: string | null; boardId: string | null }>([
    ['alice-agent', { id: 'alice-agent', ownerId: 'alice', boardId: null }],
    ['bob-agent', { id: 'bob-agent', ownerId: 'bob', boardId: null }],
    // The regression subject: owner_id dropped back to NULL by ON DELETE SET
    // NULL, or never set because the agent predates the column.
    ['legacy-agent', { id: 'legacy-agent', ownerId: null, boardId: null }],
  ]);
}

const manager = {
  agents: makeAgents(),
  getTask: (id: string) => taskDb.getTaskById(id),
  deleteTask,
  _isActiveTaskStatus: (status: string) => status === 'execute',
  _emit: mock.fn(),
  _taskResumeFailures: new Map(),
};

/** Mounts the real tasks router with the fake manager on `req.app`. */
function harness(user: SessionClaims = alice) {
  const mounted = express.Router();
  mounted.use((req, _res, next) => {
    req.app.set('agentManager', manager);
    next();
  });
  mounted.use(tasksRouter);
  return createRouteHarness(mounted, user);
}

function seedTask(boardId: string | null = 'bob-board', agentId: string | null = 'bob-agent') {
  const task = {
    id: 'task',
    text: 'Confidential task content',
    title: 'Confidential title',
    status: 'backlog',
    history: [{ action: 'created', by: 'bob', detail: 'Confidential history entry' }],
    boardId,
    agentId,
  };
  rows.set(task.id, task);
  return task;
}

beforeEach(() => {
  rows.clear();
  boards.clear();
  shares.clear();
  deleteTask.mock.resetCalls();
  manager._emit.mock.resetCalls();
  manager.agents = makeAgents();
  failBoardLookup = false;
  boards.set('alice-board', { id: 'alice-board', user_id: 'alice' });
  boards.set('bob-board', { id: 'bob-board', user_id: 'bob' });
});

/** The task survived untouched and nothing confidential reached the caller. */
async function assertDenied(res: Response, status = 403) {
  const body = await res.text();
  assert.equal(res.status, status);
  assert.ok(!body.includes('Confidential'), `leaked task content: ${body}`);
  assert.equal(deleteTask.mock.callCount(), 0);
  assert.equal(rows.get('task')?.deletedAt, undefined);
  assert.equal(rows.get('task')?.title, 'Confidential title');
}

// ── The regression: agents with no owner ────────────────────────────────────

test('agent without ownerId does not grant another tenant task', async () => {
  for (const boardId of ['bob-board', 'missing-board']) {
    seedTask(boardId, 'legacy-agent');
    await assertDenied(await harness().del('/task'));
    await assertDenied(await harness().get('/task/history'));
    await assertDenied(await harness().put('/task', { title: 'pwned' }));
  }
});

test('agent without ownerId does not grant a board-less task either', async () => {
  seedTask(null, 'legacy-agent');
  await assertDenied(await harness().del('/task'));
  await assertDenied(await harness().get('/task/history'));
  // Case 3 of the documented policy (lib/agentAccess.ts): admin only.
  const res = await harness(admin).del('/task');
  assert.equal(res.status, 200);
  assert.equal(deleteTask.mock.callCount(), 1);
});

test('a read-only board share never grants task edit, whoever owns the agent', async () => {
  shares.set('bob-board:alice', { permission: 'read' });
  for (const agentId of ['bob-agent', 'legacy-agent', 'alice-agent', null]) {
    seedTask('bob-board', agentId);
    await assertDenied(await harness().del('/task'));
  }
});

test('an owned agent does not override the board the task lives on', async () => {
  // Mirrors "own agent cannot execute another tenant task, even when it owns
  // the task record" on the socket side.
  seedTask('bob-board', 'alice-agent');
  await assertDenied(await harness().del('/task'));
  await assertDenied(await harness().get('/task/history'));
});

test('orphaned tasks (no agent, no board) are admin-only, not world-writable', async () => {
  seedTask(null, null);
  await assertDenied(await harness().del('/task'));
  seedTask(null, 'missing-agent');
  await assertDenied(await harness().del('/task'));
  seedTask(null, null);
  assert.equal((await harness(admin).del('/task')).status, 200);
});

// ── The grants that must keep working ───────────────────────────────────────

test('board owner, editor and system admin can act on a task', async () => {
  for (const grant of ['owner', 'editor', 'admin'] as const) {
    deleteTask.mock.resetCalls();
    shares.clear();
    seedTask(grant === 'owner' ? 'alice-board' : 'bob-board', 'bob-agent');
    if (grant === 'editor') shares.set('bob-board:alice', { permission: 'edit' });
    const res = await harness(grant === 'admin' ? admin : alice).del('/task');
    assert.equal(res.status, 200, `${grant} should be allowed`);
    assert.equal(deleteTask.mock.callCount(), 1);
    assert.ok(rows.get('task').deletedAt);
  }
});

test('board-less task falls back to its owning agent', async () => {
  seedTask(null, 'alice-agent');
  assert.equal((await harness().del('/task')).status, 200);
  assert.equal(deleteTask.mock.callCount(), 1);

  deleteTask.mock.resetCalls();
  seedTask(null, 'bob-agent');
  await assertDenied(await harness().del('/task'));
});

test('a board-scoped agent defers to its board, at edit level', async () => {
  // checkAgentAccess case 1: the agent carries a boardId of its own.
  manager.agents.set('alice-agent', { id: 'alice-agent', ownerId: 'alice', boardId: 'bob-board' });
  shares.set('bob-board:alice', { permission: 'read' });
  seedTask(null, 'alice-agent');
  await assertDenied(await harness().del('/task'));

  shares.set('bob-board:alice', { permission: 'edit' });
  assert.equal((await harness().del('/task')).status, 200);
});

// ── Fail-closed on the error paths ──────────────────────────────────────────

test('missing board and authorization database failures fail closed', async () => {
  seedTask('missing-board', 'bob-agent');
  await assertDenied(await harness().del('/task'));

  failBoardLookup = true;
  seedTask('bob-board', 'bob-agent');
  // asyncHandler forwards the rejection: a 500, never a grant.
  const res = await harness().del('/task');
  assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
  assert.equal(deleteTask.mock.callCount(), 0);
  assert.equal(rows.get('task')?.deletedAt, undefined);
});

test('ownerless agent cannot stop, resume, inspect commits or bulk-move a foreign task', async () => {
  const task = seedTask('bob-board', 'legacy-agent');
  Object.assign(task, { executionStatus: 'stopped', actionRunning: true });
  const original = structuredClone(task);
  await assertDenied(await harness().post('/task/stop'));
  await assertDenied(await harness().patch('/task/clear-stopped'));
  await assertDenied(await harness().get('/task/commits/abcdef0/diff'));
  assert.deepEqual(rows.get('task'), original);
  assert.equal(manager._emit.mock.callCount(), 0);

  // bulk-move validates UUIDs and destination access before checking each source task.
  const taskId = '11111111-1111-4111-8111-111111111111';
  const boardId = '22222222-2222-4222-8222-222222222222';
  boards.set(boardId, { id: boardId, user_id: 'alice' });
  rows.delete('task');
  task.id = taskId;
  rows.set(taskId, task);
  const beforeMove = structuredClone(task);
  const response = await harness().post('/bulk-move', { taskIds: [taskId], boardId });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    moved: [],
    failed: [{ taskId, error: 'Access denied' }],
  });
  assert.deepEqual(rows.get(taskId), beforeMove);
  // The batch summary contains no task data and reports zero moves.
  assert.deepEqual(
    manager._emit.mock.calls.map(call => call.arguments),
    [['task:bulk-moved', { boardId, boardName: null, column: 'todo', count: 0, movedBy: 'alice' }]]
  );
});

test('revoked board share is checked again even when the caller owns the agent', async () => {
  const original = structuredClone(seedTask('bob-board', 'alice-agent'));
  shares.set('bob-board:alice', { permission: 'edit' });
  assert.equal((await harness().get('/task/history')).status, 200);
  shares.clear();
  await assertDenied(await harness().get('/task/history'));
  await assertDenied(await harness().del('/task'));
  assert.deepEqual(rows.get('task'), original);
});
