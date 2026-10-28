import test from 'node:test';
import assert from 'node:assert/strict';
import { decideColumn, decisionEndpoint } from '../decisionModel.js';
import { decisionActionSchema, decisionConfigSchema } from '../../schemas/decision.js';
import { updateWorkflowSchema } from '../../schemas/boards.js';
import { normalizeWorkflowColumnIds } from '../workflow/columnIds.js';
import { createProvider } from '../llmProviders.js';
import { getWorkflowManagedStatuses } from '../workflow/taskStateMachine.js';

const config = {
  id: 'decision',
  provider: 'decision',
  model: 'd3-mini',
  endpoint: 'http://llamacpp-decision-service:8000',
};
const state = {
  title: 'Facture',
  description: 'Prélevé deux fois',
  taskType: 'bug',
  priority: 'high',
};
const routes = [
  { target: 'billing', description: 'Factures et paiements' },
  { target: 'support', description: 'Problèmes techniques' },
];
const action = {
  type: 'decision_model',
  llmConfigId: config.id,
  instructions: 'Quelle équipe ?',
  routes,
  minConfidence: 0.6,
  fallbackTarget: 'review',
};
const columns = [
  { id: 'billing', label: 'Billing' },
  { id: 'support', label: 'Support' },
  { id: 'review', label: 'Review' },
];
const reply = (overrides = {}) => ({
  answers: {
    route: {
      type: 'choice',
      choice: 'route_0',
      confidence: 0.8,
      probabilities: { route_0: 0.95, route_1: 0.05 },
      ...overrides,
    },
  },
  usage: { input_tokens: 50, output_tokens: 0 },
});

test('System One normalizes root, /v1 and full URLs, and rejects non-service URLs', () => {
  for (const path of ['', '/', '/v1', '/v1/', '/v1/systemone', '/v1/systemone/']) {
    assert.equal(
      decisionEndpoint(`http://localhost:8001${path}`),
      'http://localhost:8001/v1/systemone'
    );
  }
  for (const endpoint of [
    'file:///etc/passwd',
    'http://user:pass@host',
    'http://host?key=secret',
    'http://host/#fragment',
    'invalid',
  ]) {
    assert.throws(() => decisionEndpoint(endpoint));
    assert.equal(decisionConfigSchema.safeParse({ ...config, endpoint }).success, false);
  }
  assert.equal(decisionConfigSchema.safeParse(config).success, true);
});

test('d3 and Jev use a choice request with isolated state, opaque options and optional bearer auth', async t => {
  const calls: Array<{ url: string; options?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string, options?: RequestInit) => {
    calls.push({ url, options });
    return Response.json(reply());
  });
  for (const cfg of [
    config,
    { ...config, endpoint: 'https://api.typesafe.ai/v1', model: 'jev-latest', apiKey: 'test-key' },
  ]) {
    const result = await decideColumn(cfg, state, action.instructions, routes);
    assert.equal(result.target, 'billing');
    assert.equal(result.confidence, 0.8);
    assert.equal(result.usage?.output_tokens, 0);
  }
  const first = calls[0];
  assert.equal(first.url, 'http://llamacpp-decision-service:8000/v1/systemone');
  assert.equal(first.options?.redirect, 'error');
  const body = JSON.parse(String(first.options?.body));
  assert.deepEqual(body.state, state);
  assert.deepEqual(body.questions.route.criteria, {
    route_0: routes[0].description,
    route_1: routes[1].description,
  });
  assert.equal(body.messages, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(new Headers(first.options?.headers).has('Authorization'), false);
  assert.equal(new Headers(calls[1].options?.headers).get('Authorization'), 'Bearer test-key');
});

test('malformed, unknown, non-finite, incomplete and contradictory choices fail closed', async t => {
  const malformed = [
    {},
    reply({ choice: 'unconfigured' }),
    reply({ confidence: null }),
    reply({ confidence: 2 }),
    reply({ type: 'noul' }),
    reply({ probabilities: {} }),
    reply({ probabilities: { route_0: 1, route_1: 1 } }),
    reply({ probabilities: { route_0: 0.1, route_1: 0.9 } }),
    reply({ probabilities: { route_0: 0.9, route_1: 0.1, extra: 0 } }),
  ];
  const fetchMock = t.mock.method(globalThis, 'fetch');
  for (const value of malformed) {
    fetchMock.mock.mockImplementation(async () => Response.json(value));
    await assert.rejects(decideColumn(config, state, action.instructions, routes), /invalid/i);
  }
});

test('HTTP failures, timeout, oversized body and oversized task never leak provider data', async t => {
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('secret-key', { status: 401 })
  );
  await assert.rejects(decideColumn(config, state, action.instructions, routes), {
    message: 'Decision service returned HTTP 401',
  });
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('secret-key timeout');
  });
  await assert.rejects(decideColumn(config, state, action.instructions, routes), {
    message: 'Decision service unavailable or timed out',
  });
  fetchMock.mock.mockImplementation(async () => new Response('a'.repeat(65537)));
  await assert.rejects(
    decideColumn(config, state, action.instructions, routes),
    /invalid response/
  );
  await assert.rejects(
    decideColumn(config, { ...state, description: 'a'.repeat(12000) }, action.instructions, routes),
    /too long/
  );
  assert.equal(fetchMock.mock.callCount(), 3);
});

test('decision workflow schema validates bounds, destinations and uniqueness; rename rewrites routes and fallback', () => {
  const workflow = {
    columns,
    transitions: [{ from: 'review', trigger: 'on_enter', actions: [action] }],
  };
  assert.equal(updateWorkflowSchema.safeParse(workflow).success, true);
  for (const change of [
    { minConfidence: -1 },
    { minConfidence: NaN },
    { instructions: '' },
    { llmConfigId: '' },
    { routes: [routes[0]] },
    { routes: [routes[0], routes[0]] },
  ]) {
    assert.equal(decisionActionSchema.safeParse({ ...action, ...change }).success, false);
  }
  for (const change of [
    { fallbackTarget: 'elsewhere' },
    { routes: [{ target: 'elsewhere', description: 'Elsewhere' }, routes[1]] },
  ]) {
    assert.equal(
      updateWorkflowSchema.safeParse({
        ...workflow,
        transitions: [{ from: 'review', trigger: 'on_enter', actions: [{ ...action, ...change }] }],
      }).success,
      false
    );
  }
  const renamed = normalizeWorkflowColumnIds(
    { ...workflow, columns: columns.map(c => ({ ...c, label: `New ${c.label}` })) },
    workflow
  ).workflow;
  const renamedAction = renamed.transitions?.[0].actions[0];
  assert.equal(renamedAction.routes[0].target, 'new_billing');
  assert.equal(renamedAction.fallbackTarget, 'new_review');
  assert.ok(getWorkflowManagedStatuses([{ boardId: 'board', workflow }]).has('review'));
});

test('decision models cannot create a chat provider, including behind a CLI runner', () => {
  assert.throws(() => createProvider(config), /only available in board decision actions/);
  assert.throws(
    () => createProvider({ provider: 'codex', llmConfig: config }),
    /only available in board decision actions/
  );
});
