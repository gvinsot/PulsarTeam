import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeTaskDbFake } from './helpers/taskDbFake.js';
import type { LlmConfig } from '../database/llmConfigs.js';
import type { Task } from '../database/tasks.js';
import type { WorkflowConfig } from '../workflow/taskStateMachine.js';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';

const config: LlmConfig = {
  id: 'dm',
  name: 'Decision',
  provider: 'decision',
  model: 'd3-mini',
  endpoint: 'http://decision:8000',
  apiKey: 'secret',
};
const action = {
  type: 'decision_model',
  llmConfigId: 'dm',
  instructions: 'Which team?',
  routes: [
    { target: 'billing', description: 'Payments' },
    { target: 'tech', description: 'Bugs' },
  ],
  minConfidence: 0.6,
  fallbackTarget: '',
};
let workflow: WorkflowConfig = {};
const configs = new Map<string, LlmConfig>([['dm', config]]);
const realDb = await import('../database.js');
const { rows, exports: dbFake } = makeTaskDbFake();
const realTasks = await import('../database/tasks.js');
mock.module('../database/tasks.js', {
  namedExports: {
    ...realTasks,
    getTaskByIdPrefix: async (id: string) => rows.get(id) || null,
    getTasksByAgent: dbFake.getTasksByAgent,
  },
});
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...dbFake,
    getLlmConfig: async (id: string) => configs.get(id) || null,
    getAllLlmConfigs: async () => [...configs.values()],
    getBoardById: async (id: string) => ({ id, name: 'Board', user_id: 'owner', workflow }),
    saveLlmConfig: async (value: LlmConfig) => {
      configs.set(value.id, value);
    },
  },
});
const realConfig = await import('../configManager.js');
mock.module('../configManager.js', {
  namedExports: { ...realConfig, getWorkflowForBoard: async () => workflow },
});
const { AgentManager } = await import('../agentManager.js');
const { executeAction } = await import('../workflow/actionExecutor.js');
const { processColumnEntry } = await import('../workflow/workflowEngine.js');
const { getTaskById } = await import('../database.js');
const { llmConfigRoutes } = await import('../../routes/llmConfigs.js');
const { setCurrentEnvironmentFromHost } = await import('../../lib/environment.js');
setCurrentEnvironmentFromHost('pulsar.example');

function setup() {
  rows.clear();
  configs.set('dm', config);
  workflow = {
    userId: 'owner',
    columns: ['triage', 'billing', 'tech', 'review'].map(id => ({ id, label: id })),
    transitions: [
      {
        from: 'triage',
        trigger: 'on_enter',
        actions: [action, { type: 'change_status', target: 'tech' }],
      },
    ],
  };
  return new AgentManager(
    {
      emit() {},
      to() {
        return { emit() {} };
      },
    },
    null,
    null,
    null
  );
}
async function seed(extra: Partial<Task> = {}): Promise<Task> {
  rows.set('task', {
    id: 'task',
    agentId: null,
    boardId: 'board',
    status: 'triage',
    title: 'Invoice',
    text: 'Charged twice',
    history: [],
    environment: 'prod',
    ...extra,
  });
  const task = await getTaskById('task');
  assert.ok(task);
  return task;
}
function response(confidence = 0.9) {
  return Response.json({
    answers: {
      route: {
        type: 'choice',
        choice: 'route_0',
        confidence,
        probabilities: { route_0: 0.95, route_1: 0.05 },
      },
    },
    usage: { input_tokens: 40, output_tokens: 0 },
  });
}

test('a board-level task routes without an agent and records a decision audit', async t => {
  const manager = setup();
  const task = await seed();
  const fetch = t.mock.method(globalThis, 'fetch', async () => response());
  await processColumnEntry(task, manager);
  const fresh = await getTaskById(task.id);
  assert.equal(fresh?.status, 'billing');
  assert.equal(manager.agents.size, 0);
  assert.equal(fetch.mock.callCount(), 1);
  assert.ok(
    fresh?.history?.some(
      entry => entry.type === 'decision' && entry.confidence === 0.9 && entry.target === 'billing'
    )
  );
});

test('low confidence uses only the explicit fallback and stops without one', async t => {
  const manager = setup();
  t.mock.method(globalThis, 'fetch', async () => response(0.2));
  const task = await seed();
  let result = await executeAction({ ...action, fallbackTarget: 'review' }, task, {
    agentManager: manager,
    io: manager.io,
    ownerId: 'owner',
    workflow,
  });
  assert.equal(result.statusChanged, true);
  assert.equal((await getTaskById('task'))?.status, 'review');
  const other = await seed();
  result = await executeAction(action, other, {
    agentManager: manager,
    io: manager.io,
    ownerId: 'owner',
    workflow,
  });
  assert.equal(result.error, true);
  assert.equal((await getTaskById('task'))?.status, 'triage');
});

test('manual, stopped and unapproved tasks never call the decision service', async t => {
  const manager = setup();
  const fetch = t.mock.method(globalThis, 'fetch', async () => response());
  for (const extra of [
    { isManual: true },
    { executionStatus: 'stopped' },
    { trustLevel: 'untrusted' },
  ] satisfies Partial<Task>[]) {
    const task = await seed(extra);
    await processColumnEntry(task, manager);
    assert.equal((await getTaskById('task'))?.status, 'triage');
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('deleted config, wrong provider and invalid answer fail closed even with a fallback', async t => {
  const manager = setup();
  const task = await seed();
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json({ answers: { route: { choice: 'tech' } } })
  );
  for (const cfg of [null, { ...config, provider: 'openai' }, config]) {
    if (cfg) configs.set('dm', cfg);
    else configs.delete('dm');
    const result = await executeAction({ ...action, fallbackTarget: 'review' }, task, {
      agentManager: manager,
      io: manager.io,
      ownerId: 'owner',
      workflow,
    });
    assert.equal(result.error, true);
    assert.equal((await getTaskById('task'))?.status, 'triage');
  }
  assert.equal(fetch.mock.callCount(), 1);
});

test('late responses cannot overwrite a manual move, edit, stop, deletion, board move or approval change', async t => {
  const manager = setup();
  const fetch = t.mock.method(globalThis, 'fetch');
  for (const change of [
    { status: 'review' },
    { text: 'Changed description' },
    { executionStatus: 'stopped' },
    { deletedAt: new Date().toISOString() },
    { boardId: 'other' },
    { trustLevel: 'untrusted' },
    { isManual: true },
  ] satisfies Partial<Task>[]) {
    const task = await seed();
    fetch.mock.mockImplementation(async () => {
      rows.set('task', { ...task, ...change });
      return response();
    });
    const result = await executeAction(action, task, {
      agentManager: manager,
      io: manager.io,
      ownerId: 'owner',
      workflow,
    });
    assert.equal(result.stopChain, true);
    assert.equal(result.statusChanged, undefined);
    assert.notEqual(rows.get('task').status, 'billing');
  }
});

test('workflow edits during inference invalidate the pending decision', async t => {
  const manager = setup();
  const task = await seed();
  const original = workflow;
  t.mock.method(globalThis, 'fetch', async () => {
    workflow = { ...workflow, version: 2 };
    return response();
  });
  const result = await executeAction(action, task, {
    agentManager: manager,
    io: manager.io,
    ownerId: 'owner',
    workflow: original,
  });
  assert.equal(result.stopChain, true);
  assert.equal(task.status, 'triage');
});

test('decisions use exact column IDs even when a label collides or the ID is a sentinel', async t => {
  t.mock.method(globalThis, 'fetch', async () => response());
  for (const target of ['billing', '__next__']) {
    const manager = setup();
    workflow.columns = [
      { id: 'triage', label: 'Triage' },
      { id: 'forbidden', label: target },
      { id: target, label: 'Allowed destination' },
      { id: 'tech', label: 'Tech' },
    ];
    const task = await seed();
    const result = await executeAction(
      { ...action, routes: [{ target, description: 'Payments' }, action.routes[1]] },
      task,
      {
        agentManager: manager,
        io: manager.io,
        ownerId: 'owner',
        workflow,
      }
    );
    assert.equal(result.statusChanged, true);
    assert.equal((await getTaskById('task'))?.status, target);
  }
});

test('periodic workflow snapshots without owner metadata are accepted', async t => {
  const manager = setup();
  const task = await seed();
  const periodic = { columns: workflow.columns, transitions: workflow.transitions };
  t.mock.method(globalThis, 'fetch', async () => response());
  const result = await executeAction(action, task, {
    agentManager: manager,
    io: manager.io,
    ownerId: null,
    workflow: periodic,
  });
  assert.equal(result.statusChanged, true);
});

test('choosing the current column terminates all remaining actions and transitions', async t => {
  const manager = setup();
  const stay = {
    ...action,
    routes: [{ target: 'triage', description: 'Leave here' }, action.routes[1]],
  };
  workflow.transitions = [
    {
      from: 'triage',
      trigger: 'on_enter',
      actions: [stay, { type: 'change_status', target: 'tech' }],
    },
    { from: 'triage', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'review' }] },
  ];
  const task = await seed();
  t.mock.method(globalThis, 'fetch', async () => response());
  await processColumnEntry(task, manager);
  assert.equal((await getTaskById('task'))?.status, 'triage');
});

test('admin can create/update decision configurations; basic users cannot and secrets stay masked', async () => {
  const manager = setup();
  const harness = createRouteHarness(llmConfigRoutes(manager));
  const admin = harness.as(harnessUser({ role: 'admin' }));
  assert.equal((await harness.post('/', config)).status, 403);
  const created = await admin.post('/', { ...config, managesContext: true });
  assert.equal(created.status, 201);
  const row = await created.json();
  assert.equal(row.managesContext, false);
  assert.equal((await (await harness.get(`/${row.id}`)).json()).apiKey, '********');
  assert.equal(
    (
      await admin.put(`/${row.id}`, {
        model: 'jev-latest',
        endpoint: 'https://api.typesafe.ai/v1',
        apiKey: '********',
      })
    ).status,
    200
  );
  assert.equal(configs.get(row.id)?.apiKey, 'secret');
  assert.equal((await admin.put(`/${row.id}`, { endpoint: 'file:///tmp/model' })).status, 400);
  assert.equal((await admin.post('/', { ...config, model: '' })).status, 400);
  await assert.rejects(
    manager.create({ llmConfigId: 'dm' }),
    /only be used in board decision actions/
  );
});
