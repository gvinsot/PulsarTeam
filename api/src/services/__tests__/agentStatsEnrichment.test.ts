/**
 * Agents-view runtime stats enrichment tests.
 *
 * The agents view renders per-agent "tasks in progress" and "tokens consumed".
 * Those values are cached onto the agent object by the status-module helpers so
 * that _sanitize surfaces them on every socket payload (AGENTS_LIST /
 * agent:updated). This locks in:
 *   - _countTasks: the { waiting, active, done, error, total } breakdown, using
 *     the shared "active = not done/backlog/error" definition.
 *   - _applyTokenFloor: raises in-memory token metrics to the persisted
 *     token_usage_log totals (monotonic max), which is what makes CLI-runner
 *     token counts — recorded out-of-band — show up on the card.
 *   - _enrichAgentStats: pulls both from the (mocked) DB onto the agent.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as realDb from '../database.js';

const dbState: { tasks: any[]; tokens: { input: number; output: number } } = {
  tasks: [],
  tokens: { input: 0, output: 0 },
};
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    getTasksByAgent: async () => dbState.tasks,
    getTotalTokensForAgent: async () => dbState.tokens,
  },
});

const { statusMethods } = await import('../agentManager/status.js');

// Minimal `this`: the enrichment helpers only consult _isActiveTaskStatus,
// _countTasks, _applyTokenFloor, and the agents map.
const isActive = (s: string) => !['done', 'backlog', 'error'].includes(s);
const makeCtx = (agents: Map<string, any> = new Map()) => {
  const ctx: any = { _isActiveTaskStatus: isActive, agents };
  ctx._countTasks = (statusMethods as any)._countTasks.bind(ctx);
  ctx._applyTokenFloor = (statusMethods as any)._applyTokenFloor.bind(ctx);
  ctx._enrichAgentStats = (statusMethods as any)._enrichAgentStats.bind(ctx);
  return ctx;
};

test('_countTasks buckets by status with active = not done/backlog/error', () => {
  const ctx = makeCtx();
  const counts = ctx._countTasks([
    { status: 'execute' },  // active
    { status: 'verify' },   // active
    { status: 'backlog' },  // waiting
    { status: 'done' },     // done
    { status: 'error' },    // error
  ]);
  assert.deepEqual(counts, { waiting: 1, active: 2, done: 1, error: 1, total: 5 });
});

test('_countTasks handles an empty/undefined list', () => {
  const ctx = makeCtx();
  assert.deepEqual(ctx._countTasks([]), { waiting: 0, active: 0, done: 0, error: 0, total: 0 });
  assert.deepEqual(ctx._countTasks(undefined), { waiting: 0, active: 0, done: 0, error: 0, total: 0 });
});

test('_applyTokenFloor raises metrics to DB totals (CLI-runner case)', () => {
  const ctx = makeCtx();
  const agent: any = { metrics: { totalTokensIn: 0, totalTokensOut: 0 } };
  ctx._applyTokenFloor(agent, { input: 1200, output: 340 });
  assert.equal(agent.metrics.totalTokensIn, 1200);
  assert.equal(agent.metrics.totalTokensOut, 340);
});

test('_applyTokenFloor never lowers a higher in-memory value', () => {
  const ctx = makeCtx();
  const agent: any = { metrics: { totalTokensIn: 5000, totalTokensOut: 900 } };
  ctx._applyTokenFloor(agent, { input: 1200, output: 900 });
  assert.equal(agent.metrics.totalTokensIn, 5000, 'kept the higher in-memory value');
  assert.equal(agent.metrics.totalTokensOut, 900);
});

test('_applyTokenFloor initializes a missing metrics object', () => {
  const ctx = makeCtx();
  const agent: any = {};
  ctx._applyTokenFloor(agent, { input: 10, output: 20 });
  assert.deepEqual(agent.metrics, { totalTokensIn: 10, totalTokensOut: 20 });
});

test('_enrichAgentStats writes tasks + token floor onto the agent', async () => {
  const agent: any = { id: 'a1', metrics: { totalTokensIn: 0, totalTokensOut: 0 } };
  const ctx = makeCtx(new Map([['a1', agent]]));
  dbState.tasks = [{ status: 'execute' }, { status: 'done' }];
  dbState.tokens = { input: 42, output: 7 };

  await ctx._enrichAgentStats('a1');

  assert.deepEqual(agent.tasks, { waiting: 0, active: 1, done: 1, error: 0, total: 2 });
  assert.equal(agent.metrics.totalTokensIn, 42);
  assert.equal(agent.metrics.totalTokensOut, 7);
});

test('_enrichAgentStats is a no-op for an unknown agent id', async () => {
  const ctx = makeCtx(new Map());
  await ctx._enrichAgentStats('missing'); // must not throw
});
