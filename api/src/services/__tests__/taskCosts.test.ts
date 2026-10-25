import test from 'node:test';
import assert from 'node:assert/strict';
import { executionWindows, buildTaskCostSummary } from '../taskCosts.js';

test('executionWindows keeps only complete execution entries', () => {
  const windows = executionWindows([
    { type: 'execution', by: 'Dev', startedAt: '2026-10-25T10:00:00Z', at: '2026-10-25T10:05:00Z' },
    { type: 'execution', by: 'Dev' /* no startedAt */, at: '2026-10-25T11:00:00Z' },
    { type: 'status', by: 'user', startedAt: '2026-10-25T10:00:00Z', at: '2026-10-25T10:01:00Z' },
    { type: 'execution', by: 'QA', startedAt: '2026-10-25T12:00:00Z', at: '2026-10-25T11:00:00Z' },
  ]);
  assert.deepEqual(windows, [
    { agentName: 'Dev', start: '2026-10-25T10:00:00Z', end: '2026-10-25T10:05:00Z' },
  ]);
  assert.deepEqual(executionWindows(null), []);
});

test('buildTaskCostSummary merges run time and token usage per agent', () => {
  const summary = buildTaskCostSummary(
    [
      { agentName: 'Dev', start: '2026-10-25T10:00:00Z', end: '2026-10-25T10:05:00Z' },
      { agentName: 'Dev', start: '2026-10-25T11:00:00Z', end: '2026-10-25T11:01:00Z' },
      { agentName: 'QA', start: '2026-10-25T12:00:00Z', end: '2026-10-25T12:00:30Z' },
    ],
    [
      {
        agent_id: 'a1',
        agent_name: 'Dev',
        input_tokens: 1000,
        output_tokens: 200,
        context_tokens: 50,
        cost: 0.5,
        request_count: 3,
        estimated: false,
      },
      {
        agent_id: 'a3',
        agent_name: 'Reviewer',
        input_tokens: 10,
        output_tokens: 5,
        context_tokens: 0,
        cost: 1.25,
        request_count: 1,
        estimated: true,
      },
    ]
  );
  assert.equal(summary.byAgent.length, 3);
  assert.equal(summary.byAgent[0].agentName, 'Reviewer');
  const dev = summary.byAgent.find(a => a.agentName === 'Dev')!;
  assert.equal(dev.agentId, 'a1');
  assert.equal(dev.timeMs, 6 * 60 * 1000);
  assert.equal(dev.runs, 2);
  assert.equal(dev.inputTokens, 1000);
  const qa = summary.byAgent.find(a => a.agentName === 'QA')!;
  assert.equal(qa.agentId, null);
  assert.equal(qa.cost, 0);
  assert.deepEqual(summary.totals, {
    inputTokens: 1010,
    outputTokens: 205,
    contextTokens: 50,
    cost: 1.75,
    requests: 4,
    timeMs: 6 * 60 * 1000 + 30 * 1000,
    runs: 3,
    estimated: true,
  });
  assert.equal(summary.running, false);
});
