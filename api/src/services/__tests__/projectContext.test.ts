import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerExecutionProvider } from '../execution/runnerExecutionProvider.js';
import { conversationMethods } from '../agentManager/conversation.js';
import { crudMethods } from '../agentManager/crud.js';

test('detaching a repository reaches the runner and only commits state on success', async () => {
  const provider = new RunnerExecutionProvider({ baseUrl: 'http://runner', apiKey: 'test' });
  provider._agents.set('agent', { project: 'owner/a', ready: true });
  const requests: any[] = [];
  let fail = true;
  (provider as any)._fetch = async (_url: string, init: any) => {
    requests.push(JSON.parse(init.body));
    return {
      ok: true,
      json: async () => (fail ? { status: 'error', error: 'failed' } : { status: 'success' }),
    };
  };
  provider.refreshFileTree = async () => {};
  await assert.rejects(provider.ensureProject('agent', null, null), /failed/);
  assert.equal(provider.getProject('agent'), 'owner/a');
  fail = false;
  await provider.ensureProject('agent', null, null);
  assert.equal(provider.getProject('agent'), null);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].project, null);
});

test('returning to a repository restores its own history and clears transient thinking', () => {
  const agent: any = {
    name: 'Agent',
    conversationHistory: [{ role: 'user', content: 'work in A' }],
    runnerSessions: { claude: 'session-a' },
    currentThinking: 'thinking A',
  };
  const change = (oldProject: string, newProject: string) =>
    conversationMethods._switchProjectContext.call({}, agent, oldProject, newProject);
  change('owner/a', 'owner/b');
  assert.deepEqual(agent.conversationHistory, []);
  agent.conversationHistory.push({ role: 'user', content: 'work in B' });
  agent.currentThinking = 'thinking B';
  change('owner/b', 'owner/a');
  assert.equal(agent.conversationHistory[0].content, 'work in A');
  assert.deepEqual(agent.runnerSessions, { claude: 'session-a' });
  assert.equal(agent.currentThinking, '');
  const history = agent.conversationHistory;
  change('owner/a', 'owner/a');
  assert.equal(agent.conversationHistory, history);
});

test('manual and bulk switches await preparation and preserve history on failure', async () => {
  const agent: any = {
    id: 'switch-test',
    name: 'Agent',
    project: 'owner/a',
    conversationHistory: [{ role: 'user', content: 'work in A' }],
  };
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => {
    entered = resolve;
  });
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  let fail = false;
  const manager: any = {
    agents: new Map([[agent.id, agent]]),
    stopAgent() {},
    _emit() {},
    _sanitize: (value: any) => ({ ...value }),
    _switchProjectContext: conversationMethods._switchProjectContext,
    executionManager: {
      async switchProject() {
        entered();
        await gate;
        if (fail) throw new Error('clone failed');
      },
    },
  };
  const pending = crudMethods.update.call(manager, agent.id, { project: 'owner/b' });
  await started;
  assert.equal(agent.project, 'owner/a');
  assert.equal(agent.conversationHistory[0].content, 'work in A');
  assert.equal(agent.projectSwitching, true);
  release();
  await pending;
  assert.equal(agent.project, 'owner/b');
  assert.equal(agent.projectSwitching, false);
  agent.conversationHistory.push({ role: 'user', content: 'work in B' });
  fail = true;
  await assert.rejects(crudMethods.updateAllProjects.call(manager, 'owner/c'), /clone failed/);
  assert.equal(agent.project, 'owner/b');
  assert.equal(agent.conversationHistory[0].content, 'work in B');
  assert.equal(agent.projectSwitching, false);
});
