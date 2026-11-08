import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';
import {
  activeLoopLots,
  aggregateLoopMetrics,
  LoopMetricsRecorder,
  LOOP_METRICS_TYPE,
  MAX_CALL_RECORDS_PER_TURN,
  summarizeLoopMetrics,
  toolCallMetric,
  toolContextShare,
  type LoopTurnMetrics,
} from '../agentManager/loopMetrics.js';

const agent = { id: 'a1', name: 'Sandbox' };

test('toolCallMetric: run_command exit code, truncation and duration', () => {
  // Pre-lot-1 behaviour: a failing command is reported success:true with exitCode in meta.
  const failing = toolCallMetric(
    'run_command',
    { success: true, result: 'FAIL', durationMs: 1234, meta: { exitCode: 2 } },
    40
  );
  assert.equal(failing.exitCode, 2);
  assert.equal(failing.success, true);
  assert.equal(failing.durationMs, 1234);
  assert.equal(failing.truncated, false);

  const ok = toolCallMetric('run_command', { success: true, result: 'x'.repeat(10_000) }, 10_020);
  assert.equal(ok.exitCode, 0, 'a successful command exits 0');
  assert.equal(ok.truncated, true, 'output at the 10k cap was cut');

  const read = toolCallMetric('read_file', { success: true, result: 'abc' }, 30, true);
  assert.equal(read.exitCode, null);
  assert.equal(read.truncated, true, 'capped by the per-round limit');
  assert.equal(read.outputChars, 3);

  const missing = toolCallMetric('list_dir', undefined, 0);
  assert.equal(missing.success, false);
});

test('toolContextShare counts role:tool characters', () => {
  const share = toolContextShare([
    { role: 'system', content: 'x'.repeat(50) },
    { role: 'user', content: 'x'.repeat(25) },
    { role: 'tool', content: 'x'.repeat(25) },
  ]);
  assert.equal(share, 0.25);
  assert.equal(toolContextShare([]), 0);
});

test('activeLoopLots reads AGENT_LOOP_V2_LOT{n}', () => {
  assert.deepEqual(activeLoopLots({}), []);
  assert.deepEqual(activeLoopLots({ AGENT_LOOP_V2_LOT1: 'true', AGENT_LOOP_V2_LOT3: '0' }), [1]);
});

test('recorder caps detailed calls but keeps exact per-tool totals', () => {
  const rec = new LoopMetricsRecorder(agent, false, []);
  for (let i = 0; i < MAX_CALL_RECORDS_PER_TURN + 5; i++) {
    rec.recordToolCall(toolCallMetric('read_file', { success: true, result: 'a' }, 10));
  }
  const entry = rec.entry('ok');
  assert.equal(entry.calls.length, MAX_CALL_RECORDS_PER_TURN);
  assert.equal(entry.callsOmitted, 5);
  assert.equal(entry.toolCallCount, MAX_CALL_RECORDS_PER_TURN + 5);
  assert.equal(entry.tools.read_file.calls, MAX_CALL_RECORDS_PER_TURN + 5);
});

function turn(over: Partial<LoopTurnMetrics> = {}): LoopTurnMetrics {
  const rec = new LoopMetricsRecorder(agent, false, []);
  rec.recordModelCall({ inputTokens: 100, outputTokens: 10 }, [
    { role: 'user', content: 'xx' },
    { role: 'tool', content: 'xx' },
  ]);
  rec.recordToolRound();
  rec.recordToolCall(
    toolCallMetric('run_command', { success: true, result: 'boom', meta: { exitCode: 1 } }, 20)
  );
  rec.recordToolCall(toolCallMetric('read_file', { success: true, result: 'ok' }, 20));
  return { ...rec.entry('ok'), ...over };
}

test('summarizeLoopMetrics folds turns and ignores other history entries', () => {
  const history = [
    { status: 'execute', at: '2026-11-08T10:00:00Z' },
    turn(),
    turn({ reminder: true, outcome: 'tool-budget' }),
  ];
  const s = summarizeLoopMetrics(history);
  assert.equal(s.turns, 2);
  assert.equal(s.reminders, 1);
  assert.equal(s.toolBudgetHits, 1);
  assert.equal(s.toolCalls, 4);
  assert.equal(s.failedToolCalls, 2, 'non-zero exit codes count as failures');
  assert.equal(s.inputTokens, 200);
  assert.equal(s.outputTokens, 20);
  assert.equal(s.toolRounds, 2);
  assert.equal(s.avgToolContextShare, 0.5);
  const run = s.byTool.find(r => r.name === 'run_command');
  assert.equal(run?.errorRate, 1);
  assert.deepEqual(s.lots, [[]]);
  assert.equal(summarizeLoopMetrics(null).turns, 0);
});

test('aggregateLoopMetrics splits baseline from lot runs', () => {
  const agg = aggregateLoopMetrics([
    [turn()],
    [turn({ lots: [1, 2] }), turn({ lots: [1, 2] })],
    [{ status: 'done' }],
  ]);
  assert.ok(agg);
  assert.equal(agg.tasks, 2);
  assert.equal(agg.byLots.baseline.tasks, 1);
  assert.equal(agg.byLots.baseline.avgTurnsPerTask, 1);
  assert.equal(agg.byLots['lots:1+2'].avgTurnsPerTask, 2);
  assert.equal(agg.toolErrorRate, 0.5);
  assert.equal(aggregateLoopMetrics([[{ status: 'done' }]]), null);
});

test('sendMessage records one loop-metrics entry per native task turn', async () => {
  const manager = new AgentManager(
    { emit() {}, to: () => ({ emit() {} }) },
    null,
    null,
    null
  ) as any;
  const created = await manager.create({ name: 'Sandbox', runner: 'sandbox' });
  manager._buildSystemPrompt = async () => 'Do the task.';
  manager.resolveLlmConfig = () => ({ provider: 'mistral', model: 'test', contextLength: 131072 });
  manager._assembleMessages = async (_a: any, messages: any[], _s: string, user: string) => {
    messages.push({ role: 'user', content: user });
    return { managesContext: false, isTaskExecution: true, activeTaskId: 'task-1' };
  };
  manager._processPostResponseActions = async () => ({ earlyReturn: null });
  manager._processToolCalls = async (_id: string, tools: any[]) =>
    tools.map(tool => ({
      toolCallId: tool.id,
      success: true,
      result: 'tests failed',
      durationMs: 42,
      meta: { exitCode: 1 },
    }));
  let call = 0;
  manager._streamAndContinue = async () => {
    call++;
    return {
      fullResponse: call === 1 ? '' : 'done',
      toolCalls:
        call === 1 ? [{ id: 'c1', name: 'run_command', arguments: { command: 'npm test' } }] : [],
      thinkingBuffer: '',
      finishReason: 'stop',
      inputTokens: 1000,
      outputTokens: 50,
      durationMs: 1,
      llmCalls: 1,
    };
  };
  const recorded: Array<{ taskId: string; entry: LoopTurnMetrics }> = [];
  manager._recordLoopMetrics = (taskId: string, entry: LoopTurnMetrics) =>
    recorded.push({ taskId, entry });

  await manager.sendMessage(created.id, '[SYSTEM REMINDER] finish the task', () => {});

  assert.equal(recorded.length, 1);
  const { taskId, entry } = recorded[0];
  assert.equal(taskId, 'task-1');
  assert.equal(entry.type, LOOP_METRICS_TYPE);
  assert.equal(entry.reminder, true);
  assert.equal(entry.outcome, 'ok');
  assert.equal(entry.llmCalls, 2);
  assert.equal(entry.toolRounds, 1);
  assert.equal(entry.inputTokens, 2000);
  assert.equal(entry.outputTokens, 100);
  assert.deepEqual(
    entry.calls.map(c => [c.name, c.durationMs, c.exitCode]),
    [['run_command', 42, 1]]
  );
  assert.ok(entry.toolContextShare > 0, 'the tool result is part of the second prompt');
});
