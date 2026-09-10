// ── Runner workspace preparation ─────────────────────────────────────────────
//
// Regression tests for "some PulsarTeam agents can push their changes, others
// report 'could not read Username for https://github.com'".
//
// Root cause: git credentials only ever reached the runner container as a
// side-effect of a project ensure/switch, and both task paths skipped that call
// whenever the agent was ALREADY recorded as being on the task's repo
// (`agent.project === task.repoFullName`) or the task carried no repo at all.
// `agent.project` is API-side state that outlives the runner container, so the
// skip hit exactly the agents whose runner had been recycled: no clone (the
// runner falls back to cwd=/app) and no ~/.git-credentials. Agents whose task
// moved them to a different repo took the switch path and pushed fine.
//
// The assertions below are therefore mostly "the runner was called at all".

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const githubCalls: Array<[string | null, string | null]> = [];
let githubCreds: { token: string; login: string | null; provider: 'github' } | null = {
  token: 'gh-token',
  login: 'octocat',
  provider: 'github',
};
let githubThrows = false;

// routes/github.js is imported lazily by resolveAgentGitCredentials, so the mock
// only needs the one export it reaches for.
mock.module('../../routes/github.js', {
  namedExports: {
    getGitHubCredentialsForAgent: async (agentId: string | null, boardId: string | null) => {
      githubCalls.push([agentId, boardId]);
      if (githubThrows) throw new Error('oauth store unavailable');
      return githubCreds;
    },
  },
});

const { ensureAgentWorkspace, resolveAgentGitCredentials } =
  await import('../execution/agentWorkspace.js');

/** Records every call the preparation makes towards the runner. */
function makeExecutionManager(project: string | null = null) {
  const calls: Array<{ fn: string; args: any[] }> = [];
  let currentProject = project;
  return {
    calls,
    setProject(p: string | null) {
      currentProject = p;
    },
    names: () => calls.map(c => c.fn),
    setSecondaryRepos(...args: any[]) {
      calls.push({ fn: 'setSecondaryRepos', args });
    },
    async ensureProject(...args: any[]) {
      calls.push({ fn: 'ensureProject', args });
      currentProject = args[1];
    },
    async switchProject(...args: any[]) {
      calls.push({ fn: 'switchProject', args });
      currentProject = args[1];
    },
    async installGitCredentials(...args: any[]) {
      calls.push({ fn: 'installGitCredentials', args });
    },
    getProject: () => currentProject,
  };
}

const agentOnRepo = () => ({
  id: 'agent-1',
  name: 'Claude #1',
  project: 'gvinsot/PulsarTeam',
  boardId: 'board-1',
});
const creds = { token: 'gh-token', login: 'octocat', provider: 'github' };

beforeEach(() => {
  githubCalls.length = 0;
  githubThrows = false;
  githubCreds = { token: 'gh-token', login: 'octocat', provider: 'github' };
});

// ── The regression ──────────────────────────────────────────────────────────

test('an agent already on the task repo still gets an ensure carrying its token', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  const res = await ensureAgentWorkspace(em, agentOnRepo(), {
    repo: 'gvinsot/PulsarTeam',
    gitCredentials: creds,
  });
  assert.deepEqual(res, { switched: false, prepared: true });
  const ensure = em.calls.find(c => c.fn === 'ensureProject');
  assert.ok(ensure, `expected an ensureProject call, got ${em.names().join(', ') || 'none'}`);
  assert.equal(ensure.args[1], 'gvinsot/PulsarTeam');
  assert.equal(ensure.args[2], 'https://github.com/gvinsot/PulsarTeam.git');
  assert.deepEqual(ensure.args[3], creds);
  // No switch: the agent is not moving, so no history/context churn.
  assert.ok(!em.names().includes('switchProject'));
});

test('a task with no repo still ships the token to the runner', async () => {
  const em = makeExecutionManager(null);
  const res = await ensureAgentWorkspace(
    em,
    { id: 'agent-1', project: null },
    {
      repo: null,
      gitCredentials: creds,
    }
  );
  assert.deepEqual(res, { switched: false, prepared: false });
  assert.deepEqual(em.names(), ['setSecondaryRepos', 'installGitCredentials']);
  assert.deepEqual(em.calls[1].args, ['agent-1', creds]);
});

test('a repo with no usable clone URL falls back to installing credentials', async () => {
  const em = makeExecutionManager(null);
  const res = await ensureAgentWorkspace(
    em,
    { id: 'agent-1', project: null },
    {
      // Not an "owner/repo" — buildRepoCloneUrl returns null for it.
      repo: 'Pulsar',
      gitCredentials: creds,
    }
  );
  assert.equal(res.prepared, false);
  assert.ok(em.names().includes('installGitCredentials'));
  assert.ok(!em.names().includes('ensureProject'));
  assert.ok(!em.names().includes('switchProject'));
});

test('nothing is pushed when there is no repo and no token', async () => {
  const em = makeExecutionManager(null);
  await ensureAgentWorkspace(
    em,
    { id: 'agent-1', project: null },
    {
      repo: null,
      gitCredentials: null,
    }
  );
  assert.deepEqual(em.names(), ['setSecondaryRepos']);
});

// ── The paths that already worked, kept working ─────────────────────────────

test('moving to another repo switches (not ensures) and reports the switch', async () => {
  const em = makeExecutionManager('gvinsot/Other');
  const res = await ensureAgentWorkspace(
    em,
    { id: 'agent-1', project: 'gvinsot/Other' },
    { repo: 'gvinsot/PulsarTeam', gitCredentials: creds }
  );
  assert.deepEqual(res, { switched: true, prepared: true });
  const call = em.calls.find(c => c.fn === 'switchProject');
  assert.ok(call);
  assert.equal(call.args[1], 'gvinsot/PulsarTeam');
  assert.deepEqual(call.args[3], creds);
});

test('secondary repos force a switch even when the primary is unchanged', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  const secondaryRepos = [{ provider: 'github', fullName: 'gvinsot/Docs' }];
  await ensureAgentWorkspace(em, agentOnRepo(), {
    repo: 'gvinsot/PulsarTeam',
    secondaryRepos,
    gitCredentials: creds,
  });
  assert.deepEqual(em.calls[0], { fn: 'setSecondaryRepos', args: ['agent-1', secondaryRepos] });
  assert.ok(em.names().includes('switchProject'));
  assert.ok(!em.names().includes('ensureProject'));
});

test('an explicit clone URL on the task wins over the derived one', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  await ensureAgentWorkspace(em, agentOnRepo(), {
    repo: 'gvinsot/PulsarTeam',
    repoHtmlUrl: 'https://github.enterprise.local/gvinsot/PulsarTeam.git',
    gitCredentials: creds,
  });
  const ensure = em.calls.find(c => c.fn === 'ensureProject');
  assert.equal(ensure?.args[2], 'https://github.enterprise.local/gvinsot/PulsarTeam.git');
});

// ── Fail-loud where it matters, quiet where it doesn't ──────────────────────

test('a runner sitting on the wrong repo is an error, not a silent mismatch', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  em.ensureProject = async (...args: any[]) => {
    em.calls.push({ fn: 'ensureProject', args });
    // Runner reports a different repo than the task requires.
    em.setProject('someone/else');
  };
  await assert.rejects(
    ensureAgentWorkspace(em, agentOnRepo(), {
      repo: 'gvinsot/PulsarTeam',
      gitCredentials: creds,
    }),
    /Execution environment is on "someone\/else" but task requires "gvinsot\/PulsarTeam"/
  );
});

test('an ensure failure propagates so the caller can report it', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  em.ensureProject = async () => {
    throw new Error('fatal: could not read Username');
  };
  await assert.rejects(
    ensureAgentWorkspace(em, agentOnRepo(), { repo: 'gvinsot/PulsarTeam', gitCredentials: creds }),
    /could not read Username/
  );
});

test('no execution manager is a no-op that still reports the switch', async () => {
  const res = await ensureAgentWorkspace(null, { id: 'a', project: null }, { repo: 'o/r' });
  assert.deepEqual(res, { switched: true, prepared: false });
});

// ── Credential resolution ───────────────────────────────────────────────────

test('credentials are resolved for the agent and its board', async () => {
  const resolved = await resolveAgentGitCredentials(agentOnRepo());
  assert.deepEqual(resolved, { token: 'gh-token', login: 'octocat', provider: 'github' });
  assert.deepEqual(githubCalls, [['agent-1', 'board-1']]);
});

test('a credential lookup failure never aborts the run', async () => {
  githubThrows = true;
  assert.equal(await resolveAgentGitCredentials(agentOnRepo()), null);
  assert.equal(await resolveAgentGitCredentials(null), null);
  assert.equal(githubCalls.length, 1, 'no lookup for a missing agent');
});

// ── Call-site wiring ────────────────────────────────────────────────────────
//
// The skip that caused the bug lived in the workflow action executor, so pin it
// there too: a repo-bound task on an agent already sitting on that repo must
// still reach the runner.

const realDb = await import('../database.js');
mock.module('../database.js', {
  namedExports: { ...realDb, getTaskById: async () => null, getPool: () => null },
});

const { _ensureAgentOnTaskRepo } = await import('../workflow/actionExecutor.js');

test('the action executor prepares the runner even with nothing to switch', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  const agent: any = agentOnRepo();
  const agentManager: any = { executionManager: em, _switchProjectContext: mock.fn() };
  const task: any = { id: 'task-1', repoFullName: 'gvinsot/PulsarTeam', secondaryRepos: [] };

  const res = await _ensureAgentOnTaskRepo(agent, task, null, {
    agentManager,
    mode: 'decide',
    agentId: agent.id,
  });

  assert.deepEqual(res, { ok: true });
  const ensure = em.calls.find(c => c.fn === 'ensureProject');
  assert.ok(ensure, `expected an ensureProject call, got ${em.names().join(', ') || 'none'}`);
  assert.deepEqual(ensure.args[3], { token: 'gh-token', login: 'octocat', provider: 'github' });
  // Nothing moved, so no conversation/context switch.
  assert.equal(agentManager._switchProjectContext.mock.callCount(), 0);
  assert.equal(agent.project, 'gvinsot/PulsarTeam');
});

test('the action executor installs credentials for a repo-less task', async () => {
  const em = makeExecutionManager(null);
  const agent: any = { id: 'agent-1', name: 'Claude #1', project: null, boardId: 'board-1' };
  const agentManager: any = { executionManager: em, _switchProjectContext: mock.fn() };
  const task: any = { id: 'task-1', repoFullName: null, secondaryRepos: [] };

  const res = await _ensureAgentOnTaskRepo(agent, task, null, {
    agentManager,
    mode: 'decide',
    agentId: agent.id,
  });

  assert.deepEqual(res, { ok: true });
  assert.ok(em.names().includes('installGitCredentials'));
});
