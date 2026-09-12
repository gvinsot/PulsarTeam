import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { AgentManager } from '../agentManager/index.js';
import type { MCPManager } from '../mcpManager.js';
import type { SkillManager } from '../skillManager.js';
import { makeTaskDbFake } from './helpers/taskDbFake.js';

const realDb = await import('../database.js');
const realTasks = await import('../database/tasks.js');
const { rows, exports: taskDb } = makeTaskDbFake();
const BOARD = '11111111-1111-4111-8111-111111111111';
const actor = { userId: 'alice', username: 'alice', role: 'advanced', csrf: '' };
const initialWorkflow = () => ({
  version: 1,
  columns: [
    { id: 'backlog', label: 'Backlog' },
    { id: 'doing', label: 'Doing', color: '#123456' },
    { id: 'done', label: 'Done' },
  ],
  transitions: [
    {
      from: 'doing',
      trigger: 'on_enter',
      actions: [{ type: 'run_agent', mode: 'decide', instructions: 'Check evidence' }],
    },
  ],
});
let board = {
  id: BOARD,
  user_id: 'alice',
  name: 'Operations',
  workflow: initialWorkflow(),
  mcp_auth: { secret: 'BOARD_SECRET' },
};
const dbExports = {
  ...realDb,
  ...taskDb,
  getBoardById: async (id: string) =>
    id === BOARD ? board : { id, user_id: 'bob', workflow: initialWorkflow() },
  getBoardsByUser: async () => [board],
  getBoardShare: async () => null,
  getProjectById: async () => null,
  updateBoard: async (_id: string, fields: object) => Object.assign(board, fields),
};
mock.module('../database.js', { namedExports: dbExports });
mock.module('../database/tasks.js', { namedExports: { ...realTasks, ...taskDb } });
mock.module('../database/boardRepos.js', { namedExports: { getReposForBoard: async () => [] } });
const { tasksMethods, clearTaskSignals, getTaskSignal } = await import('../agentManager/tasks.js');
const { reserveAgentForTask } = await import('../workflow/agentSelector.js');
const { createManagementMcpServer } = await import('../mcp/managementMcp.js');
const { createAdminMcpServer } = await import('../mcp/adminMcp.js');

beforeEach(() => {
  rows.clear();
  clearTaskSignals('task');
  board = {
    id: BOARD,
    user_id: 'alice',
    name: 'Operations',
    workflow: initialWorkflow(),
    mcp_auth: { secret: 'BOARD_SECRET' },
  };
  rows.set('task', {
    id: 'task',
    boardId: BOARD,
    agentId: null,
    text: 'Prepare report',
    status: 'backlog',
    history: [],
    createdAt: new Date().toISOString(),
  });
  rows.set('foreign', {
    id: 'foreign',
    boardId: 'foreign-board',
    agentId: null,
    text: 'Private',
    status: 'doing',
  });
});

function setup() {
  const agent = {
    id: 'agent',
    name: 'Analyst',
    ownerId: 'alice',
    boardId: BOARD,
    status: 'idle',
    enabled: true,
    instructions: 'Verify sources',
    runner: 'codex',
    llmConfigId: 'model-config',
    temperature: 0,
    contextLength: 32000,
    maxTokens: 8000,
    permissions: { execution: { shellAccess: false } },
    toolHooks: { enabled: true, rules: [] },
    apiKey: 'API_SECRET',
    credentials: { github: 'GITHUB_SECRET' },
    mcpAuth: { mail: { apiKey: 'MAIL_SECRET' } },
    runnerSessions: { private: 'SESSION_SECRET' },
    conversationHistory: ['HISTORY_SECRET'],
  };
  const resume = mock.fn(async (_id: string, _agent: object, task: { id: string }) => {
    await taskDb.updateTaskFields(task.id, { startedAt: new Date().toISOString() });
  });
  const interrupt = mock.fn(async () => true);
  const controller = new AbortController();
  const manager = {
    ...tasksMethods,
    agents: new Map([
      ['agent', agent],
      [
        'foreign-agent',
        { ...agent, id: 'foreign-agent', ownerId: 'bob', boardId: 'foreign-board' },
      ],
    ]),
    abortControllers: new Map([['agent', controller]]),
    resolveLlmConfig: () => ({
      provider: 'openai',
      model: 'test-model',
      endpoint: '',
      apiKey: 'RESOLVED_SECRET',
      maxTokens: 8000,
      managesContext: true,
    }),
    _emit: mock.fn(),
    _sanitize: (value: object) => value,
    _checkAutoRefine: mock.fn(),
    _resumeActiveTask: resume,
    _taskResumeFailures: new Map(),
    _refreshWorkflowManagedStatuses: mock.fn(),
    executionManager: { getProviderType: () => 'codex', interruptCliTerminalSessions: interrupt },
    async update(id: string, fields: object) {
      const target = this.agents.get(id);
      return target ? Object.assign(target, fields) : null;
    },
  };
  const mgr = manager as unknown as AgentManager;
  return {
    manager,
    mgr,
    resume,
    interrupt,
    controller,
    agent,
    management: createManagementMcpServer(mgr, actor),
    admin: createAdminMcpServer(mgr, {} as MCPManager, {} as SkillManager, actor),
  };
}

async function connect(server: McpServer) {
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  const text = content[0].text;
  return { error: result.isError, body: text.startsWith('{') ? JSON.parse(text) : { error: text } };
}

test('MCP tools/list publishes agent fields and discriminated workflow actions', async t => {
  const h = setup();
  const client = await connect(h.admin);
  t.after(() => client.close());
  const { tools } = await client.listTools();
  const create = tools.find(tool => tool.name === 'create_agent')!;
  const serialized = JSON.stringify(create.inputSchema);
  for (const field of [
    'boardId',
    'instructions',
    'permissions',
    'shellAccess',
    'runner',
    'llmConfigId',
  ])
    assert.ok(serialized.includes('"' + field + '"'));
  const workflow = JSON.stringify(
    tools.find(tool => tool.name === 'set_board_workflow')!.inputSchema
  );
  for (const field of [
    'on_enter',
    'assign_agent_individual',
    'instructions',
    'assignee_status',
    'conditions',
  ])
    assert.ok(workflow.includes(field));
  const invalid = await call(client, 'create_agent', { config: { name: 'Missing board' } });
  assert.equal(invalid.error, true);
  const invalidAction = await call(client, 'set_board_workflow', {
    board_id: BOARD,
    columns: board.workflow.columns,
    transitions: [{ from: 'doing', trigger: 'on_enter', actions: [{ type: 'made_up_action' }] }],
  });
  assert.equal(invalidAction.error, true);
});

test('get_agent returns editable configuration and preserves secrets on a partial update', async t => {
  const h = setup();
  const client = await connect(h.admin);
  t.after(() => client.close());
  const before = await call(client, 'get_agent', { agent_id: 'agent' });
  assert.equal(before.body.agent.instructions, 'Verify sources');
  assert.equal(before.body.agent.runner, 'codex');
  assert.equal(before.body.agent.effectiveLlm.model, 'test-model');
  assert.equal(before.body.agent.effectiveLlm.managesContext, true);
  assert.equal(before.body.agent.temperature, 0);
  assert.equal(before.body.agent.permissions.execution.shellAccess, false);
  assert.ok(!JSON.stringify(before).includes('_SECRET'));
  assert.deepEqual(before.body.agent.configuredSecrets.credentials, ['github']);
  await call(client, 'update_agent', {
    agent_id: 'agent',
    updates: { instructions: 'New procedure' },
  });
  const after = await call(client, 'get_agent', { agent_id: 'agent' });
  assert.equal(after.body.agent.instructions, 'New procedure');
  assert.equal(h.agent.apiKey, 'API_SECRET');
  assert.equal(h.agent.runner, 'codex');
  assert.equal((await call(client, 'get_agent', { agent_id: 'foreign-agent' })).error, true);
});

test('workflow read/edit/read preserves transitions and migrates existing task statuses', async t => {
  const h = setup();
  const client = await connect(h.admin);
  t.after(() => client.close());
  rows.get('task').status = 'doing';
  rows.set('rule', {
    id: 'rule',
    boardId: BOARD,
    isTemplate: true,
    status: 'doing',
    recurrence: { originalStatus: 'doing', intervalMinutes: 60, occurrenceCount: 3 },
  });
  const before = await call(client, 'get_board', { board_id: BOARD });
  assert.equal(before.body.board.workflow.transitions[0].actions[0].instructions, 'Check evidence');
  assert.ok(!JSON.stringify(before).includes('BOARD_SECRET'));
  const columns = before.body.board.workflow.columns;
  columns[1].label = 'Review';
  const edited = await call(client, 'set_board_workflow', { board_id: BOARD, columns });
  assert.ok(!edited.error);
  const after = await call(client, 'get_board', { board_id: BOARD });
  assert.equal(after.body.board.workflow.transitions[0].from, 'review');
  assert.equal(after.body.board.workflow.columns[1].color, '#123456');
  assert.equal(rows.get('task').status, 'review');
  assert.equal(rows.get('rule').recurrence.originalStatus, 'review');
  assert.equal(rows.get('rule').recurrence.occurrenceCount, 3);
  assert.equal((await call(client, 'get_board', { board_id: 'foreign-board' })).error, true);
});

test('task metadata survives re-reading; bad dates and priorities are rejected before mutation', async t => {
  const h = setup();
  const client = await connect(h.management);
  t.after(() => client.close());
  assert.ok(
    !(
      await call(client, 'update_task', {
        task_id: 'task',
        priority: 'urgent',
        due_date: '2026-10-01',
        title: 'Report',
      })
    ).error
  );
  const read = await call(client, 'get_task', { task_id: 'task' });
  assert.equal(read.body.task.priority, 'urgent');
  assert.equal(read.body.task.dueDate, '2026-10-01');
  for (const invalid of [{ priority: 'invented' }, { due_date: 'tomorrow' }]) {
    assert.equal((await call(client, 'update_task', { task_id: 'task', ...invalid })).error, true);
  }
  assert.equal(rows.get('task').priority, 'urgent');
  await call(client, 'update_task', { task_id: 'task', due_date: null });
  assert.equal((await call(client, 'get_task', { task_id: 'task' })).body.task.dueDate, null);
});

test('explicit start, stop and resume dispatch real execution logic without a duplicate workflow launch', async t => {
  const h = setup();
  const client = await connect(h.management);
  t.after(() => client.close());
  await call(client, 'delegate_task', { task_id: 'task', agent_id: 'agent' });
  assert.equal(h.resume.mock.callCount(), 0);
  const start = await call(client, 'start_task', { task_id: 'task', status: 'Doing' });
  assert.ok(!start.error, JSON.stringify(start));
  assert.equal(start.body.accepted, true);
  assert.equal(h.resume.mock.callCount(), 1);
  assert.equal(h.manager._checkAutoRefine.mock.callCount(), 0);
  assert.equal(rows.get('task').agentId, null, 'board-level ownership is preserved');
  assert.ok(!(await call(client, 'stop_task', { task_id: 'task' })).error);
  assert.equal(rows.get('task').executionStatus, 'stopped');
  assert.equal(getTaskSignal('task', 'stopped'), true);
  assert.equal(h.controller.signal.aborted, true);
  assert.equal(h.interrupt.mock.callCount(), 1);
  assert.ok(!(await call(client, 'resume_task', { task_id: 'task' })).error);
  assert.equal(h.resume.mock.callCount(), 2);
  assert.ok(!getTaskSignal('task', 'stopped'));
});

test('execution rejects foreign targets, completed tasks and busy agents without changing state', async t => {
  const h = setup();
  const client = await connect(h.management);
  t.after(() => client.close());
  for (const name of ['start_task', 'resume_task', 'stop_task']) {
    assert.equal((await call(client, name, { task_id: 'foreign', agent_id: 'agent' })).error, true);
  }
  assert.equal(
    (await call(client, 'start_task', { task_id: 'task', agent_id: 'foreign-agent' })).error,
    true
  );
  const release = reserveAgentForTask('agent', 'other-task', 'test:other-task');
  assert.ok(release);
  try {
    assert.equal(
      (await call(client, 'start_task', { task_id: 'task', agent_id: 'agent' })).error,
      true
    );
    assert.equal(rows.get('task').status, 'backlog');
    rows.get('task').assignee = 'agent';
    rows.get('task').startedAt = new Date().toISOString();
    await call(client, 'stop_task', { task_id: 'task' });
    assert.equal(h.interrupt.mock.callCount(), 0, 'stale assignee cannot interrupt another task');
  } finally {
    release();
  }
  rows.get('task').status = 'done';
  assert.equal(
    (await call(client, 'resume_task', { task_id: 'task', agent_id: 'agent' })).error,
    true
  );
  assert.equal(h.resume.mock.callCount(), 0);
});

test('recurrence creation, editing, manual run and deletion preserve the schedule and past runs', async t => {
  const h = setup();
  const client = await connect(h.management);
  t.after(() => client.close());
  const created = await call(client, 'set_task_recurrence', {
    task_id: 'task',
    recurrence: { intervalMinutes: 60, originalStatus: 'Doing', onOverlap: 'skip' },
  });
  assert.ok(!created.error, JSON.stringify(created));
  const templateId = created.body.template.id;
  assert.equal(rows.get('task').templateId, templateId);
  const clock = created.body.template.recurrence.lastResetAt;
  await call(client, 'update_task_template', {
    template_id: templateId,
    title: 'Hourly report',
    recurrence: { keepLastOccurrences: 5 },
  });
  const read = await call(client, 'get_task_template', { template_id: templateId });
  assert.equal(read.body.template.recurrence.intervalMinutes, 60);
  assert.equal(read.body.template.recurrence.lastResetAt, clock);
  assert.equal(read.body.template.recurrence.keepLastOccurrences, 5);
  const run = await call(client, 'run_task_template', { template_id: templateId });
  assert.ok(!run.error, JSON.stringify(run));
  assert.equal(run.body.task.status, 'doing');
  assert.equal(run.body.task.occurrenceSeq, 2);
  assert.equal(rows.get(templateId).recurrence.lastResetAt, clock);
  assert.equal(h.manager._checkAutoRefine.mock.callCount(), 1);
  assert.equal(
    (await call(client, 'list_task_template_runs', { template_id: templateId })).body.tasks.length,
    2
  );
  assert.ok(!(await call(client, 'delete_task_template', { template_id: templateId })).error);
  assert.equal((await call(client, 'get_task_template', { template_id: templateId })).error, true);
  assert.ok(await taskDb.getTaskById('task'));
  assert.ok(await taskDb.getTaskById(run.body.task.id));
});

test('recurrence tools deny foreign rules and schema-invalid schedules', async t => {
  const h = setup();
  const client = await connect(h.management);
  t.after(() => client.close());
  rows.get('foreign').isTemplate = true;
  for (const name of [
    'get_task_template',
    'update_task_template',
    'delete_task_template',
    'run_task_template',
    'list_task_template_runs',
  ]) {
    assert.equal((await call(client, name, { template_id: 'foreign' })).error, true);
  }
  assert.equal(
    (
      await call(client, 'set_task_recurrence', {
        task_id: 'task',
        recurrence: { intervalMinutes: -1 },
      })
    ).error,
    true
  );
  assert.equal(
    (
      await call(client, 'set_task_recurrence', {
        task_id: 'task',
        recurrence: { originalStatus: 'missing' },
      })
    ).error,
    true
  );
  assert.ok(!rows.get('task').templateId);
  assert.deepEqual((await call(client, 'list_task_templates', {})).body.templates, []);
});
