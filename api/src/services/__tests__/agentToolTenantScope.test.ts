// Tenancy of the LISTING tools an agent can reach on its own.
//
// lib/agentAccess.ts guards "who may act as this agent"; lib/agentScope.ts is
// the mirror — what the agent may see once it runs. These tests pin the three
// cases and the four surfaces that used to answer "the whole instance": the
// native list_boards / list_tasks / list_projects tools, and the project list
// injected into a leader's prompt.

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

const BOARD_A = { id: 'board-a', name: 'Alpha', workflow: { columns: [{ id: 'todo' }] } };
const BOARD_B = { id: 'board-b', name: 'Prolipsy', workflow: { columns: [{ id: 'todo' }] } };

const REPOS_BY_BOARD: Record<string, any[]> = {
  'board-a': [{ provider: 'github', fullName: 'acme/alpha', full_name: 'acme/alpha' }],
  'board-b': [{ provider: 'github', fullName: 'acme/prolipsy', full_name: 'acme/prolipsy' }],
};

const TASKS = [
  { id: 'task-1111', text: 'On my board', status: 'todo', boardId: 'board-a' },
  { id: 'task-2222', text: 'Someone else', status: 'todo', boardId: 'board-b' },
];

let accessibleBoardReposCalls = 0;

mock.module('../database.js', {
  namedExports: {
    getAllBoards: async () => [BOARD_A, BOARD_B],
    getBoardById: async (id: string) => [BOARD_A, BOARD_B].find(b => b.id === id) || null,
    getTasksByStatusAndBoards: async (status: string | null, boardIds: string[]) =>
      TASKS.filter(t => boardIds.includes(t.boardId) && (!status || t.status === status)),
    getTasksByAgent: async () => [],
    getTaskByIdPrefix: async () => null,
    saveTaskToDb: async () => {},
    saveAgent: async () => {},
    searchAgentSkills: async () => [],
    getAgentSkillById: async () => null,
    saveAgentSkill: async () => {},
    deleteAgentSkillFromDb: async () => {},
    // lib/agentScope.js → lib/boardAccess.js
    getBoardsByUser: async (userId: string) => (userId === 'user-1' ? [BOARD_A] : []),
    // the board-scoped repo list the agent surfaces must use…
    getReposForBoards: async (boardIds: string[]) =>
      boardIds.flatMap(id => REPOS_BY_BOARD[id] || []),
    // …and the instance-wide one they must NOT.
    getAccessibleBoardRepos: async () => {
      accessibleBoardReposCalls++;
      return Object.values(REPOS_BY_BOARD).flat();
    },
    // pulled in by lib/agentAccess.js → middleware/authz.js; never called here.
    getAgentById: async () => null,
    getBoardShare: async () => null,
    getProjectById: async () => null,
    hasProjectBoardAccess: async () => false,
  },
});

mock.module('../configManager.js', { namedExports: { getWorkflowForBoard: async () => null } });
mock.module('../swarmApiMcp.js', { namedExports: { applyTaskUpdate: async () => ({}) } });
mock.module('../toolHooks.js', {
  namedExports: { checkToolHooks: () => ({ blocked: false, warnings: [] }) },
});
mock.module('../mcpManager.js', { namedExports: { findBuiltinMcpServer: () => null } });

const { HANDLERS } = await import('../agentManager/tools/handlers.js');
const { parsingMethods } = await import('../agentManager/parsing.js');
const { getAgentBoardScope, agentsVisibleTo } = await import('../../lib/agentScope.js');

const mgr = { _listAvailableProjects: parsingMethods._listAvailableProjects };

function ctx(agent: any, args: any[] = []) {
  return {
    mgr,
    agent,
    agentId: agent.id,
    call: { tool: 'x', args },
    streamCallback: null,
    dedup: {},
    depth: 0,
  } as any;
}

const onBoardA = { id: 'agent-1', name: 'Builder', boardId: 'board-a', ownerId: 'user-1' };

// ── the rule itself ─────────────────────────────────────────────────────────

test('board-scoped agent sees its own board only, not its owner other boards', async () => {
  const scope = await getAgentBoardScope({ boardId: 'board-a', ownerId: 'user-1' });
  assert.deepEqual([...scope], ['board-a']);
});

test('board-less agent falls back to the boards its owner can reach', async () => {
  const scope = await getAgentBoardScope({ boardId: null, ownerId: 'user-1' });
  assert.deepEqual([...scope], ['board-a']);
});

test('agent with neither board nor owner sees nothing', async () => {
  assert.equal((await getAgentBoardScope({ boardId: null, ownerId: null })).size, 0);
  assert.equal((await getAgentBoardScope(null)).size, 0);
});

test('the roster never inherits the owner admin role', () => {
  const others = [
    { id: 'a', boardId: 'board-a' },
    { id: 'b', boardId: 'board-b' },
    { id: 'c', boardId: null, ownerId: 'user-1' },
    { id: 'd', boardId: null, ownerId: 'user-2' },
  ];
  const visible = agentsVisibleTo(onBoardA, others, new Set(['board-a'])).map(a => a.id);
  assert.deepEqual(visible, ['a', 'c']);
});

// ── the tools ───────────────────────────────────────────────────────────────

test('list_boards returns only the boards in the agent tenant', async () => {
  const res = await HANDLERS.list_boards(ctx(onBoardA));
  assert.equal(res.success, true);
  assert.match(res.result, /Alpha/);
  assert.doesNotMatch(res.result, /Prolipsy/);
});

test('list_boards is empty for an agent with no board and no owner', async () => {
  const res = await HANDLERS.list_boards(ctx({ id: 'orphan', name: 'Orphan' }));
  assert.equal(res.success, true);
  assert.match(res.result, /No boards found/);
});

test('list_tasks without a filter stays inside the agent tenant', async () => {
  const res = await HANDLERS.list_tasks(ctx(onBoardA, ['', '']));
  assert.equal(res.success, true);
  assert.match(res.result, /On my board/);
  assert.doesNotMatch(res.result, /Someone else/);
});

test('list_tasks on a board outside the tenant answers like an unknown board', async () => {
  const res = await HANDLERS.list_tasks(ctx(onBoardA, ['', 'board-b']));
  assert.equal(res.success, false);
  assert.match(res.error, /Board not found: board-b/);
  // …and says nothing about what that board is or holds.
  assert.doesNotMatch(res.error, /Prolipsy/);
});

test('list_projects lists the tenant repos and never the instance-wide set', async () => {
  accessibleBoardReposCalls = 0;
  const res = await HANDLERS.list_projects(ctx(onBoardA));
  assert.equal(res.success, true);
  assert.match(res.result, /acme\/alpha/);
  assert.doesNotMatch(res.result, /acme\/prolipsy/);
  assert.equal(accessibleBoardReposCalls, 0);
});

test('_listAvailableProjects(null) stays unscoped for a human admin session', async () => {
  accessibleBoardReposCalls = 0;
  const projects = await mgr._listAvailableProjects(null);
  assert.deepEqual(projects, ['acme/alpha', 'acme/prolipsy']);
  assert.equal(accessibleBoardReposCalls, 1);
});
