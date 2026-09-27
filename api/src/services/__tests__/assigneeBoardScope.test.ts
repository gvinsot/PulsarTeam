// ── Invariant: a task's assignee belongs to the task's own board ─────────────
//
// da66792 enforced this on PUT /tasks/:id's `agentId` edit only. These tests
// pin the three other write paths that could still produce a cross-board
// assignee:
//
//   1. PATCH /agents/:id/tasks/:taskId/assignee (agentManager.setTaskAssignee)
//   2. POST  /agents/:id/tasks/:taskId/transfer (agentManager.transferTask)
//   3. PUT   /tasks/:id moving the task to another board whose first column has
//      the SAME id as the current status (so no status change unassigns it).
//
//   4. The workflow action assign_agent_individual.
//
// The MCP paths (delegate_task, start_task/resume_task with agent_id) are
// pinned in mcpOperations.test.ts, which has the MCP client harness.
//
// Only the DB and transport are faked; routes and mutators are the real ones.

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { SessionClaims } from '../../middleware/session.js';
import { createRouteHarness } from './helpers/routeHarness.js';
import { makeTaskDbFake } from './helpers/taskDbFake.js';

const realDb = await import('../database.js');
const { rows, exports: taskDb } = makeTaskDbFake();
const BOARD_A = '00000000-0000-4000-8000-00000000000a';
const BOARD_B = '00000000-0000-4000-8000-00000000000b';
const AGENT_A = '00000000-0000-4000-8000-0000000000a1';
const AGENT_A2 = '00000000-0000-4000-8000-0000000000a2';
const AGENT_B = '00000000-0000-4000-8000-0000000000b1';
const AGENT_FREE = '00000000-0000-4000-8000-0000000000f1';
const workflow = { columns: [{ id: 'backlog' }, { id: 'done' }] };
const boards = new Map<string, any>([
  [BOARD_A, { id: BOARD_A, user_id: 'root', name: 'A', workflow }],
  [BOARD_B, { id: BOARD_B, user_id: 'root', name: 'B', workflow }],
]);

mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...taskDb,
    getPool: () => null,
    getOAuthToken: () => null,
    getBoardById: async (id: string) => boards.get(id) || null,
    getBoardShare: async () => null,
    getBoardsByUser: async () => [...boards.values()],
  },
});

const tasksRouter = (await import('../../routes/tasks.js')).default;
const { agentRoutes } = await import('../../routes/agents.js');
const { tasksMethods } = await import('../agentManager/tasks.js');
const { executeAction } = await import('../workflow/actionExecutor.js');

const admin: SessionClaims = { userId: 'root', username: 'root', role: 'admin', csrf: 'test' };

function makeManager() {
  const mgr: any = {
    agents: new Map<string, any>([
      [AGENT_A, { id: AGENT_A, name: 'A1', ownerId: 'root', boardId: BOARD_A }],
      [AGENT_A2, { id: AGENT_A2, name: 'A2', ownerId: 'root', boardId: BOARD_A }],
      [AGENT_B, { id: AGENT_B, name: 'B1', ownerId: 'root', boardId: BOARD_B }],
      [AGENT_FREE, { id: AGENT_FREE, name: 'Free', ownerId: 'root', boardId: null }],
    ]),
    getTask: (id: string) => taskDb.getTaskById(id),
    saveTaskDirectly: (task: any) => taskDb.saveTaskToDb(task),
    setTaskAssignee: tasksMethods.setTaskAssignee,
    transferTask: tasksMethods.transferTask,
    // transferTask re-creates the row through addTask; a minimal stand-in.
    addTask: async (agentId: string, text: string, _src: any, status: string, extra: any) => {
      const task = { id: 'task-new', text, status, agentId, ...extra };
      rows.set(task.id, task);
      return task;
    },
    _isActiveTaskStatus: () => false,
    _emit: mock.fn(),
    _sanitize: (a: any) => a,
    _checkAutoRefine: mock.fn(),
    _recheckConditionalTransitions: mock.fn(),
    _taskResumeFailures: new Map(),
  };
  return mgr;
}
let manager = makeManager();

function tasksApi() {
  const mounted = express.Router();
  mounted.use((req, _res, next) => {
    req.app.set('agentManager', manager);
    next();
  });
  mounted.use(tasksRouter);
  return createRouteHarness(mounted, admin);
}
const agentsApi = () => createRouteHarness(agentRoutes(manager), admin);

beforeEach(() => {
  rows.clear();
  manager = makeManager();
  rows.set('task', {
    id: 'task',
    text: 'body',
    title: 'title',
    status: 'backlog',
    boardId: BOARD_A,
    agentId: AGENT_A,
    assignee: AGENT_A,
    history: [],
  });
});

// ── 1. PATCH assignee ───────────────────────────────────────────────────────

test('PATCH assignee refuses an agent from another board', async () => {
  const res = await agentsApi().patch(`/${AGENT_A}/tasks/task/assignee`, { assigneeId: AGENT_B });
  assert.equal(res.status, 400);
  assert.match((await res.json()).error, /does not belong to this task's board/);
  assert.equal(rows.get('task').assignee, AGENT_A);
});

test('PATCH assignee accepts a same-board agent and still allows unassigning', async () => {
  const ok = await agentsApi().patch(`/${AGENT_A}/tasks/task/assignee`, { assigneeId: AGENT_A2 });
  assert.equal(ok.status, 200);
  assert.equal(rows.get('task').assignee, AGENT_A2);

  const cleared = await agentsApi().patch(`/${AGENT_A}/tasks/task/assignee`, { assigneeId: null });
  assert.equal(cleared.status, 200);
  assert.equal(rows.get('task').assignee, null);
});

test('setTaskAssignee itself refuses a cross-board assignee', async () => {
  await assert.rejects(
    manager.setTaskAssignee(AGENT_A, 'task', AGENT_B),
    /does not belong to this task's board/
  );
  assert.equal(rows.get('task').assignee, AGENT_A);
});

// ── 2. Transfer ─────────────────────────────────────────────────────────────

test('transfer to an agent of another board is refused and the task is kept', async () => {
  const res = await agentsApi().post(`/${AGENT_A}/tasks/task/transfer`, { targetAgentId: AGENT_B });
  assert.equal(res.status, 400);
  assert.ok(rows.get('task'), 'the original task must not be deleted');
  assert.equal(rows.get('task').deletedAt, undefined);
  assert.equal(rows.has('task-new'), false);
});

test('transferTask itself refuses before deleting the source row', async () => {
  await assert.rejects(manager.transferTask(AGENT_A, 'task', AGENT_B));
  assert.equal(rows.get('task').deletedAt, undefined);
});

test('transfer to a same-board agent still works', async () => {
  const res = await agentsApi().post(`/${AGENT_A}/tasks/task/transfer`, {
    targetAgentId: AGENT_A2,
  });
  assert.equal(res.status, 201);
  const moved = rows.get('task-new');
  assert.equal(moved.boardId, BOARD_A);
  assert.equal(moved.assignee, AGENT_A2);
});

// ── 3. Board move without a column change ───────────────────────────────────

test('moving a task to another board drops the old board assignee even if the column id matches', async () => {
  const res = await tasksApi().put('/task', { boardId: BOARD_B });
  assert.equal(res.status, 200);
  const task = rows.get('task');
  assert.equal(task.boardId, BOARD_B);
  assert.equal(task.status, 'backlog', 'first column of board-b has the same id');
  assert.equal(task.assignee, null);
  const entry = task.history.at(-1);
  assert.equal(entry.type, 'board_move');
  assert.equal(entry.previousAssignee, AGENT_A);

  // The task stays editable afterwards (no stale cross-board assignee to trip on).
  const edit = await tasksApi().put('/task', { title: 'renamed' });
  assert.equal(edit.status, 200);
});

test('a board move with an explicit assignee validates it against the TARGET board', async () => {
  const wrong = await tasksApi().put('/task', { boardId: BOARD_B, agentId: AGENT_A2 });
  assert.equal(wrong.status, 400);
  assert.equal(rows.get('task').boardId, BOARD_A);

  const right = await tasksApi().put('/task', { boardId: BOARD_B, agentId: AGENT_B });
  assert.equal(right.status, 200);
  assert.equal(rows.get('task').boardId, BOARD_B);
  assert.equal(rows.get('task').assignee, AGENT_B);
});

test('a board move that re-sends the current (old-board) assignee still drops it', async () => {
  const res = await tasksApi().put('/task', { boardId: BOARD_B, agentId: AGENT_A });
  assert.equal(res.status, 200);
  assert.equal(rows.get('task').boardId, BOARD_B);
  assert.equal(rows.get('task').assignee, null);
});

// ── 4. Workflow assign_agent_individual ─────────────────────────────────────

function assignIndividually(agentId: string, task: any) {
  return executeAction({ type: 'assign_agent_individual', agentId } as any, task, {
    agentManager: manager,
    io: null as any,
    ownerId: 'root',
    workflow: workflow as any,
  });
}

test('assign_agent_individual skips an agent of another board and persists nothing', async () => {
  const task = { ...rows.get('task') };
  const result = await assignIndividually(AGENT_B, task);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'agent-off-board');
  assert.equal(task.assignee, AGENT_A);
  assert.equal(rows.get('task').assignee, AGENT_A);
});

test('assign_agent_individual still accepts same-board and board-less agents', async () => {
  const same = await assignIndividually(AGENT_A2, { ...rows.get('task') });
  assert.equal(same.executed, true);
  await new Promise(r => setImmediate(r));
  assert.equal(rows.get('task').assignee, AGENT_A2);

  const free = await assignIndividually(AGENT_FREE, { ...rows.get('task') });
  assert.equal(free.executed, true);
  await new Promise(r => setImmediate(r));
  assert.equal(rows.get('task').assignee, AGENT_FREE);
});

test('assign_agent_individual on a board-less task accepts any agent', async () => {
  rows.get('task').boardId = null;
  const result = await assignIndividually(AGENT_B, { ...rows.get('task') });
  assert.equal(result.executed, true);
});
