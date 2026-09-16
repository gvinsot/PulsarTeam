import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { makeTaskDbFake } from './helpers/taskDbFake.js';
import { gitFixture } from './helpers/gitFixture.js';

const realDb = await import('../database.js');
const { rows, exports: taskDbFake } = makeTaskDbFake();
mock.module('../database.js', { namedExports: { ...realDb, ...taskDbFake } });
const { AgentManager } = await import('../agentManager.js');
const {
  snapshotGitBaseline,
  detectCommitsSinceBaseline,
  reconcileTaskCommits,
  beginTaskCommitRun,
  getTaskCommitRun,
  endTaskCommitRun,
} = await import('../agentManager/tools/gitReconcile.js');

const mockIo = {
  emit() {},
  to() {
    return { emit() {} };
  },
};
const HASH = 'a'.repeat(40);
const start = '2026-01-01T00:00:00Z';
const event = `${HASH}\tHEAD@{1767225601}\tcommit: feature\tfeature`;

function fakeEnv(reflog: string, unpushed: unknown = '') {
  return {
    async exec(_id: string, command: string) {
      if (command.includes('reflog')) return { stdout: reflog };
      if (command.includes('--not --remotes')) {
        if (unpushed instanceof Error) throw unpushed;
        if (typeof unpushed === 'object') return unpushed;
        return { stdout: unpushed };
      }
      return { stdout: HASH };
    },
  };
}

test('snapshot captures HEAD and rejects failed commands even with recoverable output', async () => {
  assert.equal(await snapshotGitBaseline(fakeEnv(''), 'agent'), HASH);
  assert.equal(
    await snapshotGitBaseline({ exec: async () => ({ stdout: HASH, exitCode: 1 }) }, 'agent'),
    null
  );
  assert.equal(
    await snapshotGitBaseline(
      {
        exec: async () => {
          throw Object.assign(new Error('failed'), { stdout: HASH });
        },
      },
      'agent'
    ),
    null
  );
});

test('pulled commits with the same identity and agent name are never linked', async t => {
  const f = gitFixture(t);
  f.git(f.peer, 'commit', '--allow-empty', '-m', 'Shared Agent: unrelated task');
  f.git(f.peer, 'push');
  f.git(f.repo, 'pull', '--ff-only');
  assert.deepEqual(await detectCommitsSinceBaseline(f.executionManager, 'agent', f), []);
  // Pushing an imported tip is still not evidence of local creation.
  f.git(f.repo, 'push', 'origin', 'HEAD:other-branch');
  assert.deepEqual(await detectCommitsSinceBaseline(f.executionManager, 'agent', f), []);
});

test('mixed local and pulled history links only local commits and refreshes pushed state', async t => {
  const f = gitFixture(t);
  f.git(f.peer, 'commit', '--allow-empty', '-m', 'unrelated');
  f.git(f.peer, 'push');
  f.git(f.repo, 'pull', '--ff-only');
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'task implementation');
  const hash = f.git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await detectCommitsSinceBaseline(f.executionManager, 'agent', f), [
    { hash, msg: 'task implementation', pushed: false },
  ]);
  f.git(f.repo, 'push');
  assert.deepEqual(await detectCommitsSinceBaseline(f.executionManager, 'agent', f), [
    { hash, msg: 'task implementation', pushed: true },
  ]);
});

test('amend excludes abandoned versions; a subsequent task gets no previous commits', async t => {
  const f = gitFixture(t);
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'first version');
  f.git(f.repo, 'commit', '--amend', '--allow-empty', '-m', 'final version');
  const hash = f.git(f.repo, 'rev-parse', 'HEAD');
  assert.deepEqual(await detectCommitsSinceBaseline(f.executionManager, 'agent', f), [
    { hash, msg: 'final version', pushed: false },
  ]);
  assert.deepEqual(
    await detectCommitsSinceBaseline(f.executionManager, 'agent', {
      startedAt: new Date().toISOString(),
      baselineHead: hash,
    }),
    []
  );
});

test('detached HEAD commits are correctly identified as unpushed', async t => {
  const f = gitFixture(t);
  f.git(f.repo, 'checkout', '--detach');
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'detached work');
  const commits = await detectCommitsSinceBaseline(f.executionManager, 'agent', f);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].pushed, false);
});

test('creation events use local time even when the author date is old', async t => {
  const f = gitFixture(t);
  f.git(f.repo, 'commit', '--allow-empty', '--date=2000-01-01T00:00:00Z', '-m', 'old author date');
  assert.equal((await detectCommitsSinceBaseline(f.executionManager, 'agent', f)).length, 1);
});

test('missing baseline uses local evidence, never an unfiltered recent history scan', async () => {
  assert.equal(
    (await detectCommitsSinceBaseline(fakeEnv(event), 'agent', { startedAt: start })).length,
    1
  );
  assert.deepEqual(
    await detectCommitsSinceBaseline(fakeEnv(''), 'agent', { startedAt: start }),
    []
  );
  assert.deepEqual(await detectCommitsSinceBaseline(fakeEnv(event), 'agent', {}), []);
  assert.deepEqual(
    await detectCommitsSinceBaseline(fakeEnv(event), 'agent', { startedAt: 'invalid' }),
    []
  );
  assert.deepEqual(
    await detectCommitsSinceBaseline(fakeEnv(event), 'agent', { startedAt: '2026-01-02' }),
    []
  );
});

test('pull, reset, checkout and clone events are not local creation', async () => {
  for (const action of [
    'pull: Fast-forward',
    'reset: moving to HEAD',
    'checkout: moving from main to other',
    'clone: from remote',
  ]) {
    const reflog = event.replace('commit: feature', action);
    assert.deepEqual(
      await detectCommitsSinceBaseline(fakeEnv(reflog), 'agent', { startedAt: start }),
      []
    );
  }
});

test('Git failures leave push state unknown, including exceptions with stdout', async () => {
  for (const failure of [
    new Error('unavailable'),
    Object.assign(new Error('failed'), { stdout: HASH }),
    { stdout: '', exitCode: 1 },
  ]) {
    const commits = await detectCommitsSinceBaseline(fakeEnv(event, failure), 'agent', {
      startedAt: start,
    });
    assert.equal(commits.length, 1);
    assert.equal(commits[0].pushed, undefined);
  }
});

test('reconcile links once and updates pushed status on subsequent sweeps', async t => {
  rows.clear();
  const f = gitFixture(t);
  const mgr = new AgentManager(mockIo, null, null, null) as any;
  const agent = await mgr.create({ name: 'CLI Runner', role: 'developer' });
  mgr.executionManager = f.executionManager;
  rows.set('task', { id: 'task', agentId: agent.id, text: 'Implement', commits: [] });
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'implementation');
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', f), 1);
  assert.equal(rows.get('task').commits[0].pushed, false);
  f.git(f.repo, 'push');
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', f), 0);
  assert.equal(rows.get('task').commits.length, 1);
  assert.equal(rows.get('task').commits[0].pushed, true);
});

/** A clone whose only HEAD movements are `clone` + fast-forward `pull` has a
 *  perfectly readable reflog that simply records no creation. That must stay
 *  distinct from an unreadable reflog: an earlier revision returned the same
 *  "unknown" marker for both and fell back to crediting the rev-range, which
 *  linked another agent's pushed commit to this task. */
test('a clone that only pulled links nothing, through detection, reconcile and push', async t => {
  rows.clear();
  const f = gitFixture(t);
  const mgr = new AgentManager(mockIo, null, null, null) as any;
  const agent = await mgr.create({ name: 'CLI Runner', role: 'developer' });
  mgr.executionManager = f.executionManager;
  rows.set('task', { id: 'task', agentId: agent.id, text: 'Implement', commits: [] });
  // Reflog times are second-precision: step past the fixture's own setup commit
  // so the run window holds the pull and nothing else — the case where the
  // reflog is fully readable yet records no creation at all.
  await new Promise(resolve => setTimeout(resolve, 1100));
  const run = { baselineHead: f.baselineHead, startedAt: new Date().toISOString() };
  f.git(f.peer, 'commit', '--allow-empty', '-m', 'other task');
  f.git(f.peer, 'push');
  f.git(f.repo, 'pull', '--ff-only');
  assert.deepEqual(await detectCommitsSinceBaseline(f.executionManager, 'agent', run), []);
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', run), 0);
  // Publishing the imported tip is not evidence of local creation either.
  f.git(f.repo, 'push', 'origin', 'HEAD:other-branch');
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', run), 0);
  assert.deepEqual(rows.get('task').commits, []);
});

test('an unreadable reflog fails closed instead of crediting the rev-range', async () => {
  rows.clear();
  const mgr = new AgentManager(mockIo, null, null, null) as any;
  const agent = await mgr.create({ name: 'CLI Runner', role: 'developer' });
  mgr.executionManager = {
    async exec(_id: string, command: string) {
      if (command.includes('reflog')) throw new Error('reflog unreadable');
      return { stdout: HASH };
    },
  };
  rows.set('task', { id: 'task', agentId: agent.id, text: 'Implement', commits: [] });
  const opts = { startedAt: start, baselineHead: HASH };
  assert.deepEqual(await detectCommitsSinceBaseline(mgr.executionManager, 'agent', opts), []);
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', opts), 0);
  assert.deepEqual(rows.get('task').commits, []);
});

/** Only the operation half of a reflog subject may reject a Fast-forward:
 *  matching the whole line dropped local commits that merely talk about one. */
test('local commits named Fast-forward are kept while real fast-forward moves are not', async t => {
  rows.clear();
  const f = gitFixture(t);
  const mgr = new AgentManager(mockIo, null, null, null) as any;
  const agent = await mgr.create({ name: 'CLI Runner', role: 'developer' });
  mgr.executionManager = f.executionManager;
  rows.set('task', { id: 'task', agentId: agent.id, text: 'Implement', commits: [] });
  f.git(f.peer, 'commit', '--allow-empty', '-m', 'Fast-forward from another agent');
  f.git(f.peer, 'push');
  f.git(f.repo, 'pull', '--ff-only'); // pull: Fast-forward
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'ordinary work');
  f.git(f.repo, 'push');
  f.git(f.peer, 'pull', '--ff-only');
  f.git(f.peer, 'commit', '--allow-empty', '-m', 'more work elsewhere');
  f.git(f.peer, 'push');
  f.git(f.repo, 'fetch');
  f.git(f.repo, 'merge', '--ff-only', 'origin/main'); // merge: Fast-forward
  f.git(f.repo, 'commit', '--allow-empty', '-m', 'Fast-forward handling fix');
  assert.deepEqual(
    (await detectCommitsSinceBaseline(f.executionManager, 'agent', f)).map(c => c.msg).sort(),
    ['Fast-forward handling fix', 'ordinary work']
  );
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', f), 2);
  f.git(f.repo, 'push');
  assert.equal(await reconcileTaskCommits(mgr, agent.id, 'task', f), 0);
  assert.deepEqual(
    rows
      .get('task')
      .commits.map((c: any) => c.pushed)
      .sort(),
    [true, true]
  );
});

test('run context is isolated by manager, agent and task and cleared at completion', () => {
  const mgr = {},
    otherMgr = {};
  const run = { taskId: 'task', baselineHead: HASH, startedAt: start };
  beginTaskCommitRun(mgr, 'agent', run);
  assert.equal(getTaskCommitRun(mgr, 'agent'), run);
  assert.equal(getTaskCommitRun(otherMgr, 'agent'), undefined);
  assert.equal(getTaskCommitRun(mgr, 'other-agent'), undefined);
  endTaskCommitRun(mgr, 'agent', 'other-task');
  assert.equal(getTaskCommitRun(mgr, 'agent'), run);
  endTaskCommitRun(mgr, 'agent', 'task');
  assert.equal(getTaskCommitRun(mgr, 'agent'), undefined);
});

test('sequencer creation phases survive while start, finish and fast-forward moves are rejected', async () => {
  for (const action of [
    'commit (merge): merged',
    'commit (initial): initial',
    'pull -q (pick): replayed',
    'pull --rebase (pick): replayed',
    'rebase -i (reword): rewritten',
    'merge origin/main: Merge made by the ort strategy.',
    'commit: fix(start): handle Fast-forward pulls',
    'commit: Fast-forward documentation',
    'commit: docs: explain rebase (finish)',
  ]) {
    assert.equal(
      (
        await detectCommitsSinceBaseline(
          fakeEnv(event.replace('commit: feature', action)),
          'agent',
          { startedAt: start }
        )
      ).length,
      1,
      action
    );
  }
  for (const action of [
    'pull --rebase (start): checkout upstream',
    'rebase -i (start): checkout upstream',
    'pull (finish): returning to main',
    'rebase (abort): returning to main',
    'merge origin/main: Fast-forward',
    'pull origin main: Fast-forward',
  ]) {
    assert.deepEqual(
      await detectCommitsSinceBaseline(fakeEnv(event.replace('commit: feature', action)), 'agent', {
        startedAt: start,
      }),
      [],
      action
    );
  }
});
