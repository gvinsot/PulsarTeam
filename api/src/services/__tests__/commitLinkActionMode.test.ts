// Regression: a CLI runner (claude-code, aider, codex, …) commits inside its own
// interactive PTY, so its `git commit`/`git push` never flows through the
// @run_command tool and the real-time detector in commitDetection.ts never sees
// it. The runner then finishes by calling update_task WHILE the workflow action
// is still running (task.actionRunningMode is set). recordTaskCompletion used to
// gate commit linking behind `fireSignal = !actionRunningMode`, so every
// CLI-runner commit was stranded — associated with no task at all.
//
// These tests pin the fixed behaviour: commits are linked in action mode too,
// both from an explicit commitsArg and via the terminal-independent `git log`
// auto-detect.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { makeTaskDbFake } from './helpers/taskDbFake.js';
const realDb = await import('../database.js');
const { rows, exports: taskDbFake } = makeTaskDbFake();
mock.module('../database.js', { namedExports: { ...realDb, ...taskDbFake } });

const { AgentManager } = await import('../agentManager.js');

const mockIo = {
  emit() {},
  to() {
    return { emit() {} };
  },
};

async function setup(agentDefs: any[] = []) {
  rows.clear();
  const mgr = new AgentManager(mockIo, null, null, null) as any;
  for (const def of agentDefs) {
    const created = await mgr.create(def);
    const raw = mgr.agents.get(created.id);
    raw.status = 'idle';
    raw.conversationHistory = [];
  }
  return mgr;
}

function seedTask(agentId: string, task: any) {
  task.agentId = agentId;
  rows.set(task.id, task);
  return task;
}

test('recordTaskCompletion links explicit commits while a workflow action is running', async () => {
  const mgr = await setup([{ name: 'CLI Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  const task = seedTask(agentId, {
    id: 'task-cli-1',
    text: 'Implement feature',
    status: 'execute',
    boardId: 'board-1',
    assignee: agentId,
    // The task is mid-action: this is exactly when a CLI runner calls update_task.
    actionRunningMode: 'decide',
    actionRunning: true,
    actionRunningAgentId: agentId,
    startedAt: new Date(Date.now() - 60000).toISOString(),
    commits: [],
  });

  const outcome = await mgr.recordTaskCompletion(agentId, {
    comment: 'done',
    explicitTaskId: task.id,
    commitsArg: 'abc1234:feat: add feature, def5678:fix: edge case',
  });

  assert.equal(outcome.success, true);
  const linked = (rows.get('task-cli-1') as any).commits;
  assert.equal(linked.length, 2, 'both explicit commits should be linked in action mode');
  assert.deepEqual(linked.map((c: any) => c.hash).sort(), ['abc1234', 'def5678']);
});

test('recordTaskCompletion auto-detects commits via git log (terminal-independent) in action mode', async () => {
  const mgr = await setup([{ name: 'CLI Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();

  const startedAt = new Date(Date.now() - 120000).toISOString();
  const commitISO = new Date(Date.now() - 60000).toISOString();
  const fullHash = 'a'.repeat(40);

  // Fake execution env: the runner committed silently in its PTY; the commit is
  // only visible by querying the real repo with `git log`, never in the terminal.
  const execCalls: string[] = [];
  mgr.executionManager = {
    hasEnvironment: (id: string) => id === agentId,
    async exec(_id: string, command: string) {
      execCalls.push(command);
      return { stdout: `${fullHash} ${commitISO} silent commit from CLI runner\n`, stderr: '' };
    },
  };

  const task = seedTask(agentId, {
    id: 'task-cli-2',
    text: 'Fix bug',
    status: 'execute',
    boardId: 'board-1',
    assignee: agentId,
    actionRunningMode: 'decide',
    actionRunning: true,
    actionRunningAgentId: agentId,
    startedAt,
    commits: [],
  });

  const outcome = await mgr.recordTaskCompletion(agentId, {
    comment: 'done',
    explicitTaskId: task.id,
    // No commitsArg — the runner forgot (or can't) pass hashes.
  });

  assert.equal(outcome.success, true);
  assert.ok(
    execCalls.some(c => /git log/.test(c)),
    'auto-detect should query git log'
  );
  const linked = (rows.get('task-cli-2') as any).commits;
  assert.equal(linked.length, 1, 'the silently-made commit should be auto-linked');
  assert.equal(linked[0].hash, fullHash);
});
