import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import type { AgentManager } from '../agentManager/index.js';
import { setPool } from '../database/connection.js';
import { getUnseenTaskCounts, markTaskHumanViewed } from '../database/taskViews.js';
import { createRouteHarness } from './helpers/routeHarness.js';

const realDb = await import('../database.js');
const viewedAt = '2026-09-16T12:00:00.000Z';
const task = { id: 'task', boardId: 'shared', agentId: null, source: { type: 'mcp' } };
let viewed = false;
let taskBoard = 'shared';
const countBoards: string[][] = [];
const writes: unknown[][] = [];

mock.module('../database.js', {
  namedExports: {
    ...realDb,
    getBoardsByUser: async () => [{ id: 'owned' }, { id: 'shared' }],
    getBoardById: async (id: string) => ({ id, user_id: id === 'owned' ? 'alice' : 'bob' }),
    getBoardShare: async (id: string) => (id === 'shared' ? { permission: 'read' } : null),
    getTaskById: async (id: string) =>
      id === task.id
        ? { ...task, boardId: taskBoard, humanViewedAt: viewed ? viewedAt : null }
        : null,
  },
});
const { boardRoutes } = await import('../../routes/boards.js');
const emit = mock.fn();
const manager = { agents: new Map(), _emit: emit } as unknown as AgentManager;
const harness = createRouteHarness(boardRoutes(manager), {
  userId: 'alice',
  username: 'alice',
  role: 'basic',
  csrf: 'test',
});
const browser = { headers: { cookie: 'pt_session=test-session' } };

beforeEach(() => {
  viewed = false;
  taskBoard = 'shared';
  countBoards.length = 0;
  writes.length = 0;
  emit.mock.resetCalls();
  // Only transport/DB are faked. The route and board authorization are real.
  setPool({
    query: async (sql: string, params: unknown[]) => {
      if (sql.startsWith('SELECT board_id')) {
        countBoards.push(params[0] as string[]);
        return { rows: [{ board_id: 'shared', count: viewed ? 1 : 2 }] };
      }
      assert.match(sql, /^UPDATE tasks SET human_viewed_at = NOW\(\)/);
      writes.push(params);
      if (viewed) return { rows: [] };
      viewed = true;
      return { rows: [{ id: 'task' }] };
    },
  } as unknown as Pool);
});

test.afterEach(() => setPool(null));

test('counts are scoped to owned/shared boards and listing never acknowledges tasks', async () => {
  const response = await harness.get('/unseen-task-counts');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { shared: 2 });
  assert.deepEqual(countBoards, [['owned', 'shared']]);
  assert.equal((await harness.get('/shared')).status, 200);
  assert.equal(writes.length, 0);
});

test('read-only member can acknowledge exactly one task; repeated views are idempotent', async () => {
  for (let i = 0; i < 2; i++) {
    const response = await harness.post('/shared/tasks/task/viewed', {}, browser);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true });
  }
  assert.deepEqual(writes, [
    ['task', 'shared'],
    ['task', 'shared'],
  ]);
  assert.equal(emit.mock.callCount(), 1);
  assert.equal(emit.mock.calls[0].arguments[0], 'task:updated');
  assert.equal(emit.mock.calls[0].arguments[1].task.humanViewedAt, viewedAt);
  const response = await harness.get('/unseen-task-counts');
  assert.deepEqual(await response.json(), { shared: 1 });
});

test('API and service sessions cannot acknowledge views, even with an ambient cookie', async () => {
  for (const options of [
    {},
    { headers: { authorization: 'Bearer test' } },
    { headers: { ...browser.headers, authorization: 'Bearer test' } },
  ]) {
    assert.equal((await harness.post('/shared/tasks/task/viewed', {}, options)).status, 403);
  }
  const service = harness.as({ userId: '', username: 'internal-mcp', role: 'admin', csrf: '' });
  assert.equal((await service.post('/shared/tasks/task/viewed', {}, browser)).status, 403);
  assert.equal(writes.length, 0);
});

test('foreign boards, mismatched task boards and missing tasks cannot be acknowledged', async () => {
  assert.equal((await harness.post('/foreign/tasks/task/viewed', {}, browser)).status, 403);
  assert.equal((await harness.post('/owned/tasks/task/viewed', {}, browser)).status, 404);
  assert.equal((await harness.post('/shared/tasks/missing/viewed', {}, browser)).status, 404);
  taskBoard = 'foreign';
  assert.equal((await harness.post('/shared/tasks/task/viewed', {}, browser)).status, 404);
  assert.equal(writes.length, 0);
});

test('SQL counts and atomic acknowledgement exclude human sources, deleted tasks and templates', async () => {
  const queries: string[] = [];
  setPool({
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as Pool);
  assert.deepEqual(await getUnseenTaskCounts([]), {});
  assert.equal(queries.length, 0);
  assert.deepEqual(await getUnseenTaskCounts(['board']), {});
  assert.equal(await markTaskHumanViewed('board', 'task'), false);
  for (const sql of queries) {
    assert.match(sql, /human_viewed_at IS NULL/);
    assert.match(sql, /source->>'type' IN \('mcp', 'api'\)/);
    assert.match(sql, /deleted_at IS NULL AND is_template IS NOT TRUE/);
  }
  assert.match(queries[0], /board_id = ANY\(\$1::uuid\[\]\)/);
  assert.match(queries[1], /id = \$1 AND board_id = \$2/);
});

test('database failures are not reported as a successful acknowledgement or zero counts', async () => {
  setPool(null);
  await assert.rejects(markTaskHumanViewed('shared', 'task'), /Database not connected/);
  await assert.rejects(getUnseenTaskCounts(['shared']), /Database not connected/);
});

test('task reads expose the persisted human view timestamp for card indicators', () => {
  const row = {
    id: 'task',
    created_at: null,
    updated_at: null,
    completed_at: null,
    started_at: null,
    deleted_at: null,
    human_viewed_at: null,
  } as Parameters<typeof realDb.rowToTask>[0];
  assert.equal(realDb.rowToTask(row).humanViewedAt, null);
  assert.equal(
    realDb.rowToTask({ ...row, human_viewed_at: new Date(viewedAt) }).humanViewedAt,
    viewedAt
  );
});
