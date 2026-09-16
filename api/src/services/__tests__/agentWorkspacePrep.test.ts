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
let githubThrows: Error | null = null;

// routes/github.js is imported lazily by resolveAgentGitCredentials, so the mock
// only needs the one export it reaches for.
mock.module('../../routes/github.js', {
  namedExports: {
    getGitHubCredentialsForAgent: async (agentId: string | null, boardId: string | null) => {
      githubCalls.push([agentId, boardId]);
      if (githubThrows) throw githubThrows;
      return githubCreds;
    },
  },
});

const { ensureAgentWorkspace, ensureTerminalWorkspace, resolveAgentGitCredentials } =
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
  githubThrows = null;
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
  // GHES only works once the operator has allowlisted the host — see the clone
  // URL guard tests below.
  process.env.GIT_CLONE_ALLOWED_HOSTS = 'github.enterprise.local';
  try {
    const em = makeExecutionManager('gvinsot/PulsarTeam');
    await ensureAgentWorkspace(em, agentOnRepo(), {
      repo: 'gvinsot/PulsarTeam',
      repoHtmlUrl: 'https://github.enterprise.local/gvinsot/PulsarTeam.git',
      gitCredentials: creds,
    });
    const ensure = em.calls.find(c => c.fn === 'ensureProject');
    assert.equal(ensure?.args[2], 'https://github.enterprise.local/gvinsot/PulsarTeam.git');
  } finally {
    delete process.env.GIT_CLONE_ALLOWED_HOSTS;
  }
});

// ── The clone-URL allowlist ─────────────────────────────────────────────────
//
// The runner splices the agent's token into the clone URL and writes it to
// ~/.git-credentials, so the host named there receives that token. `repoHtmlUrl`
// is server-derived today, but it IS a task field on the API/MCP surfaces: the
// guard is what keeps a future writable path from turning it into an
// exfiltration channel.

test('a task clone URL on a foreign host never gets the token', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  await assert.rejects(
    ensureAgentWorkspace(em, agentOnRepo(), {
      repo: 'gvinsot/PulsarTeam',
      repoHtmlUrl: 'https://evil.example.com/gvinsot/PulsarTeam.git',
      gitCredentials: creds,
    }),
    /Refusing to send git credentials to https:\/\/evil\.example\.com/
  );
  // Nothing at all reached the runner — not even the keep-set.
  assert.deepEqual(em.names(), []);
});

test('every non-https scheme and look-alike host is refused', async () => {
  for (const url of [
    'http://github.com/gvinsot/PulsarTeam.git', // token in cleartext
    'ssh://github.com/gvinsot/PulsarTeam.git',
    'git://github.com/gvinsot/PulsarTeam.git',
    'file:///etc/passwd',
    'https://github.com.evil.tld/gvinsot/PulsarTeam.git', // suffix trick
    'https://notgithub.com/gvinsot/PulsarTeam.git',
    'https://attacker@github.com/gvinsot/PulsarTeam.git', // userinfo override
    'https://user:pass@github.com/gvinsot/PulsarTeam.git',
    'not a url at all',
  ]) {
    const em = makeExecutionManager('gvinsot/PulsarTeam');
    await assert.rejects(
      ensureAgentWorkspace(em, agentOnRepo(), {
        repo: 'gvinsot/PulsarTeam',
        repoHtmlUrl: url,
        gitCredentials: creds,
      }),
      /Refusing to send git credentials/,
      `should refuse ${url}`
    );
    assert.deepEqual(em.names(), [], `should not call the runner for ${url}`);
  }
});

test('the guard also covers a switch to another repo', async () => {
  const em = makeExecutionManager('gvinsot/Other');
  await assert.rejects(
    ensureAgentWorkspace(
      em,
      { id: 'agent-1', project: 'gvinsot/Other' },
      {
        repo: 'gvinsot/PulsarTeam',
        repoHtmlUrl: 'https://evil.example.com/gvinsot/PulsarTeam.git',
        gitCredentials: creds,
      }
    ),
    /Refusing to send git credentials/
  );
  assert.deepEqual(em.names(), []);
});

test('github.com and an allowlisted GHES host pass, on the exact authority only', async () => {
  const { isAllowedCloneUrl, allowedCloneHosts } = await import('../execution/cloneUrlGuard.js');
  assert.ok(isAllowedCloneUrl('https://github.com/gvinsot/PulsarTeam.git'));
  assert.ok(isAllowedCloneUrl('https://www.github.com/gvinsot/PulsarTeam.git'));
  assert.ok(!isAllowedCloneUrl('https://ghes.corp.local/gvinsot/PulsarTeam.git'));

  // Entries may be written as a bare host, host:port, or a full URL.
  process.env.GIT_CLONE_ALLOWED_HOSTS = 'ghes.corp.local, https://git.corp.local:8443/';
  try {
    assert.ok(isAllowedCloneUrl('https://ghes.corp.local/gvinsot/PulsarTeam.git'));
    assert.ok(isAllowedCloneUrl('https://git.corp.local:8443/gvinsot/PulsarTeam.git'));
    // A port was configured, so the bare host is NOT implicitly allowed.
    assert.ok(!isAllowedCloneUrl('https://git.corp.local/gvinsot/PulsarTeam.git'));
    assert.ok(!isAllowedCloneUrl('http://ghes.corp.local/gvinsot/PulsarTeam.git'));
    assert.deepEqual(allowedCloneHosts(), [
      'github.com',
      'www.github.com',
      'ghes.corp.local',
      'git.corp.local:8443',
    ]);
  } finally {
    delete process.env.GIT_CLONE_ALLOWED_HOSTS;
  }

  // The single-host alias works too.
  process.env.GITHUB_ENTERPRISE_HOST = 'github.acme.io';
  try {
    assert.ok(isAllowedCloneUrl('https://github.acme.io/gvinsot/PulsarTeam.git'));
  } finally {
    delete process.env.GITHUB_ENTERPRISE_HOST;
  }
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
  githubThrows = new Error('oauth store unavailable');
  assert.equal(await resolveAgentGitCredentials(agentOnRepo()), null);
  assert.equal(await resolveAgentGitCredentials(null), null);
  assert.equal(githubCalls.length, 1, 'no lookup for a missing agent');
});

test('a definitive GitHub rejection is propagated instead of retrying stored runner credentials', async () => {
  githubThrows = Object.assign(new Error('Reconnect GitHub in the agent Plugins tab'), {
    code: 'GITHUB_RECONNECT_REQUIRED',
  });
  await assert.rejects(resolveAgentGitCredentials(agentOnRepo()), githubThrows);
});

// ── Call-site wiring ────────────────────────────────────────────────────────
//
// The skip that caused the bug lived in the workflow action executor, so pin it
// there too: a repo-bound task on an agent already sitting on that repo must
// still reach the runner.

const realDb = await import('../database.js');
let persistAgent = async (_agent: any): Promise<void> => {};
const taskWrites: Array<{ id: string; fields: any }> = [];
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    getTaskById: async () => null,
    getPool: () => null,
    saveAgent: (agent: any) => persistAgent(agent),
    updateTaskFields: async (id: string, fields: any) => {
      taskWrites.push({ id, fields });
      return { id, ...fields };
    },
  },
});

beforeEach(() => {
  persistAgent = async () => {};
  taskWrites.length = 0;
});

const { _ensureAgentOnTaskRepo } = await import('../workflow/actionExecutor.js');
const { ExecutionManager } = await import('../execution/executionManager.js');

test('a task repo switch is persisted before preparation completes and a browser reads it', async () => {
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  const agent: any = agentOnRepo();
  let storedAgent = structuredClone(agent);
  let releaseSave!: () => void;
  let saveStarted!: () => void;
  const saving = new Promise<void>(resolve => {
    saveStarted = resolve;
  });
  const saveGate = new Promise<void>(resolve => {
    releaseSave = resolve;
  });
  persistAgent = async value => {
    saveStarted();
    await saveGate;
    storedAgent = structuredClone(value);
  };
  const agentManager: any = {
    executionManager: em,
    _switchProjectContext: mock.fn(),
    _sanitize: (value: any) => value,
    _emit: mock.fn(),
  };
  let prepared = false;
  const preparation = _ensureAgentOnTaskRepo(
    agent,
    { id: 'task-1', repoFullName: 'gvinsot/Jarvis' } as any,
    null,
    { agentManager, mode: 'decide', agentId: agent.id }
  ).then(result => {
    prepared = true;
    return result;
  });
  await saving;
  try {
    assert.equal(prepared, false, 'prompt injection must wait for the DB write');
    assert.equal(agentManager._emit.mock.callCount(), 0);
  } finally {
    releaseSave();
  }
  assert.deepEqual(await preparation, { ok: true });
  assert.equal(storedAgent.project, 'gvinsot/Jarvis');
  assert.ok(storedAgent.projectChangedAt);
  assert.equal(agentManager._emit.mock.callCount(), 1);
  const browserManager = makeExecutionManager();
  await ensureTerminalWorkspace(browserManager, storedAgent, creds);
  assert.equal(browserManager.getProject(), 'gvinsot/Jarvis');
});

test('opening a live terminal never re-provisions a stale configured repo', async () => {
  const em = {
    ...makeExecutionManager('gvinsot/Jarvis'),
    getTerminalSession: async () => ({ alive: true }),
  };
  await ensureTerminalWorkspace(em, agentOnRepo(), creds);
  assert.deepEqual(em.names(), []);
  assert.equal(em.getProject(), 'gvinsot/Jarvis');
});

test('a dead terminal is prepared on the runtime repo even if the DB snapshot is stale', async () => {
  const em = {
    ...makeExecutionManager('gvinsot/Jarvis'),
    getTerminalSession: async () => ({ alive: false }),
  };
  await ensureTerminalWorkspace(em, agentOnRepo(), creds);
  assert.equal(em.calls[0].fn, 'ensureProject');
  assert.equal(em.calls[0].args[1], 'gvinsot/Jarvis');
  assert.deepEqual(em.calls[0].args[3], creds);
});

test('a fresh repo-less terminal still receives git credentials', async () => {
  const em = makeExecutionManager();
  await ensureTerminalWorkspace(em, { id: 'agent-1', project: null }, creds);
  assert.deepEqual(em.names(), ['installGitCredentials']);
});

for (const runner of [
  'claudecode',
  'codex',
  'hermes',
  'openclaw',
  'opencode',
  'aider',
  'sandbox',
]) {
  test(`workflow provisions ${runner} before injecting a task after an API restart`, async t => {
    // The production manager has no resolver: its initial route is sandbox.
    const em = new ExecutionManager();
    const requests: Array<{ url: string; headers: any; body: any }> = [];
    t.mock.method(globalThis, 'fetch', async (url: any, init: any) => {
      requests.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
      return Response.json({ status: 'success' });
    });
    const agent: any = {
      ...agentOnRepo(),
      runner,
      ownerId: 'owner-1',
      llmConfigId: 'llm-1',
      permissions: { execution: { shellAccess: true } },
    };
    const agentManager: any = {
      executionManager: em,
      resolveLlmConfig: () => ({ managesContext: runner !== 'sandbox' }),
    };
    const result = await _ensureAgentOnTaskRepo(
      agent,
      { id: 'task-1', repoFullName: agent.project } as any,
      null,
      { agentManager, mode: 'decide', agentId: agent.id }
    );
    assert.deepEqual(result, { ok: true });
    await em.sendTerminalInput(agent.id, 'Implement the task');
    const prepare = requests.find(r => r.url.endsWith('/projects/ensure'))!;
    const inject = requests.find(r => r.url.endsWith('/terminal/sessions/agent-1/input'))!;
    assert.ok(prepare);
    assert.ok(inject);
    assert.ok(requests.indexOf(prepare) < requests.indexOf(inject));
    assert.equal(em.getProviderType(agent.id), runner);
    assert.equal(new URL(prepare.url).origin, new URL(inject.url).origin);
    assert.match(prepare.url, /\/projects\/ensure$/);
    assert.equal(prepare.body.project, agent.project);
    assert.equal(prepare.body.git_credentials.token, 'gh-token');
    assert.equal(prepare.headers['X-Owner-Id'], 'owner-1');
    assert.equal(prepare.headers['X-Agent-Id'], agent.id);
    assert.deepEqual(JSON.parse(prepare.headers['X-Agent-Permissions']), agent.permissions);
    assert.match(inject.url, /\/terminal\/sessions\/agent-1\/input$/);
  });
}

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

for (const owned of [false, true]) {
  test(`successful workspace preparation retires the previous error (${owned ? 'owned' : 'board'} task)`, async () => {
    const em = makeExecutionManager('gvinsot/PulsarTeam');
    const agent: any = agentOnRepo();
    const manager: any = {
      executionManager: em,
      agents: new Map(),
      _emit: mock.fn(),
      _sanitize: (a: any) => a,
    };
    const history = [{ type: 'error', error: 'GitHub authentication failed' }];
    const task: any = {
      id: 'retry-task',
      repoFullName: agent.project,
      agentId: owned ? agent.id : null,
      status: 'in_progress',
      error: history[0].error,
      errorFromStatus: 'in_progress',
      history,
    };
    const actualTask = owned ? structuredClone(task) : null;
    const result = await _ensureAgentOnTaskRepo(agent, task, actualTask, {
      agentManager: manager,
      mode: 'decide',
      agentId: task.agentId,
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(task.error, null, 'the prompt must not inherit the resolved error');
    assert.equal(task.errorFromStatus, null);
    if (actualTask) assert.equal(actualTask.error, null);
    assert.deepEqual(task.history, history, 'previous failure remains in the audit history');
    assert.deepEqual(taskWrites, [{ id: task.id, fields: { error: null, errorFromStatus: null } }]);
    const event = manager._emit.mock.calls.find((c: any) => c.arguments[0] === 'task:updated');
    assert.equal(event.arguments[1].task.error, null);
  });
}

test('a rejected connection fails preflight without touching the runner or claiming a missing token', async () => {
  githubThrows = Object.assign(new Error('Reconnect GitHub in the agent Plugins tab'), {
    code: 'GITHUB_RECONNECT_REQUIRED',
  });
  const em = makeExecutionManager('gvinsot/PulsarTeam');
  const agent: any = agentOnRepo();
  const result = await _ensureAgentOnTaskRepo(
    agent,
    {
      id: 'rejected-task',
      repoFullName: agent.project,
    } as any,
    null,
    {
      agentManager: { executionManager: em, _emit: mock.fn(), _sanitize: (a: any) => a } as any,
      mode: 'decide',
      agentId: agent.id,
    }
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.result.message!, /GitHub.*rejected/i);
    assert.doesNotMatch(result.result.message!, /no GitHub token/);
  }
  assert.deepEqual(em.calls, [], 'do not retry cached credentials after a definitive rejection');
  assert.deepEqual(taskWrites, [], 'failed preparation must not clear the failure');
});
