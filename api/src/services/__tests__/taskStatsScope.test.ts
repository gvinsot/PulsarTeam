// ── Project statistics count board-level tasks ────────────────────────────────
//
// Kanban tasks are board-level (agent_id NULL). The Analytics › Statistics tab
// used to count only agent-owned tasks, so it rendered empty for most projects.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const realDb = await import('../database.js');
const BOARD_A = 'board-a';
const BOARD_B = 'board-b';
const now = new Date().toISOString();
const tasks = [
  {
    id: 't1',
    agentId: null,
    boardId: BOARD_A,
    project: 'P1',
    status: 'done',
    taskType: 'bug',
    createdAt: now,
    history: [],
  },
  {
    id: 't2',
    agentId: null,
    boardId: BOARD_A,
    project: 'P1',
    status: 'backlog',
    createdAt: now,
    history: [],
  },
  {
    id: 't3',
    agentId: 'agent-1',
    boardId: BOARD_B,
    project: 'P2',
    status: 'backlog',
    createdAt: now,
    history: [],
  },
  {
    id: 't4',
    agentId: 'ghost',
    boardId: null,
    project: null,
    status: 'backlog',
    createdAt: now,
    history: [],
  },
];

mock.module('../database.js', {
  exports: { ...realDb, getAllTasks: async () => tasks },
});

const { taskStatsMethods } = await import('../agentManager/taskStats.js');
const manager: any = {
  agents: new Map([['agent-1', { id: 'agent-1', name: 'A1', boardId: BOARD_B }]]),
  ...taskStatsMethods,
};

test('board-level tasks are counted for their project', async () => {
  const stats = await manager.getTaskStats('P1');
  assert.equal(stats.total, 2);
  assert.equal(stats.byType.bug, 1);
});

test('without a project filter every reachable task counts; orphans are skipped', async () => {
  const ids = (await manager._collectTasks(null, null)).map((t: any) => t.id).sort();
  assert.deepEqual(ids, ['t1', 't2', 't3']);
});

test('board access scopes the tasks for non-admins', async () => {
  const ids = (await manager._collectTasks(null, new Set([BOARD_B]))).map((t: any) => t.id);
  assert.deepEqual(ids, ['t3']);
});
