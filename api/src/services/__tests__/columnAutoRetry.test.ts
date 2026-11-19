/**
 * Column auto-retry (workflow/columnAutoRetry.ts): the pure planner, the board
 * schema, and the engine wiring (recheckPendingTransitions re-runs the column's
 * flow, with the escalation instruction once it is due).
 *
 * Pool-less: tasks live in the DB fake, the workflow comes from a mocked
 * configManager (same setup as runInvariants.test.ts).
 */
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeTaskDbFake } from './helpers/taskDbFake.js';

const realDb = await import('../database.js');
const { rows, exports: taskDbFake } = makeTaskDbFake();
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...taskDbFake,
    tryAcquireTaskLock: async () => true,
    releaseTaskLock: async () => {},
    getBoardById: async (id: string) =>
      id === 'board-1' ? { id, name: 'Board', workflow: WORKFLOW, user_id: null } : null,
  },
});
const realTasks = await import('../database/tasks.js');
mock.module('../database/tasks.js', { namedExports: { ...realTasks, ...taskDbFake } });

interface Fixture {
  columns: Array<Record<string, unknown> & { id: string }>;
  transitions: Array<Record<string, unknown>>;
}
const WORKFLOW: Fixture = { columns: [], transitions: [] };
mock.module('../configManager.js', {
  namedExports: {
    getWorkflowForBoard: async () => WORKFLOW,
    getAllBoardWorkflows: async () => [{ boardId: 'board-1', workflow: WORKFLOW }],
    getSettings: async () => ({}),
    getWorkflow: async () => WORKFLOW,
    getReminderConfig: async () => ({
      intervalMinutes: 5,
      cooldownMinutes: 1,
      maxReminders: 3,
      intervalMs: 300000,
      cooldownMs: 60000,
    }),
  },
});

const { AgentManager } = await import('../agentManager.js');
const { setCurrentEnvironmentFromHost } = await import('../../lib/environment.js');
setCurrentEnvironmentFromHost('pulsar.example');
const { recheckPendingTransitions } = await import('../workflow/index.js');
const {
  normalizeAutoRetry,
  planAutoRetry,
  nextColumnTimer,
  withEscalationInstructions,
  escalationInstructionsFor,
} = await import('../workflow/columnAutoRetry.js');
const { updateWorkflowSchema } = await import('../../schemas/boards.js');

const mockIo = { emit() {}, to: () => ({ emit() {} }) };
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check: () => boolean, ms = 10_000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await tick(20);
  }
}
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

// ── Pure planner ────────────────────────────────────────────────────────────

test('normalizeAutoRetry: inactive parts are dropped', () => {
  assert.equal(normalizeAutoRetry(null), null);
  assert.equal(normalizeAutoRetry({}), null);
  assert.equal(normalizeAutoRetry({ intervalMinutes: 0 }), null);
  // An escalation delay without an instruction is not an escalation.
  assert.equal(normalizeAutoRetry({ escalateAfterMinutes: 10, escalationInstructions: ' ' }), null);
  assert.deepEqual(normalizeAutoRetry({ intervalMinutes: 30, maxRetries: 3 }), {
    intervalMinutes: 30,
    maxRetries: 3,
    escalateAfterMinutes: null,
    escalationInstructions: null,
  });
  assert.deepEqual(
    normalizeAutoRetry({ escalateAfterMinutes: 60, escalationInstructions: ' Ask for help ' }),
    {
      intervalMinutes: null,
      maxRetries: null,
      escalateAfterMinutes: 60,
      escalationInstructions: 'Ask for help',
    }
  );
});

test('planAutoRetry: retry every interval, from entry then from the last retry', () => {
  const config = normalizeAutoRetry({ intervalMinutes: 30 });
  const now = Date.now();
  assert.equal(planAutoRetry(config, { columnEnteredAt: minutesAgo(10) }, now), null);
  assert.equal(planAutoRetry(config, { columnEnteredAt: minutesAgo(31) }, now), 'retry');
  const timer = nextColumnTimer(null, 'retry', now - 5 * 60_000);
  assert.equal(timer.retries, 1);
  assert.equal(
    planAutoRetry(config, { columnEnteredAt: minutesAgo(90), columnTimer: timer }, now),
    null,
    'the clock restarts at the last retry'
  );
  assert.equal(
    planAutoRetry(config, { columnEnteredAt: minutesAgo(90), pendingOnEnter: true }, now),
    null,
    'no retry while the chain already waits for an agent'
  );
  // Legacy row without column_entered_at falls back to updatedAt.
  assert.equal(planAutoRetry(config, { updatedAt: minutesAgo(45) }, now), 'retry');
});

test('planAutoRetry: maxRetries caps the periodic re-runs', () => {
  const config = normalizeAutoRetry({ intervalMinutes: 1, maxRetries: 2 });
  const state = { columnEnteredAt: minutesAgo(60), columnTimer: { retries: 2 } };
  assert.equal(planAutoRetry(config, state), null);
});

test('planAutoRetry: escalation fires once, and wins over a retry', () => {
  const config = normalizeAutoRetry({
    intervalMinutes: 5,
    escalateAfterMinutes: 60,
    escalationInstructions: 'Ping the lead',
  });
  assert.equal(planAutoRetry(config, { columnEnteredAt: minutesAgo(30) }), 'retry');
  assert.equal(planAutoRetry(config, { columnEnteredAt: minutesAgo(61) }), 'escalate');
  // Escalation is due even while the chain waits for an agent.
  assert.equal(
    planAutoRetry(config, { columnEnteredAt: minutesAgo(61), pendingOnEnter: true }),
    'escalate'
  );
  const timer = nextColumnTimer(null, 'escalate');
  assert.ok(timer.escalatedAt);
  assert.equal(
    planAutoRetry(config, { columnEnteredAt: minutesAgo(61), columnTimer: timer }),
    null
  );
});

test('withEscalationInstructions: appended to run_agent actions only', () => {
  const actions = [
    { type: 'run_agent', instructions: 'Do it' },
    { type: 'change_status', target: 'done' },
  ];
  const out = withEscalationInstructions(actions, 'Escalate now');
  assert.match(String(out[0].instructions), /^Do it\n\n.*Escalate now$/s);
  assert.deepEqual(out[1], actions[1]);
  assert.equal(withEscalationInstructions(actions, null), actions);
  const wf = {
    columns: [
      { id: 'code', autoRetry: { escalateAfterMinutes: 1, escalationInstructions: 'Hurry' } },
    ],
  };
  assert.equal(escalationInstructionsFor(wf, 'code', null), null, 'not escalated yet');
  assert.equal(escalationInstructionsFor(wf, 'code', { escalatedAt: 'x' }), 'Hurry');
});

// ── Schema ──────────────────────────────────────────────────────────────────

test('board schema validates a column autoRetry config', () => {
  const ok = updateWorkflowSchema.safeParse({
    columns: [{ id: 'code', label: 'Code', autoRetry: { intervalMinutes: 30, maxRetries: 0 } }],
  });
  assert.equal(ok.success, true);
  for (const autoRetry of [
    { intervalMinutes: -1 },
    { intervalMinutes: 1.5 },
    { escalateAfterMinutes: 10 },
    { unknownKey: 1 },
  ]) {
    const bad = updateWorkflowSchema.safeParse({
      columns: [{ id: 'code', label: 'Code', autoRetry }],
    });
    assert.equal(bad.success, false, JSON.stringify(autoRetry));
  }
});

// ── Engine ──────────────────────────────────────────────────────────────────

async function setupEngine(autoRetry: Record<string, unknown>) {
  rows.clear();
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'code', autoRetry }, { id: 'done' }];
  WORKFLOW.transitions = [
    {
      from: 'code',
      trigger: 'on_enter',
      actions: [{ type: 'run_agent', mode: 'decide', role: 'dev', instructions: 'Do the work.' }],
    },
  ];
  const mgr: any = new AgentManager(mockIo, null, null, null);
  const created = await mgr.create({ boardId: 'board-1', name: 'Dev', role: 'dev' });
  const raw = mgr.agents.get(created.id);
  raw.status = 'idle';
  raw.boardId = 'board-1';
  raw.conversationHistory = [];
  mgr._saveExecutionLog = async () => {};
  const prompts: string[] = [];
  mgr.sendMessage = async (_a: string, prompt: string, _cb: unknown, _d: unknown, meta: any) => {
    prompts.push(prompt);
    await mgr.setTaskStatus(null, meta.taskId, 'done', { by: 'Dev' });
    return 'ok';
  };
  return { mgr, prompts };
}

function seed(task: Record<string, unknown>) {
  const row: any = {
    text: 'a task',
    title: null,
    boardId: 'board-1',
    status: 'code',
    assignee: null,
    history: [],
    commits: [],
    environment: 'prod',
    actionRunning: false,
    createdAt: minutesAgo(120),
    ...task,
  };
  rows.set(row.id, row);
  return row;
}

test('an idle task past the retry interval re-runs its column flow', async () => {
  const { mgr, prompts } = await setupEngine({ intervalMinutes: 15 });
  seed({ id: 'retry-task', columnEnteredAt: minutesAgo(20) });

  await recheckPendingTransitions(mgr);
  await waitFor(() => rows.get('retry-task').status === 'done', 10_000, 'retried run');
  assert.equal(prompts.length, 1);
  assert.doesNotMatch(prompts[0], /Additional instruction/);
  const entry = rows.get('retry-task').history.find((h: any) => h.type === 'auto_retry');
  assert.ok(entry, 'the retry is recorded in the history');
  assert.equal(entry.retry, 1);
  assert.equal(rows.get('retry-task').columnTimer, null, 'the move reset the timer');
});

test('a task not yet due is left alone', async () => {
  const { mgr, prompts } = await setupEngine({ intervalMinutes: 15 });
  seed({ id: 'fresh-task', columnEnteredAt: minutesAgo(2) });

  await recheckPendingTransitions(mgr);
  await tick(200);
  assert.equal(prompts.length, 0);
  assert.equal(rows.get('fresh-task').status, 'code');
});

test('after the escalation delay the flow re-runs with the extra instruction', async () => {
  const { mgr, prompts } = await setupEngine({
    escalateAfterMinutes: 60,
    escalationInstructions: 'Summarize the blocker in a comment.',
  });
  seed({ id: 'esc-task', columnEnteredAt: minutesAgo(61) });

  await recheckPendingTransitions(mgr);
  await waitFor(() => rows.get('esc-task').status === 'done', 10_000, 'escalated run');
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Summarize the blocker in a comment\./);
  assert.ok(
    rows.get('esc-task').history.some((h: any) => h.type === 'auto_retry_escalation'),
    'the escalation is recorded in the history'
  );
});

test('a stopped task is never auto-retried', async () => {
  const { mgr, prompts } = await setupEngine({ intervalMinutes: 1 });
  seed({ id: 'stopped-task', columnEnteredAt: minutesAgo(30), executionStatus: 'stopped' });

  await recheckPendingTransitions(mgr);
  await tick(200);
  assert.equal(prompts.length, 0);
});
