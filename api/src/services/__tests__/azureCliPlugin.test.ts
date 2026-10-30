/**
 * Azure CLI plugin (routes/azure.ts, routes/lib/credentialConnector.ts,
 * routes/internalRunnerAzure.ts). What must hold:
 *
 *  1. The credential connector checks the caller's access to the agent/board
 *     it reads or writes — before any probe or storage.
 *  2. /connect validates the service principal shape, probes it against Entra
 *     ID + ARM, and stores tenant/client/secret plus the chosen subscription.
 *  3. The runner endpoint releases the credentials only while the plugin is
 *     attached to the agent or its board.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteHarness, harnessUser } from './helpers/routeHarness.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '22222222-2222-2222-2222-222222222222';
const SUB_A = '33333333-3333-3333-3333-333333333333';
const SUB_B = '44444444-4444-4444-4444-444444444444';

// ── Boundaries ──────────────────────────────────────────────────────────────
const tokens = new Map<string, { meta: Record<string, unknown> }>();
const key = (p: string, t: string, id: string) => `${p}:${t}:${id}`;
const BOARDS: Record<string, { id: string; plugins: string[] }> = {
  'board-azure': { id: 'board-azure', plugins: ['skill-azure-cli'] },
  'board-plain': { id: 'board-plain', plugins: [] },
};

mock.module('../../lib/agentAccess.js', {
  namedExports: {
    checkAgentIdAccess: async (id: string) =>
      id.startsWith('agent-mine')
        ? { ok: true }
        : { ok: false, status: 403, error: 'Access denied' },
    checkBoardIdAccess: async (id: string) =>
      id === 'board-mine' ? { ok: true } : { ok: false, status: 403, error: 'Access denied' },
  },
});
mock.module('../database.js', {
  namedExports: {
    storeOAuthToken: async (r: {
      provider: string;
      scopeType: string;
      scopeId: string;
      meta: Record<string, unknown>;
    }) => {
      tokens.set(key(r.provider, r.scopeType, r.scopeId), { meta: r.meta });
    },
    getOAuthToken: (p: string, t: string, id: string) => tokens.get(key(p, t, id)) ?? null,
    deleteOAuthToken: async (p: string, t: string, id: string) => {
      tokens.delete(key(p, t, id));
    },
    getBoardById: async (id: string) => BOARDS[id] ?? null,
  },
});

// Azure endpoints are faked; everything else (the harness' own localhost
// requests) goes to the real fetch.
const realFetch = globalThis.fetch;
const azureCalls: string[] = [];
let subscriptions = [{ subscriptionId: SUB_A, displayName: 'Prod' }];
let tokenOk = true;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://login.microsoftonline.com/')) {
    azureCalls.push(url);
    return tokenOk
      ? Response.json({ access_token: 'arm-token' })
      : Response.json(
          { error: 'invalid_client', error_description: 'AADSTS7000215: Invalid secret.\nTrace' },
          { status: 401 }
        );
  }
  if (url.startsWith('https://management.azure.com/')) {
    azureCalls.push(url);
    return Response.json({ value: subscriptions });
  }
  return realFetch(input, init);
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const { azureRoutes } = await import('../../routes/azure.js');
const { internalRunnerAzureRoutes } = await import('../../routes/internalRunnerAzure.js');

const http = createRouteHarness(azureRoutes(), harnessUser());
const sp = { tenantId: TENANT, clientId: CLIENT, clientSecret: 's3cr3t' };

test.beforeEach(() => {
  tokens.clear();
  azureCalls.length = 0;
  subscriptions = [{ subscriptionId: SUB_A, displayName: 'Prod' }];
  tokenOk = true;
});

test('connect/status/disconnect refuse a scope the caller cannot access', async () => {
  const res = await http.post('/connect', { agentId: 'agent-other', ...sp });
  assert.equal(res.status, 403);
  assert.equal(tokens.size, 0);
  assert.equal(azureCalls.length, 0, 'no probe before authorization');

  assert.equal((await http.get('/status?agentId=agent-other')).status, 403);
  assert.equal((await http.get('/status?boardId=board-other')).status, 403);
  tokens.set(key('azure', 'agent', 'agent-other'), { meta: {} });
  assert.equal((await http.post('/disconnect', { agentId: 'agent-other' })).status, 403);
  assert.ok(tokens.has(key('azure', 'agent', 'agent-other')));
});

test('connect validates the service principal shape before probing', async () => {
  for (const body of [
    { agentId: 'agent-mine', tenantId: TENANT, clientId: CLIENT },
    { agentId: 'agent-mine', ...sp, tenantId: 'evil.com/../x' },
    { agentId: 'agent-mine', ...sp, clientId: 'not-a-guid' },
    { agentId: 'agent-mine', ...sp, subscriptionId: 'nope' },
  ]) {
    const res = await http.post('/connect', body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  assert.equal((await http.post('/connect', sp)).status, 400, 'scope is required');
  assert.equal(azureCalls.length, 0);
});

test('connect probes the principal and stores it with its only subscription', async () => {
  const res = await http.post('/connect', { agentId: 'agent-mine', ...sp });
  assert.equal(res.status, 200);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.subscriptionId, SUB_A);
  assert.ok(azureCalls[0].startsWith(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/`));

  const stored = tokens.get(key('azure', 'agent', 'agent-mine'));
  assert.deepEqual(stored?.meta, { ...sp, subscriptionId: SUB_A, subscriptionName: 'Prod' });

  const status = (await (await http.get('/status?agentId=agent-mine')).json()) as Record<
    string,
    unknown
  >;
  assert.equal(status.connected, true);
  assert.equal(status.subscriptionName, 'Prod');
  assert.equal(JSON.stringify(status).includes('s3cr3t'), false, 'status never returns the secret');
});

test('connect rejects a subscription the principal cannot reach, and a bad secret', async () => {
  subscriptions = [
    { subscriptionId: SUB_A, displayName: 'Prod' },
    { subscriptionId: SUB_A.replace(/3/g, '5'), displayName: 'Dev' },
  ];
  let res = await http.post('/connect', { agentId: 'agent-mine', ...sp, subscriptionId: SUB_B });
  assert.equal(res.status, 400);
  assert.equal(tokens.size, 0);

  tokenOk = false;
  res = await http.post('/connect', { boardId: 'board-mine', ...sp });
  assert.equal(res.status, 400);
  const { error } = (await res.json()) as { error: string };
  assert.match(error, /AADSTS7000215: Invalid secret\.$/);
  assert.equal(tokens.size, 0);
});

test('connect with several subscriptions and none chosen stores no default', async () => {
  subscriptions = [
    { subscriptionId: SUB_A, displayName: 'Prod' },
    { subscriptionId: SUB_B, displayName: 'Dev' },
  ];
  const res = await http.post('/connect', { boardId: 'board-mine', ...sp });
  assert.equal(res.status, 200);
  assert.deepEqual(tokens.get(key('azure', 'board', 'board-mine'))?.meta, sp);
});

// ── Runner endpoint ─────────────────────────────────────────────────────────

function runner(agents: Record<string, { id: string; skills: string[]; boardId: string | null }>) {
  const manager = { getById: (id: string) => agents[id] ?? null };
  return createRouteHarness(
    internalRunnerAzureRoutes(
      manager as unknown as Parameters<typeof internalRunnerAzureRoutes>[0]
    ),
    null
  );
}

test('runner endpoint releases credentials only while the plugin is attached', async () => {
  tokens.set(key('azure', 'agent', 'a-attached'), { meta: { ...sp, subscriptionId: SUB_A } });
  tokens.set(key('azure', 'agent', 'a-detached'), { meta: sp });
  tokens.set(key('azure', 'board', 'board-azure'), { meta: sp });
  tokens.set(key('azure', 'board', 'board-plain'), { meta: sp });
  const r = runner({
    'a-attached': { id: 'a-attached', skills: ['skill-azure-cli'], boardId: null },
    'a-detached': { id: 'a-detached', skills: [], boardId: null },
    'a-board': { id: 'a-board', skills: [], boardId: 'board-azure' },
    'a-plain-board': { id: 'a-plain-board', skills: [], boardId: 'board-plain' },
  });

  assert.deepEqual(await (await r.get('/agents/a-attached')).json(), {
    configured: true,
    ...sp,
    subscriptionId: SUB_A,
  });
  assert.deepEqual(await (await r.get('/agents/a-detached')).json(), { configured: false });
  assert.deepEqual(await (await r.get('/agents/a-board')).json(), {
    configured: true,
    ...sp,
    subscriptionId: null,
  });
  assert.deepEqual(await (await r.get('/agents/a-plain-board')).json(), { configured: false });
  assert.equal((await r.get('/agents/unknown')).status, 404);
});
