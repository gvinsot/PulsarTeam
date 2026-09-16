import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { gitFixture } from './helpers/gitFixture.js';
import { makeTaskDbFake } from './helpers/taskDbFake.js';
const realDb = await import('../database.js');
const { rows, exports: taskDbFake } = makeTaskDbFake();
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    ...taskDbFake,
    // PostgreSQL reads return independent snapshots, not shared mutable objects.
    getTaskById: async (id: string) => structuredClone(rows.get(id) || null),
    getTaskByIdPrefix: async (id: string) => structuredClone(rows.get(id) || null),
  },
});

const { AgentManager } = await import('../agentManager.js');
const { beginTaskCommitRun } = await import('../agentManager/tools/gitReconcile.js');

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

test('completion links CLI commits using this run and preserves them when saving the comment', async t => {
  const mgr = await setup([{ name: 'CLI Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  const f = gitFixture(t);
  mgr.executionManager = f.executionManager;
  const task = seedTask(agentId, {
    id: 'task-cli-2',
    text: 'Fix bug',
    status: 'execute',
    assignee: agentId,
    actionRunningMode: 'decide',
    actionRunning: true,
    actionRunningAgentId: agentId,
    startedAt: '2000-01-01',
    commits: [],
  });
  beginTaskCommitRun(mgr, agentId, {
    taskId: task.id,
    baselineHead: f.baselineHead,
    startedAt: f.startedAt,
  });
  f.git(f.peer, 'commit', '--allow-empty', '-m', 'CLI Runner: unrelated task');
  f.git(f.peer, 'push');
  f.git(f.repo, 'pull', '--ff-only');
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'silent CLI commit');
  const hash = f.git(f.repo, 'rev-parse', 'HEAD');
  const result = await mgr.recordTaskCompletion(agentId, {
    comment: 'done',
    explicitTaskId: task.id,
  });
  assert.equal(result.success, true);
  assert.deepEqual(
    rows.get(task.id).commits.map((c: any) => c.hash),
    [hash]
  );
  assert.ok(rows.get(task.id).text.includes('done'));
});

test('completion without a known run never uses old task dates or agent-name matches', async () => {
  const mgr = await setup([{ name: 'CLI Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  mgr.executionManager = {
    hasEnvironment: () => true,
    exec() {
      assert.fail('no Git query without a known task execution');
    },
  };
  const task = seedTask(agentId, {
    id: 'task-no-run',
    text: 'Do nothing',
    status: 'execute',
    assignee: agentId,
    startedAt: '2000-01-01',
    commits: [],
  });
  await mgr.recordTaskCompletion(agentId, { comment: 'done', explicitTaskId: task.id });
  assert.deepEqual(rows.get(task.id).commits, []);
});

test('completion of a different task cannot capture the active run commits', async () => {
  const mgr = await setup([{ name: 'CLI Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  mgr.executionManager = {
    exec() {
      assert.fail('wrong task must not query Git');
    },
  };
  beginTaskCommitRun(mgr, agentId, {
    taskId: 'active-task',
    baselineHead: null,
    startedAt: new Date().toISOString(),
  });
  const task = seedTask(agentId, {
    id: 'other-task',
    text: 'Other task',
    status: 'execute',
    commits: [],
  });
  await mgr.recordTaskCompletion(agentId, { comment: 'done', explicitTaskId: task.id });
  assert.deepEqual(rows.get(task.id).commits, []);
});

test('run_command detects a silent commit even if a later command fails', async t => {
  const mgr = await setup([{ name: 'Direct Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  const f = gitFixture(t);
  mgr.executionManager = {
    ...f.executionManager,
    hasEnvironment: () => true,
    bindAgent() {},
    getProject: () => f.repo,
    async ensureProject() {},
  };
  const task = seedTask(agentId, {
    id: 'direct-task',
    text: 'Direct task',
    status: 'execute',
    commits: [],
  });
  beginTaskCommitRun(mgr, agentId, {
    taskId: task.id,
    baselineHead: f.baselineHead,
    startedAt: f.startedAt,
  });
  await mgr._processToolCalls(
    agentId,
    [
      {
        id: 'call-1',
        name: 'run_command',
        arguments: {
          command: 'git commit --allow-empty -m "silent command commit" >/dev/null && false',
        },
      },
    ],
    null
  );
  assert.deepEqual(
    rows.get(task.id).commits.map((c: any) => c.hash),
    [f.git(f.repo, 'rev-parse', 'HEAD')]
  );
});

test('run_command never links a push to a recently completed task or invents a task', async t => {
  const mgr = await setup([{ name: 'Direct Runner', role: 'developer' }]);
  const [agentId] = mgr.agents.keys();
  const f = gitFixture(t);
  mgr.executionManager = {
    ...f.executionManager,
    hasEnvironment: () => true,
    bindAgent() {},
    getProject: () => f.repo,
    async ensureProject() {},
  };
  const task = seedTask(agentId, {
    id: 'finished-task',
    text: 'Finished task',
    status: 'done',
    completedAt: new Date().toISOString(),
    commits: [],
  });
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'unrelated commit');
  await mgr._processToolCalls(
    agentId,
    [{ id: 'call-1', name: 'run_command', arguments: { command: 'git push' } }],
    null
  );
  assert.deepEqual(rows.get(task.id).commits, []);
  assert.equal(rows.size, 1);
});
