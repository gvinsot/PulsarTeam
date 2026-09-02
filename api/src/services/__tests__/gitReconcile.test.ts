// Terminal-independent commit/push detection for CLI runners (claude code,
// aider, …). A CLI runner commits inside its own interactive PTY: nothing
// flows through @run_command, and its TUI often doesn't render parseable git
// output at all. gitReconcile.ts therefore queries the repo itself:
//   - snapshotGitBaseline() captures HEAD before the run,
//   - detectCommitsSinceBaseline() diffs baseline..HEAD with pushed flags,
//   - reconcileTaskCommits() links the result to the task (idempotent) and
//     upgrades pushed flags once the runner pushes.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

import { makeTaskDbFake } from './helpers/taskDbFake.js';
const realDb = await import('../database.js');
const { rows, exports: taskDbFake } = makeTaskDbFake();
mock.module('../database.js', { namedExports: { ...realDb, ...taskDbFake } });

const { AgentManager } = await import('../agentManager.js');
const { snapshotGitBaseline, detectCommitsSinceBaseline, reconcileTaskCommits } =
  await import('../agentManager/tools/gitReconcile.js');

const mockIo = {
  emit() {},
  to() {
    return { emit() {} };
  },
};

const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const BASELINE = 'c'.repeat(40);

/** Fake execution env: scripted stdout per command matcher. */
function makeExecEnv(responses: Array<{ match: RegExp; stdout: string }>) {
  const calls: string[] = [];
  return {
    calls,
    env: {
      hasEnvironment: () => true,
      async exec(_id: string, command: string) {
        calls.push(command);
        const hit = responses.find(r => r.match.test(command));
        return { stdout: hit ? hit.stdout : '', stderr: '' };
      },
    },
  };
}

async function setup() {
  rows.clear();
  const mgr = new AgentManager(mockIo, null, null, null) as any;
  const created = await mgr.create({ name: 'CLI Runner', role: 'developer' });
  const raw = mgr.agents.get(created.id);
  raw.status = 'idle';
  raw.conversationHistory = [];
  return { mgr, agentId: created.id as string };
}

function seedTask(agentId: string, overrides: any = {}) {
  const task = {
    id: 'task-reconcile-1',
    text: 'Implement feature',
    status: 'execute',
    boardId: 'board-1',
    agentId,
    assignee: agentId,
    startedAt: new Date(Date.now() - 120000).toISOString(),
    commits: [],
    ...overrides,
  };
  rows.set(task.id, task);
  return task;
}

test('snapshotGitBaseline returns HEAD hash, null on non-repo output', async () => {
  const { env } = makeExecEnv([{ match: /rev-parse HEAD/, stdout: `${BASELINE}\n` }]);
  assert.equal(await snapshotGitBaseline(env, 'agent-1'), BASELINE);

  const { env: badEnv } = makeExecEnv([
    { match: /rev-parse HEAD/, stdout: 'fatal: not a git repository\n' },
  ]);
  assert.equal(await snapshotGitBaseline(badEnv, 'agent-1'), null);

  assert.equal(await snapshotGitBaseline({ hasEnvironment: () => false }, 'agent-1'), null);
});

test('detectCommitsSinceBaseline diffs baseline..HEAD and flags unpushed commits', async () => {
  const { env, calls } = makeExecEnv([
    { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: first\n${HASH_B} fix: second\n` },
    // HASH_B is on a local branch only — never pushed.
    { match: /--branches --not --remotes/, stdout: `${HASH_B}\n` },
  ]);

  const commits = await detectCommitsSinceBaseline(env, 'agent-1', { baselineHead: BASELINE });
  assert.equal(commits.length, 2);
  assert.ok(
    calls.some(c => c.includes(`${BASELINE}..HEAD`)),
    'should use the exact rev-range'
  );
  const byHash = Object.fromEntries(commits.map(c => [c.hash, c]));
  assert.equal(byHash[HASH_A].pushed, true);
  assert.equal(byHash[HASH_B].pushed, false);
  assert.equal(byHash[HASH_A].msg, 'feat: first');
});

test('detectCommitsSinceBaseline falls back to --since when no baseline', async () => {
  const startedAt = new Date(Date.now() - 60000).toISOString();
  const { env, calls } = makeExecEnv([
    { match: /git log .*--since/, stdout: `${HASH_A} feat: windowed\n` },
    { match: /--branches --not --remotes/, stdout: '' },
  ]);

  const commits = await detectCommitsSinceBaseline(env, 'agent-1', { startedAt });
  assert.equal(commits.length, 1);
  assert.ok(
    calls.some(c => c.includes('--since')),
    'should query by time window'
  );

  // Neither anchor → no query at all.
  const { env: idleEnv, calls: idleCalls } = makeExecEnv([]);
  assert.deepEqual(await detectCommitsSinceBaseline(idleEnv, 'agent-1', {}), []);
  assert.equal(idleCalls.length, 0);
});

test('reconcileTaskCommits links new commits with pushed flags, idempotently', async () => {
  const { mgr, agentId } = await setup();
  const task = seedTask(agentId);

  const { env } = makeExecEnv([
    { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: first\n${HASH_B} fix: second\n` },
    { match: /--branches --not --remotes/, stdout: `${HASH_B}\n` },
  ]);
  mgr.executionManager = env;

  const fresh = await reconcileTaskCommits(mgr, agentId, task.id, { baselineHead: BASELINE });
  assert.equal(fresh, 2);
  const linked = (rows.get(task.id) as any).commits;
  assert.equal(linked.length, 2);
  const byHash = Object.fromEntries(linked.map((c: any) => [c.hash, c]));
  assert.equal(byHash[HASH_A].pushed, true);
  assert.equal(byHash[HASH_B].pushed, false);

  // Second sweep (same repo state): nothing new, no duplicates.
  const again = await reconcileTaskCommits(mgr, agentId, task.id, { baselineHead: BASELINE });
  assert.equal(again, 0);
  assert.equal((rows.get(task.id) as any).commits.length, 2);
});

test('reconcileTaskCommits upgrades the pushed flag once the runner pushed', async () => {
  const { mgr, agentId } = await setup();
  const task = seedTask(agentId, { id: 'task-reconcile-2' });

  // Mid-run sweep: commit exists but is local-only.
  mgr.executionManager = makeExecEnv([
    { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: wip\n` },
    { match: /--branches --not --remotes/, stdout: `${HASH_A}\n` },
  ]).env;
  await reconcileTaskCommits(mgr, agentId, task.id, { baselineHead: BASELINE });
  assert.equal((rows.get(task.id) as any).commits[0].pushed, false);

  // End-of-run reconcile: the runner has pushed — unpushed set is now empty.
  mgr.executionManager = makeExecEnv([
    { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: wip\n` },
    { match: /--branches --not --remotes/, stdout: '' },
  ]).env;
  const fresh = await reconcileTaskCommits(mgr, agentId, task.id, { baselineHead: BASELINE });
  assert.equal(fresh, 0, 'no new commit — only the flag changes');
  const linked = (rows.get(task.id) as any).commits;
  assert.equal(linked.length, 1);
  assert.equal(linked[0].pushed, true);
});

// ── The committer filter ────────────────────────────────────────────────────
// `baseline..HEAD` answers "what is new in this clone", which is NOT the same
// as "what did the agent write": ensureProject fetch/resets the clone on every
// chat and every terminal attach, and the runner pulls too, so commits that
// merely ARRIVED sit in the range. Observed in prod: a task whose text was
// literally "test task, do nothing" was credited with five commits its human
// owner had pushed from his own machine the day before.

const AGENT_EMAIL = 'agent@pulsarteam.local';
const HUMAN_HASH = 'd'.repeat(40);

test('detection asks only for the commits this clone committed', async () => {
  const { env, calls } = makeExecEnv([
    { match: /git config user\.email/, stdout: `${AGENT_EMAIL}\n` },
    // The fake answers the FILTERED query only, the way git would: a range
    // holding nothing but pulled human commits comes back empty.
    { match: /git log .*\.\.HEAD.*--committer=/, stdout: '' },
    { match: /git log .*\.\.HEAD/, stdout: `${HUMAN_HASH} someone else's work\n` },
    { match: /--branches --not --remotes/, stdout: '' },
  ]);

  const commits = await detectCommitsSinceBaseline(env, 'agent-1', { baselineHead: BASELINE });

  assert.deepEqual(commits, [], 'pulled commits must not be credited to the run');
  const rangeCall = calls.find(c => c.includes(`${BASELINE}..HEAD`));
  assert.ok(
    rangeCall?.includes(`--committer='${AGENT_EMAIL}'`),
    `the range query must be scoped to the clone's identity, got: ${rangeCall}`
  );
});

test('the time-window fallback is scoped to the same identity', async () => {
  const { env, calls } = makeExecEnv([
    { match: /git config user\.email/, stdout: `${AGENT_EMAIL}\n` },
    { match: /git log .*--since/, stdout: `${HASH_A} feat: windowed\n` },
    { match: /--branches --not --remotes/, stdout: '' },
  ]);

  await detectCommitsSinceBaseline(env, 'agent-1', {
    startedAt: new Date(Date.now() - 60000).toISOString(),
  });

  const windowCall = calls.find(c => c.includes('--since'));
  assert.ok(windowCall?.includes(`--committer='${AGENT_EMAIL}'`), windowCall);
});

test('an unknown identity links everything rather than nothing', async () => {
  // A clone with no user.email must keep the old, over-linking behaviour:
  // filtering on an empty identity would match nothing and silently lose every
  // agent commit — a worse failure than the one being fixed.
  for (const stdout of ['', 'fatal: not in a git directory\n']) {
    const { env, calls } = makeExecEnv([
      { match: /git config user\.email/, stdout },
      { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: first\n` },
      { match: /--branches --not --remotes/, stdout: '' },
    ]);

    const commits = await detectCommitsSinceBaseline(env, 'agent-1', { baselineHead: BASELINE });

    assert.equal(commits.length, 1);
    assert.ok(
      !calls.find(c => c.includes(`${BASELINE}..HEAD`))?.includes('--committer'),
      'no identity → no filter'
    );
  }
});

test('a hostile identity is treated as unknown, never spliced into the command', async () => {
  const { env, calls } = makeExecEnv([
    { match: /git config user\.email/, stdout: `x'; rm -rf /; echo '\n` },
    { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: first\n` },
    { match: /--branches --not --remotes/, stdout: '' },
  ]);

  await detectCommitsSinceBaseline(env, 'agent-1', { baselineHead: BASELINE });

  assert.ok(
    calls.every(c => !c.includes('rm -rf')),
    'a quote-bearing identity must be rejected, not quoted'
  );
});
