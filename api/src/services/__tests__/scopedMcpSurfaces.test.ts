/**
 * Tenant isolation on the two scoped MCP surfaces (/api/mcp/admin and
 * /api/mcp/management).
 *
 * ── What these replace ──────────────────────────────────────────────────────
 * The only key-authenticated MCP surface used to be /api/swarm/mcp, guarded by
 * ONE ownerless instance-wide key. `authenticateApiKey` attached no identity,
 * so `routes/swarmApi.ts` and `services/swarmApiMcp.ts` never read `req.user`
 * (0 occurrences) and every tool ran with no tenant at all: whoever held the
 * key listed every board, every agent and every task on the instance.
 *
 * The replacement keys name an OWNER, and these tests pin what that buys:
 * Alice, holding a perfectly valid key, must not be able to read, write,
 * delegate or search anything of Bob's — and must not be able to tell Bob's
 * resources apart from ones that do not exist.
 *
 * ── Why "not found" and never "forbidden" ───────────────────────────────────
 * A 403 on a resource you may not touch confirms it EXISTS. On a
 * machine-driven surface reached with a key, that is an enumeration oracle:
 * guess ids, keep the ones that answer "denied". Every out-of-scope answer
 * below is therefore asserted to be the same "not found" a nonexistent id gets.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
const realDb = await import('../database.js');
const realTasks = await import('../database/tasks.js');

// ── The two tenants ─────────────────────────────────────────────────────────
// Real UUIDs: `createAgentSchema` — the very schema POST /api/agents uses —
// requires boardId to be one, and these tests exercise that schema rather than
// a copy of it, so the fixture has to be honest about the id format.
const BOARD_A = '11111111-1111-4111-8111-111111111111';
const BOARD_B = '22222222-2222-4222-8222-222222222222';
const PROJECT_A = '44444444-4444-4444-8444-444444444444';
const PROJECT_B = '55555555-5555-4555-8555-555555555555';

const ALICE = { userId: 'user-a', username: 'alice', role: 'advanced', csrf: '' };
const BOB = { userId: 'user-b', username: 'bob', role: 'advanced', csrf: '' };
const ADMIN = { userId: 'user-root', username: 'root', role: 'admin', csrf: '' };

const WORKFLOW = {
  version: 1,
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'doing', label: 'Doing' },
    { id: 'done', label: 'Done' },
  ],
  transitions: [],
};

const BOARDS: Record<string, any> = {
  [BOARD_A]: { id: BOARD_A, name: "Alice's board", user_id: ALICE.userId, workflow: WORKFLOW },
  [BOARD_B]: { id: BOARD_B, name: "Bob's board", user_id: BOB.userId, workflow: WORKFLOW },
};

const PROJECTS: Record<string, any> = {
  [PROJECT_A]: { id: PROJECT_A, name: 'Alpha', owner_id: ALICE.userId },
  [PROJECT_B]: { id: PROJECT_B, name: 'Beta', owner_id: BOB.userId },
};

const TASKS: Record<string, any> = {
  'task-a': { id: 'task-a', text: 'Alice work', status: 'backlog', boardId: BOARD_A },
  'task-b': { id: 'task-b', text: 'Bob work', status: 'backlog', boardId: BOARD_B },
};

const AGENTS: Record<string, any> = {
  'agent-a': { id: 'agent-a', name: 'Ada', boardId: BOARD_A, ownerId: ALICE.userId },
  'agent-b': { id: 'agent-b', name: 'Bo', boardId: BOARD_B, ownerId: BOB.userId },
};

let searchCalls: any[] = [];
const updatedFields: { id: string; fields: Record<string, unknown> }[] = [];

// ── Mocks ───────────────────────────────────────────────────────────────────
// `../database.js` is the barrel middleware/authz.ts, lib/boardAccess.ts and
// lib/agentAccess.ts all read, so mocking it here installs the same fake for
// the real authorization helpers the surfaces delegate to. Nothing about the
// access RULES is faked — only the rows they read.
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    getBoardById: async (id: string) => BOARDS[id] || null,
    getBoardsByUser: async (userId: string) =>
      Object.values(BOARDS).filter(b => b.user_id === userId),
    getAllBoards: async () => Object.values(BOARDS),
    // No shares in this fixture: the two tenants are strictly disjoint.
    getBoardShare: async () => null,
    getBoardShares: async () => [],
    createBoardShare: async (boardId: string, userId: string, permission: string) => ({
      board_id: boardId,
      user_id: userId,
      permission,
    }),
    createBoard: async (userId: string, name: string, workflow: any) => ({
      id: 'board-new',
      name,
      user_id: userId,
      workflow,
    }),
    updateBoard: async (id: string, fields: any) => ({ ...BOARDS[id], ...fields }),
    deleteBoard: async (id: string) => !!BOARDS[id],
    getProjectById: async (id: string) => PROJECTS[id] || null,
    getProjectsForUser: async (userId: string, role: string) =>
      role === 'admin'
        ? Object.values(PROJECTS)
        : Object.values(PROJECTS).filter(p => p.owner_id === userId),
    getProjectByName: async () => null,
    createProject: async (name: string) => ({ id: 'project-new', name }),
    updateProject: async (id: string, fields: any) => ({ ...PROJECTS[id], ...fields }),
    deleteProject: async (id: string) => !!PROJECTS[id],
    hasProjectBoardAccess: async () => false,
    getAllUsers: async () => [
      { id: ALICE.userId, username: 'alice', role: 'advanced' },
      { id: BOB.userId, username: 'bob', role: 'advanced' },
    ],
    getAllAgentSkills: async () => [{ id: 'skill-1', name: 'Writer' }],
    getAgentById: async (id: string) => AGENTS[id] || null,
    searchTasks: async (opts: any) => {
      searchCalls.push(opts);
      return { total: 0, returned: 0, tasks: [] };
    },
    saveTaskToDb: async () => true,
    updateTaskFields: async (id: string, fields: any) => {
      updatedFields.push({ id, fields });
      return { ...TASKS[id], ...fields };
    },
  },
});

mock.module('../database/tasks.js', {
  namedExports: {
    ...realTasks,
    getTaskByIdPrefix: async (id: string) => TASKS[id] || null,
    getTaskById: async (id: string) => TASKS[id] || null,
    getTasksByAgent: async () => [],
    getTasksByStatusAndBoards: async (status: string | null, boardIds: string[]) =>
      Object.values(TASKS).filter(
        t => boardIds.includes(t.boardId) && (!status || t.status === status)
      ),
    updateTaskFields: async (id: string, fields: any) => {
      updatedFields.push({ id, fields });
      return { ...TASKS[id], ...fields };
    },
    deleteTaskFromDb: async () => true,
    restoreTaskFromDb: async () => null,
  },
});

mock.module('../database/boardRepos.js', {
  namedExports: { getReposForBoard: async () => [] },
});

const { createManagementMcpServer } = await import('../mcp/managementMcp.js');
const { createAdminMcpServer } = await import('../mcp/adminMcp.js');

// ── Fakes for the managers the surfaces drive ───────────────────────────────

function makeAgentManager() {
  const created: any[] = [];
  const deleted: string[] = [];
  return {
    agents: new Map(Object.entries(AGENTS)),
    created,
    deleted,
    getAllForUser(userId: string, _role: string, boardIds: Set<string>) {
      // Stands in for lib/agentAccess.ts canSeeAgent, which the real manager
      // applies: an agent is visible through its board, or through its owner.
      return Object.values(AGENTS).filter(
        a => (a.boardId && boardIds.has(a.boardId)) || a.ownerId === userId
      );
    },
    async addTask(agentId: string | null, text: string, _src: any, status: string, opts: any) {
      const task = { id: 'task-new', text, status: status || 'backlog', ...opts, agentId };
      created.push(task);
      return task;
    },
    async deleteTask(_agentId: string | null, taskId: string) {
      deleted.push(taskId);
      return true;
    },
    async restoreTask() {
      return null;
    },
    async create(config: any) {
      created.push(config);
      return { id: 'agent-new', ...config };
    },
    async update(id: string, updates: any) {
      return { ...AGENTS[id], ...updates };
    },
    async delete(id: string) {
      deleted.push(id);
      return true;
    },
    _isActiveTaskStatus: () => false,
    _refreshWorkflowManagedStatuses: () => {},
    _emit: () => {},
    _sanitize: (a: any) => a,
  } as any;
}

const mcpManagerFake = {
  getAll: () => [{ id: 'mcp-1', name: 'Gandi', enabled: true }],
  getById: (id: string) => (id === 'mcp-1' ? { id: 'mcp-1', name: 'Gandi' } : null),
} as any;

const skillManagerFake = {
  getAll: () => [{ id: 'plugin-1', name: 'Writer' }],
} as any;

/** Pull a registered tool's handler off an McpServer instance. */
function tool(server: any, name: string): (args: any) => Promise<any> {
  const reg = server._registeredTools?.[name];
  assert.ok(reg, `tool not registered: ${name}`);
  return reg.handler || reg.callback;
}

function body(result: any): any {
  return JSON.parse(result.content[0].text);
}

/**
 * Assert an out-of-scope answer is indistinguishable from a nonexistent one:
 * flagged as an error, worded "not found", and never leaking that the caller
 * merely lacked permission.
 */
function assertNotFound(result: any, kind: string) {
  assert.equal(result.isError, true, 'out-of-scope access must be an error');
  const text = body(result).error as string;
  assert.match(
    text,
    new RegExp(`${kind} not found`, 'i'),
    `expected "${kind} not found", got: ${text}`
  );
  assert.doesNotMatch(
    text,
    /forbidden|denied|permission|not allowed/i,
    `"${text}" confirms the resource exists — that is an enumeration oracle`
  );
}

function management(actor: any) {
  return createManagementMcpServer(makeAgentManager(), actor as any);
}
function admin(actor: any, mgr = makeAgentManager()) {
  return createAdminMcpServer(mgr, mcpManagerFake, skillManagerFake, actor as any);
}

// ── Management surface: listing is bounded by the caller's boards ───────────

test('management list_boards shows only the caller own boards', async () => {
  const alice = body(await tool(management(ALICE), 'list_boards')({}));
  assert.deepEqual(
    alice.boards.map((b: any) => b.id),
    [BOARD_A]
  );

  const bob = body(await tool(management(BOB), 'list_boards')({}));
  assert.deepEqual(
    bob.boards.map((b: any) => b.id),
    [BOARD_B]
  );
});

test('management list_agents shows only agents in the caller tenant', async () => {
  const alice = body(await tool(management(ALICE), 'list_agents')({}));
  assert.deepEqual(
    alice.agents.map((a: any) => a.id),
    ['agent-a']
  );
});

test('management list_tasks never returns another tenant tasks', async () => {
  const alice = body(await tool(management(ALICE), 'list_tasks')({}));
  assert.deepEqual(
    alice.tasks.map((t: any) => t.id),
    ['task-a']
  );
});

test('management list_tasks on another tenant board answers not found', async () => {
  assertNotFound(await tool(management(ALICE), 'list_tasks')({ board_id: BOARD_B }), 'Board');
});

// ── Management surface: reads and writes across tenants are refused ─────────

test('management get_task cannot read another tenant task', async () => {
  assertNotFound(await tool(management(ALICE), 'get_task')({ task_id: 'task-b' }), 'Task');
  // …and the same answer a task that never existed gets.
  assertNotFound(await tool(management(ALICE), 'get_task')({ task_id: 'task-zzz' }), 'Task');
});

test('management update_task cannot write another tenant task', async () => {
  updatedFields.length = 0;
  const result = await tool(
    management(ALICE),
    'update_task'
  )({
    task_id: 'task-b',
    status: 'done',
  });
  assertNotFound(result, 'Task');
  assert.deepEqual(updatedFields, [], 'nothing may be written before the check');
});

test('management delete_task cannot delete another tenant task', async () => {
  const mgr = makeAgentManager();
  const server = createManagementMcpServer(mgr, ALICE as any);
  assertNotFound(await tool(server, 'delete_task')({ task_id: 'task-b' }), 'Task');
  assert.deepEqual(mgr.deleted, [], 'no deletion may reach the manager');
});

test('management create_task cannot file work on another tenant board', async () => {
  const mgr = makeAgentManager();
  const server = createManagementMcpServer(mgr, ALICE as any);
  const result = await tool(server, 'create_task')({ task: 'sneak in', board_id: BOARD_B });
  assertNotFound(result, 'Board');
  assert.deepEqual(mgr.created, [], 'no task may be created');
});

test('management create_task works on the caller own board', async () => {
  const mgr = makeAgentManager();
  const server = createManagementMcpServer(mgr, ALICE as any);
  const result = body(await tool(server, 'create_task')({ task: 'real work', board_id: BOARD_A }));
  assert.equal(result.success, true);
  assert.equal(mgr.created.length, 1);
  assert.equal(mgr.created[0].boardId, BOARD_A);
});

// ── Delegation is the interesting one: BOTH ends must be in scope ───────────

test('management delegate_task refuses an agent outside the caller tenant', async () => {
  updatedFields.length = 0;
  // Alice owns the task. The AGENT is Bob's — delegating to it would make one
  // of his agents run her work, with his credentials.
  const result = await tool(
    management(ALICE),
    'delegate_task'
  )({
    task_id: 'task-a',
    agent_id: 'agent-b',
  });
  assertNotFound(result, 'Agent');
  assert.deepEqual(updatedFields, [], 'no assignment may be persisted');
});

test('management delegate_task refuses a task outside the caller tenant', async () => {
  updatedFields.length = 0;
  const result = await tool(
    management(ALICE),
    'delegate_task'
  )({
    task_id: 'task-b',
    agent_id: 'agent-a',
  });
  assertNotFound(result, 'Task');
  assert.deepEqual(updatedFields, []);
});

test('management delegate_task works when both ends are the caller own', async () => {
  updatedFields.length = 0;
  const result = body(
    await tool(management(ALICE), 'delegate_task')({ task_id: 'task-a', agent_id: 'agent-a' })
  );
  assert.equal(result.success, true);
  assert.deepEqual(updatedFields, [{ id: 'task-a', fields: { assignee: 'agent-a' } }]);
});

// ── Search is bounded in SQL, not by post-filtering ─────────────────────────

test('management search_tasks binds the query to the caller boards', async () => {
  searchCalls = [];
  await tool(management(ALICE), 'search_tasks')({ query: 'secret' });
  assert.equal(searchCalls.length, 1);
  assert.deepEqual(
    searchCalls[0].boardIds,
    [BOARD_A],
    'the tenant bound must reach searchTasks, which enforces it in SQL'
  );
});

test('management search_tasks cannot be widened by naming another tenant board', async () => {
  searchCalls = [];
  const result = await tool(management(ALICE), 'search_tasks')({ board_id: BOARD_B });
  assertNotFound(result, 'Board');
  assert.deepEqual(searchCalls, [], 'the search must not even run');
});

// ── Role-gated tools stay role-gated ───────────────────────────────────────

test('management restore_task needs the admin ROLE, not merely a key', async () => {
  const denied = await tool(management(ALICE), 'restore_task')({ task_id: 'task-a' });
  assert.equal(denied.isError, true);
  assert.match(body(denied).error, /admin role/i);
});

// ── Admin surface: the tool set widens, the tenant does not ────────────────

test('admin get_agent cannot read another tenant agent', async () => {
  assertNotFound(await tool(admin(ALICE), 'get_agent')({ agent_id: 'agent-b' }), 'Agent');
});

test('admin update_agent and delete_agent cannot touch another tenant agent', async () => {
  const mgr = makeAgentManager();
  const server = admin(ALICE, mgr);
  assertNotFound(
    await tool(server, 'update_agent')({ agent_id: 'agent-b', updates: { name: 'pwned' } }),
    'Agent'
  );
  assertNotFound(await tool(server, 'delete_agent')({ agent_id: 'agent-b' }), 'Agent');
  assert.deepEqual(mgr.deleted, []);
});

test('admin create_agent cannot plant an agent on another tenant board', async () => {
  const mgr = makeAgentManager();
  const server = admin(ALICE, mgr);
  const result = await tool(
    server,
    'create_agent'
  )({
    config: { name: 'Mole', boardId: BOARD_B },
  });
  assertNotFound(result, 'Board');
  assert.deepEqual(mgr.created, []);
});

test('admin create_agent owns the new agent to the key holder', async () => {
  const mgr = makeAgentManager();
  const server = admin(ALICE, mgr);
  const result = body(
    await tool(server, 'create_agent')({ config: { name: 'Ada II', boardId: BOARD_A } })
  );
  assert.equal(result.success, true);
  // An admin-scoped key mints agents for ITS OWNER, never for someone else.
  assert.equal(mgr.created[0].ownerId, ALICE.userId);
});

test('admin update_agent cannot move an agent onto another tenant board', async () => {
  const result = await tool(
    admin(ALICE),
    'update_agent'
  )({
    agent_id: 'agent-a',
    updates: { boardId: BOARD_B },
  });
  // Edit rights on board-a must not become a way to plant an agent on board-b.
  assertNotFound(result, 'Board');
});

test('admin attach_tools_to_agent cannot re-arm another tenant agent', async () => {
  assertNotFound(
    await tool(
      admin(ALICE),
      'attach_tools_to_agent'
    )({
      agent_id: 'agent-b',
      mcp_servers: ['mcp-1'],
    }),
    'Agent'
  );
});

test('admin attach_tools_to_agent rejects unknown tool ids instead of storing them', async () => {
  const result = await tool(
    admin(ALICE),
    'attach_tools_to_agent'
  )({
    agent_id: 'agent-a',
    mcp_servers: ['mcp-does-not-exist'],
  });
  assert.equal(result.isError, true);
  assert.match(body(result).error, /Unknown MCP server/i);
});

test('admin board tools refuse another tenant board at every level', async () => {
  const server = admin(ALICE);
  assertNotFound(await tool(server, 'delete_board')({ board_id: BOARD_B }), 'Board');
  assertNotFound(
    await tool(server, 'update_board')({ board_id: BOARD_B, name: 'mine now' }),
    'Board'
  );
  assertNotFound(
    await tool(
      server,
      'set_board_workflow'
    )({
      board_id: BOARD_B,
      columns: [{ label: 'Only Column' }],
    }),
    'Board'
  );
  assertNotFound(await tool(server, 'list_board_shares')({ board_id: BOARD_B }), 'Board');
  assertNotFound(
    await tool(
      server,
      'share_board'
    )({ board_id: BOARD_B, username: 'alice', permission: 'admin' }),
    'Board'
  );
});

test('admin set_board_workflow works on the caller own board and bumps the version', async () => {
  const result = body(
    await tool(
      admin(ALICE),
      'set_board_workflow'
    )({
      board_id: BOARD_A,
      columns: [{ label: 'Todo' }, { label: 'Done' }],
    })
  );
  assert.equal(result.success, true);
  assert.equal(result.board.workflowVersion, 2, 'version bumped exactly as the REST route does');
  assert.deepEqual(
    result.board.columns.map((c: any) => c.label),
    ['Todo', 'Done']
  );
});

test('admin project tools refuse another tenant project', async () => {
  const server = admin(ALICE);
  assertNotFound(await tool(server, 'delete_project')({ project_id: PROJECT_B }), 'Project');
  assertNotFound(
    await tool(server, 'update_project')({ project_id: PROJECT_B, name: 'mine' }),
    'Project'
  );
});

test('admin list_projects shows only the caller projects', async () => {
  const result = body(await tool(admin(ALICE), 'list_projects')({}));
  assert.deepEqual(
    result.projects.map((p: any) => p.id),
    [PROJECT_A]
  );
});

test('admin list_boards is the caller own boards, even holding an admin-scoped key', async () => {
  const result = body(await tool(admin(ALICE), 'list_boards')({}));
  assert.deepEqual(
    result.boards.map((b: any) => b.id),
    [BOARD_A]
  );
});

// ── The heart of it: "admin" is a TOOL SET, not a ROLE ─────────────────────

test('list_users needs the admin ROLE — an admin-scoped key is not enough', async () => {
  const denied = await tool(admin(ALICE), 'list_users')({});
  assert.equal(denied.isError, true);
  assert.match(body(denied).error, /admin role/i);
  assert.match(body(denied).error, /scope selects a tool set, not a role/i);

  // The same tool, the same scope, an owner who really is an admin.
  const allowed = body(await tool(admin(ADMIN), 'list_users')({}));
  assert.equal(allowed.count, 2);
});

test('create_project keeps the role gate its REST twin has', async () => {
  const basic = { userId: 'user-c', username: 'carol', role: 'basic', csrf: '' };
  const denied = await tool(admin(basic), 'create_project')({ name: 'Gamma' });
  assert.equal(denied.isError, true);
  assert.match(body(denied).error, /advanced or admin role/i);

  const ok = body(await tool(admin(ALICE), 'create_project')({ name: 'Gamma' }));
  assert.equal(ok.success, true);
});

test('a basic user cannot create, modify or delete agents through an admin key', async () => {
  const basic = { userId: 'user-c', username: 'carol', role: 'basic', csrf: '' };
  const server = admin(basic);
  for (const [name, args] of [
    ['create_agent', { config: { name: 'X', boardId: BOARD_A } }],
    ['update_agent', { agent_id: 'agent-a', updates: { name: 'X' } }],
    ['delete_agent', { agent_id: 'agent-a' }],
  ] as const) {
    const result = await tool(server, name)(args);
    assert.equal(result.isError, true, `${name} must refuse a basic user`);
    assert.match(body(result).error, /Basic users cannot/i);
  }
});

// ── The two surfaces expose exactly what they are supposed to ──────────────

test('the management surface exposes no agent, board, project or workflow mutation', async () => {
  const names = Object.keys((management(ALICE) as any)._registeredTools);
  assert.deepEqual(
    names.sort(),
    [
      'start_task',
      'resume_task',
      'stop_task',
      'set_task_recurrence',
      'list_task_templates',
      'get_task_template',
      'update_task_template',
      'delete_task_template',
      'run_task_template',
      'list_task_template_runs',
      'create_task',
      'delegate_task',
      'delete_task',
      'get_task',
      'list_agents',
      'list_boards',
      'list_tasks',
      'restore_task',
      'search_tasks',
      'update_task',
    ].sort(),
    'a management key must not be able to reshape the instance that runs its tasks'
  );
});

test('the admin surface exposes the declared administrative tool set', async () => {
  const names = Object.keys((admin(ALICE) as any)._registeredTools);
  assert.deepEqual(names.sort(), [
    'attach_tools_to_agent',
    'create_agent',
    'create_board',
    'create_project',
    'delete_agent',
    'delete_board',
    'delete_project',
    'get_agent',
    'get_board',
    'list_agent_skills',
    'list_board_shares',
    'list_boards',
    'list_mcp_servers',
    'list_plugins',
    'list_projects',
    'list_users',
    'set_board_workflow',
    'share_board',
    'update_agent',
    'update_board',
    'update_project',
  ]);
});
