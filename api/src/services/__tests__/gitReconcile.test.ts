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
const {
  snapshotGitBaseline,
  detectCommitsSinceBaseline,
  reconcileTaskCommits,
  locallyCreatedCommits,
} = await import('../agentManager/tools/gitReconcile.js');

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

// ── The reflog gate ─────────────────────────────────────────────────────────
// The committer filter separates agents from humans, never agent A's task from
// agent B's: every runner clone commits under the same GIT_USER_EMAIL. Agents
// are instructed to sync before working, so agent A's clone pulls agent B's
// commits straight into `baseline..HEAD`, where they match the committer filter
// and used to be linked to whatever task A was running. The reflog records HOW
// each commit entered the clone, which the range cannot fake.

const OTHER_AGENT_HASH = 'e'.repeat(40);

/** Reflog as `git reflog show --no-abbrev --format="%H %gs"` prints it. */
function reflog(entries: Array<[string, string]>): string {
  return entries.map(([hash, reason]) => `${hash} ${reason}`).join('\n') + '\n';
}

test('locallyCreatedCommits keeps creating reflog verbs and drops HEAD moves', async () => {
  const { env } = makeExecEnv([
    {
      match: /git reflog show/,
      stdout: reflog([
        [HASH_A, 'commit: feat: mine'],
        [HASH_B, 'commit (amend): fix: mine, amended'],
        ['1'.repeat(40), 'rebase (pick): replayed locally'],
        ['2'.repeat(40), "merge origin/main: Merge made by the 'ort' strategy."],
        ['3'.repeat(40), 'cherry-pick: picked here'],
        ['4'.repeat(40), "commit (merge): Merge branch 'main' of github.com/x/y"],
        ['5'.repeat(40), 'pull -q (pick): my work, replayed onto upstream'],
        [OTHER_AGENT_HASH, 'pull: Fast-forward'],
        ['6'.repeat(40), 'merge origin/main: Fast-forward'],
        ['7'.repeat(40), 'reset: moving to origin/main'],
        ['8'.repeat(40), 'checkout: moving from main to feature'],
        ['9'.repeat(40), 'fetch origin: storing head'],
        ['0'.repeat(40), 'rebase (finish): returning to refs/heads/main'],
        ['ab'.repeat(20), 'clone: from github.com/x/y'],
        // git labels sequencer phases with the command actually typed, so a
        // rebasing pull checks out the UPSTREAM tip under a `pull …` verb.
        ['ac'.repeat(20), 'pull --rebase (start): checkout acacacac'],
        ['ad'.repeat(20), 'rebase -i (start): checkout adadadad'],
      ]),
    },
  ]);

  const created = await locallyCreatedCommits(env, 'agent-1');
  assert.ok(created);
  assert.deepEqual(
    [...created].sort(),
    [
      HASH_A,
      HASH_B,
      '1'.repeat(40),
      '2'.repeat(40),
      '3'.repeat(40),
      '4'.repeat(40),
      '5'.repeat(40),
    ].sort()
  );
});

test('a commit subject mentioning a phase or fast-forward is still kept', async () => {
  // Only the operation half of the reflog subject may decide; the detail half
  // is an arbitrary commit message.
  const { env } = makeExecEnv([
    {
      match: /git reflog show/,
      stdout: reflog([
        [HASH_A, 'commit: fix(start): handle Fast-forward pulls'],
        [HASH_B, 'commit: docs: explain rebase (finish)'],
      ]),
    },
  ]);

  const created = await locallyCreatedCommits(env, 'agent-1');
  assert.deepEqual([...(created as Set<string>)].sort(), [HASH_A, HASH_B].sort());
});

test('a commit pulled from another agent is not credited to this run', async () => {
  const { env } = makeExecEnv([
    { match: /git config user\.email/, stdout: `${AGENT_EMAIL}\n` },
    // Both commits carry the shared agent identity, so the committer filter
    // lets them both through — only the reflog can tell them apart.
    {
      match: /git log .*\.\.HEAD/,
      stdout: `${HASH_A} feat: written by this run\n${OTHER_AGENT_HASH} chore: another agent's task\n`,
    },
    {
      match: /git reflog show/,
      stdout: reflog([
        [HASH_A, 'commit: feat: written by this run'],
        [OTHER_AGENT_HASH, 'pull: Fast-forward'],
      ]),
    },
    { match: /--branches --not --remotes/, stdout: '' },
  ]);

  const commits = await detectCommitsSinceBaseline(env, 'agent-1', { baselineHead: BASELINE });
  assert.deepEqual(
    commits.map(c => c.hash),
    [HASH_A]
  );
});

test('the reflog gate also guards the time-window fallback', async () => {
  const { env } = makeExecEnv([
    { match: /git log .*--since/, stdout: `${HASH_A} mine\n${OTHER_AGENT_HASH} theirs\n` },
    {
      match: /git reflog show/,
      stdout: reflog([
        [HASH_A, 'commit: mine'],
        [OTHER_AGENT_HASH, 'pull origin main: Fast-forward'],
      ]),
    },
    { match: /--branches --not --remotes/, stdout: '' },
  ]);

  const commits = await detectCommitsSinceBaseline(env, 'agent-1', {
    startedAt: new Date(Date.now() - 60000).toISOString(),
  });
  assert.deepEqual(
    commits.map(c => c.hash),
    [HASH_A]
  );
});

test('an unreadable reflog degrades to the previous behaviour, not to zero links', async () => {
  for (const stdout of ['', 'fatal: not a git repository\n']) {
    const { env } = makeExecEnv([
      { match: /git reflog show/, stdout },
      { match: /git log .*\.\.HEAD/, stdout: `${HASH_A} feat: first\n` },
      { match: /--branches --not --remotes/, stdout: '' },
    ]);

    assert.equal(await locallyCreatedCommits(env, 'agent-1'), null);
    const commits = await detectCommitsSinceBaseline(env, 'agent-1', { baselineHead: BASELINE });
    assert.equal(commits.length, 1, 'unknown must not mean "created nothing"');
  }
});

test('reconcileTaskCommits links only what the clone created', async () => {
  const { mgr, agentId } = await setup();
  const task = seedTask(agentId, { id: 'task-reconcile-3' });

  mgr.executionManager = makeExecEnv([
    {
      match: /git log .*\.\.HEAD/,
      stdout: `${HASH_A} feat: mine\n${OTHER_AGENT_HASH} chore: pulled in\n`,
    },
    {
      match: /git reflog show/,
      stdout: reflog([
        [HASH_A, 'commit: feat: mine'],
        [OTHER_AGENT_HASH, 'pull: Fast-forward'],
      ]),
    },
    { match: /--branches --not --remotes/, stdout: '' },
  ]).env;

  const fresh = await reconcileTaskCommits(mgr, agentId, task.id, { baselineHead: BASELINE });
  assert.equal(fresh, 1);
  assert.deepEqual(
    (rows.get(task.id) as any).commits.map((c: any) => c.hash),
    [HASH_A]
  );
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
