import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import * as realDb from '../database.js';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';

let token = 'revoked-test-token';
mock.module('../database.js', {
  namedExports: {
    ...realDb,
    resolveOAuthTokenRecord: async () => ({
      accessToken: token,
      scopeType: 'agent',
      record: { meta: { login: 'test-user' } },
    }),
    saveAgent: async () => {},
  },
});
const { crudMethods } = await import('../agentManager/crud.js');
const { agentRoutes } = await import('../../routes/agents.js');
const { invalidateSecret } = await import('../../secrets.js');

test('repository selection rejects revoked auth before stopping, then succeeds after reconnect', async t => {
  const oldEnv = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  invalidateSecret('GITHUB_TOKEN');
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    if (url === 'https://api.github.com/user') {
      return new Response('{}', { status: token === 'revoked-test-token' ? 401 : 200 });
    }
    return realFetch(url, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
    if (oldEnv === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = oldEnv;
    invalidateSecret('GITHUB_TOKEN');
  });

  const agent: any = { id: 'agent', ownerId: 'user-A', project: null, status: 'busy' };
  const control = { id: 'control', ownerId: 'user-A', project: 'gvinsot/Intra-Muros' };
  const manager: any = {
    ...crudMethods,
    agents: new Map([
      ['agent', agent],
      ['control', control],
    ]),
    executionManager: {
      switchProject: mock.fn(async () => {}),
      ensureProject: mock.fn(async () => {}),
    },
    stopAgent: mock.fn(),
    _emit: mock.fn(),
    _sanitize: (a: any) => a,
    _switchProjectContext: mock.fn(),
  };
  const api = createRouteHarness(agentRoutes(manager), harnessUser({ role: 'advanced' }));
  const rejected = await api.put('/agent', { project: 'gvinsot/Intra-Muros' });
  assert.equal(rejected.status, 409);
  const body = await rejected.json();
  assert.equal(body.code, 'GITHUB_RECONNECT_REQUIRED');
  assert.match(body.error, /Reconnect GitHub/);
  assert.ok(!JSON.stringify(body).includes(token));
  assert.equal(agent.project, null);
  assert.equal(agent.status, 'busy');
  assert.equal(manager.stopAgent.mock.callCount(), 0);
  assert.equal(manager.executionManager.switchProject.mock.callCount(), 0);

  token = 'reconnected-test-token';
  const accepted = await api.put('/agent', { project: 'gvinsot/Intra-Muros' });
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).project, 'gvinsot/Intra-Muros');
  assert.equal(manager.executionManager.switchProject.mock.callCount(), 1);
  assert.equal(manager.executionManager.switchProject.mock.calls[0].arguments[3].token, token);
  assert.equal(control.project, 'gvinsot/Intra-Muros');

  token = 'revoked-test-token';
  const cleared = await api.put('/agent', { project: null });
  assert.equal(cleared.status, 200);
  assert.equal(agent.project, null);
  assert.equal(manager.executionManager.ensureProject.mock.callCount(), 1);
});
