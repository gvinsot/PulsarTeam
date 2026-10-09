/**
 * Workflow-engine invariants:
 *   I1 — an agent never has two active tasks: one live run per agent, enforced
 *        by the DB claim across processes/environments, never released while
 *        its CLI is still working, never pasted into a busy terminal;
 *   I2 — a run's work lands on its own task (completion signals, current-task
 *        resolution, stops scoped to what the agent executes);
 * plus the chain bookkeeping fixes (condition-chain continuation, resume point
 * per transition, guarded writes).
 *
 * Pool-less: tasks live in the identity-preserving DB fake, the workflow is
 * served by a mocked configManager.
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
    // Board-level moves validate the target column against the board.
    getBoardById: async (id: string) =>
      id === 'board-1' ? { id, name: 'Board', workflow: WORKFLOW, user_id: null } : null,
  },
});

// Some modules (swarmApiMcp, the MCP task tools) import the task accessors
// straight from database/tasks.js.
const realTasks = await import('../database/tasks.js');
mock.module('../database/tasks.js', { namedExports: { ...realTasks, ...taskDbFake } });

interface Fixture {
  columns: Array<{ id: string; label?: string }>;
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
setCurrentEnvironmentFromHost('pulsar.example'); // locks the 'prod' environment
const { processColumnEntry, recheckPendingTransitions } = await import('../workflow/index.js');
const { isAgentBusy } = await import('../workflow/agentSelector.js');
const { getTaskSignal, setAwaitingCompletion, clearTaskSignals } =
  await import('../agentManager/tasks.js');
const { resolveAgentCurrentTask } = await import('../agentManager/currentTask.js');
// Every module is loaded here, before the first test is registered: a top-level
// await still pending while tests run (a dynamic import racing the module-mock
// loader hooks) fails the whole file once the event loop drains.
const { stopTaskExecution } = await import('../taskControl.js');
const { reconcileStaleActionRunning } = await import('../workflow/workflowEngine.js');

const mockIo = {
  emit() {},
  to() {
    return { emit() {} };
  },
};

const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 20_000, label = 'condition') {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await tick(20);
  }
}

async function setup(agentDefs: Array<Record<string, unknown>>) {
  rows.clear();
  const mgr: any = new AgentManager(mockIo, null, null, null);
  const ids: Record<string, string> = {};
  for (const def of agentDefs) {
    const created = await mgr.create({ boardId: 'board-1', ...def });
    const raw = mgr.agents.get(created.id);
    raw.status = 'idle';
    raw.boardId = 'board-1';
    raw.conversationHistory = [];
    if (def.runner) raw.runner = def.runner;
    ids[String(def.name)] = created.id;
  }
  mgr._saveExecutionLog = async () => {};
  return { mgr, ids };
}

function seed(task: Record<string, unknown>) {
  const row: any = {
    text: 'a task',
    title: null,
    boardId: 'board-1',
    assignee: null,
    history: [],
    commits: [],
    environment: 'prod',
    actionRunning: false,
    createdAt: new Date().toISOString(),
    ...task,
  };
  rows.set(row.id as string, row);
  return row;
}

const DECIDE = (role: string) => ({
  type: 'run_agent',
  mode: 'decide',
  role,
  instructions: 'Do the work, then move the task to done.',
});

// ── I1: one live run per agent ──────────────────────────────────────────────

test('an agent running a task anywhere (sibling stack) is never given a second one', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [{ from: 'code', trigger: 'on_enter', actions: [DECIDE('dev')] }];
  const { mgr, ids } = await setup([{ name: 'Dev', role: 'dev' }]);
  const dev = ids.Dev;
  const prompts: string[] = [];
  mgr.sendMessage = async (
    _agentId: string,
    _prompt: string,
    _cb: unknown,
    _d: unknown,
    meta: any
  ) => {
    prompts.push(meta?.taskId);
    await mgr.setTaskStatus(null, meta.taskId, 'done', { by: 'Dev' });
    return 'ok';
  };

  // The QA stack runs a task on the very same (shared) agent: a live claim.
  seed({
    id: 'qa-task',
    status: 'code',
    environment: 'qa',
    actionRunning: true,
    actionRunningAgentId: dev,
    actionRunningMode: 'decide',
    actionHeartbeatAt: new Date().toISOString(),
  });
  const task = seed({ id: 'prod-task', status: 'code' });

  await processColumnEntry({ ...task }, mgr, { by: 'test' });
  assert.deepEqual(prompts, [], 'no prompt for a second task while the agent runs one');
  assert.equal(rows.get('prod-task').actionRunning, false);
  assert.equal(rows.get('prod-task')._pendingOnEnter, 'code', 'left armed for a retry');

  // The QA run ends: the agent is free, the retry runs the task once.
  Object.assign(rows.get('qa-task'), { actionRunning: false, actionRunningAgentId: null });
  await processColumnEntry({ ...rows.get('prod-task') }, mgr, { by: 'test' });
  assert.deepEqual(prompts, ['prod-task']);
  assert.equal(rows.get('prod-task').status, 'done');
  assert.equal(rows.get('prod-task').actionRunning, false, 'claim released');
  assert.equal(isAgentBusy(dev), false);
});

test('a CLI terminal still printing is never pasted into', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [{ from: 'code', trigger: 'on_enter', actions: [DECIDE('dev')] }];
  const { mgr } = await setup([{ name: 'Cli', role: 'dev', runner: 'claudecode' }]);
  const pasted: string[] = [];
  mgr.executionManager = {
    getTerminalSession: async () => ({ alive: true, idle_seconds: 1 }), // busy
    sendTerminalInput: async (_id: string, input: string) => {
      pasted.push(input);
      return true;
    },
  };
  const task = seed({ id: 'busy-cli', status: 'code' });
  await processColumnEntry({ ...task }, mgr, { by: 'test' });
  assert.deepEqual(pasted, []);
  assert.equal(rows.get('busy-cli').actionRunning, false, 'not claimed');
  assert.equal(rows.get('busy-cli')._pendingOnEnter, 'code', 'retried later');
});

test('a CLI run holds its agent until the terminal is quiet, not just until the verdict', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [{ from: 'code', trigger: 'on_enter', actions: [DECIDE('dev')] }];
  const { mgr, ids } = await setup([{ name: 'Cli', role: 'dev', runner: 'claudecode' }]);
  const cli = ids.Cli;
  let phase: 'idle' | 'working' | 'wrapping-up' = 'idle';
  let wrapUpPolls = 0;
  const duringWrapUp: Array<{ reserved: boolean; claimed: boolean }> = [];
  // A tiny git: the commits the CLI creates, seen through the reflog queries
  // the reconcile runs (gitReconcile.ts).
  const created: Array<{ hash: string; msg: string; at: number }> = [];
  const BASE = 'b'.repeat(40);
  const TAB = String.fromCharCode(9);
  const NL = String.fromCharCode(10);
  mgr.executionManager = {
    exec: async (_id: string, command: string) => {
      const hashes = created.map(c => c.hash).join(NL);
      if (command.includes('reflog')) {
        const line = (c: { hash: string; msg: string; at: number }) =>
          [c.hash, `HEAD@{${c.at}}`, `commit: ${c.msg}`, c.msg, String(c.at)].join(TAB);
        return { stdout: created.map(line).join(NL) };
      }
      if (command.includes('--not --remotes')) return { stdout: hashes };
      if (command.includes('log --format=%H')) return { stdout: hashes };
      if (command.includes('rev-parse HEAD')) return { stdout: BASE };
      return { stdout: '' };
    },
    getTerminalSession: async () => {
      if (phase === 'wrapping-up') {
        duringWrapUp.push({
          reserved: isAgentBusy(cli),
          claimed: rows.get('cli-task').actionRunning === true,
        });
        // The CLI keeps printing after it moved the card — and commits once more.
        if (wrapUpPolls === 0) {
          created.push({
            hash: 'c'.repeat(40),
            msg: 'tail commit',
            at: Math.floor(Date.now() / 1000),
          });
        }
        if (++wrapUpPolls >= 3) phase = 'idle';
        return { alive: true, idle_seconds: 0 };
      }
      return { alive: true, idle_seconds: phase === 'idle' ? 60 : 0 };
    },
    sendTerminalInput: async () => {
      phase = 'working';
      // The agent moves the card (its verdict) and then keeps working a bit.
      setTimeout(async () => {
        await mgr.setTaskStatus(null, 'cli-task', 'done', { by: 'Cli' });
        phase = 'wrapping-up';
      }, 50);
      return true;
    },
  };
  const task = seed({ id: 'cli-task', status: 'code' });

  await processColumnEntry({ ...task }, mgr, { by: 'test' });

  assert.ok(duringWrapUp.length >= 2, 'the run waited while the CLI wrapped up');
  for (const sample of duringWrapUp) {
    assert.equal(sample.reserved, true, 'agent still reserved while its CLI works');
    assert.equal(sample.claimed, true, 'claim held while its CLI works');
  }
  assert.equal(rows.get('cli-task').status, 'done');
  assert.equal(rows.get('cli-task').actionRunning, false, 'claim released once quiet');
  assert.equal(isAgentBusy(cli), false, 'agent released once quiet');
  // The commit made after the verdict, while the CLI wrapped up, is this task's.
  assert.deepEqual(
    rows.get('cli-task').commits.map((c: { hash: string }) => c.hash),
    ['c'.repeat(40)]
  );
  assert.equal(rows.get('cli-task').commitRun ?? null, null, 'run context closed');
});

// ── Chain bookkeeping ───────────────────────────────────────────────────────

test('a condition chain that moves the task starts the next column (no stranding)', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'todo' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [
    {
      from: 'todo',
      trigger: 'condition',
      conditions: [{ field: 'idle_agent_available', operator: 'eq', value: 'dev' }],
      actions: [{ type: 'change_status', target: 'code' }],
    },
    { from: 'code', trigger: 'on_enter', actions: [DECIDE('dev')] },
  ];
  const { mgr } = await setup([{ name: 'Dev', role: 'dev' }]);
  const prompts: string[] = [];
  mgr.sendMessage = async (_a: string, _p: string, _cb: unknown, _d: unknown, meta: any) => {
    prompts.push(meta?.taskId);
    await mgr.setTaskStatus(null, meta.taskId, 'done', { by: 'Dev' });
    return 'ok';
  };
  seed({ id: 'cond-task', status: 'todo' });

  await recheckPendingTransitions(mgr);
  await waitFor(() => rows.get('cond-task').status === 'done', 10_000, 'task done');
  assert.deepEqual(prompts, ['cond-task'], "the next column's run_agent ran exactly once");
});

test('a chain resumes in the transition that was skipped, never replaying or skipping others', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'spec' }, { id: 'ready' }, { id: 'done' }];
  WORKFLOW.transitions = [
    {
      from: 'spec',
      trigger: 'on_enter',
      actions: [
        { type: 'run_agent', mode: 'title', role: 'writer' },
        { type: 'run_agent', mode: 'refine', role: 'pm', instructions: 'Clarify.' },
      ],
    },
    { from: 'spec', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'ready' }] },
  ];
  const { mgr } = await setup([{ name: 'Writer', role: 'writer' }]);
  let titleCalls = 0;
  mgr.sendMessage = async (_a: string, prompt: string) => {
    if (/short, concise title/.test(prompt)) titleCalls++;
    return 'A title';
  };
  const task = seed({ id: 'spec-task', status: 'spec' });

  // No pm yet: title runs, refine is skipped → resume point in transition 0.
  await processColumnEntry({ ...task }, mgr, { by: 'test' });
  const row = rows.get('spec-task');
  assert.equal(row.status, 'spec');
  assert.equal(row._pendingOnEnter, 'spec');
  assert.equal(row.resumeTransitionIdx, 0);
  assert.equal(row.completedActionIdx, 0);
  assert.equal(titleCalls, 1);

  // A pm appears: the retry runs refine (not title again), then the second
  // transition — whose change_status the old shared index skipped forever.
  const pm = await mgr.create({ boardId: 'board-1', name: 'Pm', role: 'pm' });
  Object.assign(mgr.agents.get(pm.id), {
    status: 'idle',
    boardId: 'board-1',
    conversationHistory: [],
  });
  await processColumnEntry({ ...rows.get('spec-task') }, mgr, { by: 'on-enter-retry' });
  assert.equal(titleCalls, 1, 'completed actions are not replayed');
  assert.equal(rows.get('spec-task').status, 'ready');
});

test('a chain never writes its bookkeeping onto a task that left its column', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'a' }, { id: 'b' }, { id: 'done' }];
  WORKFLOW.transitions = [
    { from: 'a', trigger: 'on_enter', actions: [{ type: 'change_status', target: 'b' }] },
    { from: 'b', trigger: 'on_enter', actions: [DECIDE('nobody')] }, // no such role: skipped
  ];
  const { mgr } = await setup([{ name: 'Dev', role: 'dev' }]);
  const task = seed({ id: 'moving', status: 'a' });
  await processColumnEntry({ ...task }, mgr, { by: 'test' });
  // First the deferral marker (b entered while a's chain held the task), then
  // b's own chain runs (continuation), skips, and records ITS resume point.
  await waitFor(() => rows.get('moving').resumeTransitionIdx === 0, 5_000, "b's resume point");
  const row = rows.get('moving');
  assert.equal(row.status, 'b');
  // b's own skipped chain armed it (transition 0, before its first action) —
  // not a's chain, whose index would point past b's actions.
  assert.equal(row.resumeTransitionIdx, 0);
  assert.equal(row.completedActionIdx, -1);
});

// ── Stops, completions, current task ────────────────────────────────────────

test('stopping an agent halts only what it executes, never the tasks it merely owns', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'todo' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [];
  const { mgr, ids } = await setup([
    { name: 'Owner', role: 'dev' },
    { name: 'Other', role: 'dev' },
  ]);
  const owner = ids.Owner;
  const waiting = seed({ id: 'owned-waiting', status: 'todo', agentId: owner });
  const othersRun = seed({
    id: 'owned-run-by-other',
    status: 'code',
    agentId: owner,
    assignee: ids.Other,
    actionRunning: true,
    actionRunningAgentId: ids.Other,
    startedAt: new Date().toISOString(),
  });
  const ownRun = seed({
    id: 'run-by-owner',
    status: 'code',
    agentId: owner,
    assignee: owner,
    actionRunning: true,
    actionRunningAgentId: owner,
    startedAt: new Date().toISOString(),
  });

  mgr.stopAgent(owner);
  await waitFor(() => rows.get('run-by-owner').executionStatus === 'stopped', 5_000, 'stop');
  assert.equal(rows.get(ownRun.id).actionRunning, false);
  assert.equal(rows.get(waiting.id).executionStatus ?? null, null, 'owned waiting task untouched');
  assert.equal(rows.get(othersRun.id).executionStatus ?? null, null, "other agent's run untouched");
  assert.equal(rows.get(othersRun.id).actionRunning, true);
});

test('a stop observed before a move never sends the task back to its old column', async () => {
  const { mgr } = await setup([{ name: 'Dev', role: 'dev' }]);
  const seen = { ...seed({ id: 'moved-meanwhile', status: 'code' }) };
  rows.get('moved-meanwhile').status = 'backlog'; // a concurrent move lands first
  const result = await mgr._markTaskStopped(seen, new Date().toISOString());
  assert.equal(result, null, 'guarded write refused');
  assert.equal(rows.get('moved-meanwhile').status, 'backlog');
  assert.equal(rows.get('moved-meanwhile').executionStatus ?? null, null);
});

test('a completion recorded while no run waits for it raises no signal', async () => {
  const { mgr, ids } = await setup([{ name: 'Dev', role: 'dev' }]);
  seed({ id: 'idle-task', status: 'code', agentId: ids.Dev });
  clearTaskSignals('idle-task');
  await mgr.recordTaskCompletion(ids.Dev, { comment: 'did it', explicitTaskId: 'idle-task' });
  assert.equal(getTaskSignal('idle-task', 'completed'), undefined);

  setAwaitingCompletion('idle-task', true);
  await mgr.recordTaskCompletion(ids.Dev, { comment: 'did it', explicitTaskId: 'idle-task' });
  assert.equal(getTaskSignal('idle-task', 'completed'), true);
  setAwaitingCompletion('idle-task', false);
  clearTaskSignals('idle-task');
});

test("an agent's current task is its live run, or its only assignment — never a guess", async () => {
  const { mgr, ids } = await setup([{ name: 'Dev', role: 'dev' }]);
  const dev = ids.Dev;
  seed({ id: 'assigned-1', status: 'code', assignee: dev });
  seed({ id: 'assigned-2', status: 'review', assignee: dev });
  assert.equal(await resolveAgentCurrentTask(mgr, dev), null, 'ambiguous → unknown');

  rows.get('assigned-2').status = 'done';
  assert.equal((await resolveAgentCurrentTask(mgr, dev))?.id, 'assigned-1', 'the only one');

  seed({
    id: 'running',
    status: 'code',
    actionRunning: true,
    actionRunningAgentId: dev,
    startedAt: new Date().toISOString(),
  });
  rows.get('assigned-2').status = 'review';
  assert.equal((await resolveAgentCurrentTask(mgr, dev))?.id, 'running', 'the live run wins');
});

// ── Review round 2 ──────────────────────────────────────────────────────────

test('a resumed condition chain is not re-gated by conditions its own actions changed', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'review' }, { id: 'done' }];
  WORKFLOW.transitions = [
    {
      from: 'review',
      trigger: 'condition',
      conditions: [{ field: 'task_has_assignee', operator: 'eq', value: 'false' }],
      actions: [{ type: 'assign_agent', role: 'dev' }, DECIDE('dev')],
    },
  ];
  const { mgr, ids } = await setup([{ name: 'Dev', role: 'dev' }]);
  const prompts: string[] = [];
  mgr.sendMessage = async (
    _agentId: string,
    _prompt: string,
    _cb: unknown,
    _d: unknown,
    meta: any
  ) => {
    prompts.push(meta?.taskId);
    await mgr.setTaskStatus(null, meta.taskId, 'done', { by: 'Dev' });
    return 'ok';
  };
  // The chain assigned the task (action 0), then its run was deferred: the
  // condition "no assignee" is false now — because of the chain itself.
  const task = seed({
    id: 'resume-cond',
    status: 'review',
    assignee: ids.Dev,
    _pendingOnEnter: 'review',
    completedActionIdx: 0,
    resumeTransitionIdx: 0,
  });
  await processColumnEntry({ ...task }, mgr, { by: 'test' });
  assert.deepEqual(prompts, ['resume-cond'], 'the chain resumed at its run_agent action');
  assert.equal(rows.get('resume-cond').status, 'done');
});

test('a run is not started on a card moved, or stopped, while it was being prepared', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [{ from: 'code', trigger: 'on_enter', actions: [DECIDE('dev')] }];
  for (const interfere of [
    (row: any) => (row.status = 'backlog'),
    (row: any) => (row.executionStatus = 'stopped'),
  ]) {
    const { mgr } = await setup([{ name: 'Cli', role: 'dev', runner: 'claudecode' }]);
    const pasted: string[] = [];
    const task = seed({ id: 'prep', status: 'code' });
    mgr.executionManager = {
      // The pre-flight is the window between selection and claim.
      getTerminalSession: async () => {
        interfere(rows.get('prep'));
        return { alive: true, idle_seconds: 60 };
      },
      sendTerminalInput: async (_id: string, input: string) => {
        pasted.push(input);
        return true;
      },
    };
    await processColumnEntry({ ...task }, mgr, { by: 'test' });
    assert.deepEqual(pasted, [], 'nothing pasted');
    assert.equal(rows.get('prep').actionRunning, false, 'never claimed');
  }
});

test('a deferral keeps the resume point of a half-run chain', async () => {
  WORKFLOW.columns = [{ id: 'backlog' }, { id: 'code' }, { id: 'done' }];
  WORKFLOW.transitions = [{ from: 'code', trigger: 'on_enter', actions: [DECIDE('dev')] }];
  const { mgr } = await setup([{ name: 'Dev', role: 'dev' }]);
  // Another environment's task: deferred to its own replica.
  const task = seed({
    id: 'qa-half-run',
    status: 'code',
    environment: 'qa',
    _pendingOnEnter: 'code',
    completedActionIdx: 0,
    resumeTransitionIdx: 1,
  });
  await processColumnEntry({ ...task }, mgr, { by: 'test' });
  const row = rows.get('qa-half-run');
  assert.equal(row._pendingOnEnter, 'code');
  assert.equal(row.completedActionIdx, 0, 'completed actions are not run again');
  assert.equal(row.resumeTransitionIdx, 1);
});

test('a Stop persisted by another process ends the wait', async () => {
  const { mgr } = await setup([{ name: 'Dev', role: 'dev' }]);
  seed({ id: 'stopped-elsewhere', status: 'code' });
  assert.equal(await mgr._pollTaskVerdict('stopped-elsewhere', 'a task', 'code'), null);
  rows.get('stopped-elsewhere').executionStatus = 'stopped';
  assert.equal(await mgr._pollTaskVerdict('stopped-elsewhere', 'a task', 'code'), 'stopped');
});

test("stopping the sibling stack's task never interrupts this stack's terminal", async () => {
  const { mgr, ids } = await setup([{ name: 'Cli', role: 'dev', runner: 'claudecode' }]);
  const interrupted: string[] = [];
  mgr.executionManager = {
    interruptCliTerminalSessions: async (id: string) => {
      interrupted.push(id);
      return true;
    },
  };
  const qaTask = seed({
    id: 'qa-run',
    status: 'code',
    environment: 'qa',
    actionRunning: true,
    actionRunningAgentId: ids.Cli,
    actionHeartbeatAt: new Date().toISOString(),
    commitRun: { executorId: ids.Cli, baselineHead: null, startedAt: new Date().toISOString() },
  });
  await stopTaskExecution(mgr, { ...qaTask }, 'user');
  const row = rows.get('qa-run');
  assert.equal(row.executionStatus, 'stopped', 'the stop is persisted for the QA stack to see');
  assert.equal(row.actionRunning, false);
  assert.ok(row.commitRun.endedAt, 'the run window is closed at the stop');
  assert.deepEqual(interrupted, [], 'the local terminal is left alone');
});

test("an orphan run context links its commits up to the run's end, then is dropped", async () => {
  const { mgr, ids } = await setup([{ name: 'Dev', role: 'dev' }]);
  const TAB = String.fromCharCode(9);
  const NL = String.fromCharCode(10);
  const nowSec = Math.floor(Date.now() / 1000);
  const created = [
    { hash: 'd'.repeat(40), msg: 'during the run', at: nowSec - 100 },
    { hash: 'e'.repeat(40), msg: 'after the run ended', at: nowSec - 10 },
  ];
  mgr.executionManager = {
    exec: async (_id: string, command: string) => {
      const hashes = created.map(c => c.hash).join(NL);
      if (command.includes('reflog')) {
        const line = (c: { hash: string; msg: string; at: number }) =>
          [c.hash, `HEAD@{${c.at}}`, `commit: ${c.msg}`, c.msg, String(c.at)].join(TAB);
        return { stdout: created.map(line).join(NL) };
      }
      if (command.includes('--not --remotes')) return { stdout: hashes };
      if (command.includes('log --format=%H')) return { stdout: hashes };
      return { stdout: '' };
    },
  };
  seed({
    id: 'orphan-run',
    status: 'code',
    commitRun: {
      executorId: ids.Dev,
      baselineHead: null,
      startedAt: new Date((nowSec - 200) * 1000).toISOString(),
      endedAt: new Date((nowSec - 50) * 1000).toISOString(),
    },
  });
  await reconcileStaleActionRunning(mgr, 'prod');
  const row = rows.get('orphan-run');
  assert.deepEqual(
    row.commits.map((c: any) => c.hash),
    ['d'.repeat(40)],
    'only the commit made before the run ended'
  );
  assert.equal(row.commitRun, null, 'the context is consumed');
});

test('a run context whose repo cannot be read is kept for a retry, not dropped', async () => {
  const { mgr, ids } = await setup([{ name: 'Dev', role: 'dev' }]);
  mgr.executionManager = {
    exec: async () => {
      throw new Error('runner unreachable');
    },
  };
  seed({
    id: 'unreadable-run',
    status: 'code',
    commitRun: {
      executorId: ids.Dev,
      baselineHead: null,
      startedAt: new Date(Date.now() - 60_000).toISOString(),
      endedAt: new Date().toISOString(),
    },
  });
  await reconcileStaleActionRunning(mgr, 'prod');
  const row = rows.get('unreadable-run');
  assert.ok(row.commitRun, 'kept');
  assert.equal(row.commitRun.recoverAttempts, 1);
});
