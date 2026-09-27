// ── CLI-runner activity detection (agentManager/cliActivity.ts) ──────────────
//
// Regression: a CLI agent that kept thinking/working flipped back to "idle"
// after 5 s of terminal silence — or never went busy at all when no browser
// terminal was open — so the task looked stopped and the reminder loop nudged
// it mid-work. These tests pin the new rules: a long quiet threshold, the
// runner's own `idle_seconds` consulted before going idle, and a heartbeat that
// keeps a watched task's agent busy with no viewer attached.

import test, { beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLI_ACTIVITY_IDLE_MS,
  CLI_ACTIVITY_HEARTBEAT_MS,
  noteCliActivity,
  isCliRecentlyActive,
  watchCliActivity,
  _resetCliActivity,
} from '../agentManager/cliActivity.js';

/** Runner-side seconds since the PTY last printed; null = no session. */
let runnerIdle: number | null = null;

function makeManager() {
  const agent: any = { id: 'cli', status: 'idle', currentTask: null };
  const mgr: any = {
    agents: new Map([['cli', agent]]),
    setStatus: mock.fn((id: string, status: string) => {
      mgr.agents.get(id).status = status;
    }),
    executionManager: {
      getTerminalSession: async () => (runnerIdle === null ? null : { idle_seconds: runnerIdle }),
    },
  };
  return { mgr, agent };
}

/** Advance fake time, then let the async idle check / heartbeat settle. */
async function advance(ms: number) {
  mock.timers.tick(ms);
  for (let i = 0; i < 5; i++) await new Promise(r => setImmediate(r));
}

beforeEach(() => {
  runnerIdle = null;
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 });
});
afterEach(() => {
  _resetCliActivity();
  mock.timers.reset();
});

test('console activity marks the agent busy and a short pause does not idle it', async () => {
  const { mgr, agent } = makeManager();
  noteCliActivity(mgr, 'cli');
  assert.equal(agent.status, 'busy');

  // The old 5 s threshold: a thinking pause no longer drops it to idle.
  await advance(5_000);
  assert.equal(agent.status, 'busy');
  assert.ok(isCliRecentlyActive('cli'));
});

test('goes idle once quiet for the threshold, when the runner agrees', async () => {
  const { mgr, agent } = makeManager();
  noteCliActivity(mgr, 'cli');
  runnerIdle = CLI_ACTIVITY_IDLE_MS / 1000 + 1;
  await advance(CLI_ACTIVITY_IDLE_MS + 10);
  assert.equal(agent.status, 'idle');
  assert.equal(isCliRecentlyActive('cli'), false);
});

test('stays busy while the runner PTY is still printing, with no viewer relaying it', async () => {
  const { mgr, agent } = makeManager();
  noteCliActivity(mgr, 'cli');
  runnerIdle = 2; // the CLI redrew 2 s ago
  await advance(CLI_ACTIVITY_IDLE_MS + 10);
  assert.equal(agent.status, 'busy');

  // Then the CLI really goes quiet.
  runnerIdle = 999;
  await advance(CLI_ACTIVITY_IDLE_MS);
  assert.equal(agent.status, 'idle');
});

test('a chat turn (currentTask set) owns the busy flag', async () => {
  const { mgr, agent } = makeManager();
  noteCliActivity(mgr, 'cli');
  agent.currentTask = 'chat turn';
  runnerIdle = 999;
  await advance(CLI_ACTIVITY_IDLE_MS + 10);
  assert.equal(agent.status, 'busy');
});

test('a watched task keeps the agent busy from runner activity alone', async () => {
  const { mgr, agent } = makeManager();
  const stop = watchCliActivity(mgr, 'cli');
  assert.equal(agent.status, 'busy', 'busy as soon as the prompt is injected');

  // Long run, nobody watching the terminal; the runner keeps seeing output.
  runnerIdle = 1;
  for (let t = 0; t < 3 * CLI_ACTIVITY_IDLE_MS; t += CLI_ACTIVITY_HEARTBEAT_MS) {
    await advance(CLI_ACTIVITY_HEARTBEAT_MS);
    assert.equal(agent.status, 'busy', `still busy at +${t}ms`);
  }

  // The CLI finished and sits at its prompt → idle within the threshold.
  runnerIdle = 999;
  await advance(CLI_ACTIVITY_IDLE_MS + CLI_ACTIVITY_HEARTBEAT_MS);
  assert.equal(agent.status, 'idle');

  stop();
});

test('an idle agent is brought back to busy when the runner shows activity again', async () => {
  const { mgr, agent } = makeManager();
  const stop = watchCliActivity(mgr, 'cli');
  runnerIdle = 999;
  await advance(CLI_ACTIVITY_IDLE_MS + CLI_ACTIVITY_HEARTBEAT_MS);
  assert.equal(agent.status, 'idle');

  runnerIdle = 0.5;
  await advance(CLI_ACTIVITY_HEARTBEAT_MS);
  assert.equal(agent.status, 'busy');
  stop();
});

test('stopping the watch stops the heartbeat', async () => {
  const { mgr, agent } = makeManager();
  const stop = watchCliActivity(mgr, 'cli');
  stop();
  stop(); // idempotent
  runnerIdle = 999;
  await advance(CLI_ACTIVITY_IDLE_MS + 10);
  assert.equal(agent.status, 'idle');

  runnerIdle = 0;
  await advance(CLI_ACTIVITY_HEARTBEAT_MS * 3);
  assert.equal(agent.status, 'idle', 'no heartbeat after stop');
});

test('unknown agents are ignored', () => {
  const { mgr } = makeManager();
  noteCliActivity(mgr, 'ghost');
  assert.equal(mgr.setStatus.mock.callCount(), 0);
  assert.equal(isCliRecentlyActive('ghost'), false);
});
