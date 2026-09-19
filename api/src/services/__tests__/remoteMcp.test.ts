import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import express from 'express';
import { setPool } from '../database/connection.js';
import * as network from '../remoteMcpFetch.js';
import { PULSAR_TEAM_MCP_SERVERS } from '../../data/pulsarTeamMcp.js';

process.env.ENCRYPTION_KEY = 'remote-mcp-tests-only-0123456789abcdef0123456789abcdef';
const connections = new Map<string, string>();
const flows = new Map<string, { secret: string; expires_at: Date }>();
const locks = new Set<string>();
const sqlCalls: string[] = [];
const agents = new Map<string, { id: string; ownerId: string; boardId?: string }>();
let networkCalls: { url: string; init?: RequestInit }[] = [];
let toolCalls = 0;
let refreshCount = 0;
let useCimd = false;
let transientRefreshFailure = false;
const source = 'https://resource.example/mcp';
const issuer = 'https://identity.example';
const scope = { type: 'agent' as const, id: 'agent-a' };
const server = {
  id: 'remote-1',
  name: 'Remote test',
  url: source,
  remoteAuth: 'oauth' as const,
  enabled: true,
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

async function query(
  sql: string,
  values: unknown[] = []
): Promise<{ rows: any[]; rowCount?: number }> {
  sqlCalls.push(sql);
  const key = JSON.stringify(values.slice(0, 3));
  if (sql.includes('pg_try_advisory_lock')) {
    const id = String(values[0]);
    const locked = !locks.has(id);
    if (locked) locks.add(id);
    return { rows: [{ locked }] };
  }
  if (sql.includes('pg_advisory_unlock')) {
    locks.delete(String(values[0]));
    return { rows: [] };
  }
  if (sql.startsWith('SELECT secret FROM remote_mcp_connections'))
    return { rows: connections.has(key) ? [{ secret: connections.get(key) }] : [] };
  if (sql.includes('INSERT INTO remote_mcp_connections')) {
    connections.set(key, String(values[3]));
    return { rows: [] };
  }
  if (sql.startsWith('DELETE FROM remote_mcp_connections')) {
    connections.delete(key);
    return { rows: [] };
  }
  if (sql.includes('INSERT INTO remote_mcp_oauth_flows')) {
    flows.set(String(values[0]), {
      secret: String(values[4]),
      expires_at: new Date(Date.now() + 600_000),
    });
    return { rows: [] };
  }
  if (sql.startsWith('SELECT secret FROM remote_mcp_oauth_flows')) {
    const row = flows.get(String(values[0]));
    return { rows: row && row.expires_at.getTime() > Date.now() ? [row] : [] };
  }
  if (sql.startsWith('DELETE FROM remote_mcp_oauth_flows WHERE state_hash')) {
    const row = flows.get(String(values[0]));
    flows.delete(String(values[0]));
    return { rows: row ? [row] : [] };
  }
  if (sql.startsWith('DELETE FROM remote_mcp_oauth_flows WHERE expires_at')) return { rows: [] };
  if (sql.startsWith('DELETE FROM remote_mcp_oauth_flows WHERE server_id')) {
    flows.clear();
    return { rows: [] };
  }
  if (sql.includes('FROM agents WHERE id')) {
    const agent = agents.get(String(values[0]));
    return { rows: agent ? [{ data: { ...agent } }] : [] };
  }
  if (sql.includes('FROM users WHERE id'))
    return { rows: [{ id: 'alice', username: 'alice', role: 'advanced' }] };
  throw new Error(`Unexpected test SQL: ${sql}`);
}
const fakePool = { query, connect: async () => ({ query, release: () => {} }) } as unknown as Pool;

const fixtureFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  networkCalls.push({ url, init });
  if (url.includes('oauth-protected-resource'))
    return json({ resource: source, authorization_servers: [issuer], scopes_supported: ['read'] });
  if (url.includes('oauth-authorization-server'))
    return json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: useCimd,
    });
  if (url.endsWith('/register'))
    return json({ client_id: 'registered-client', ...JSON.parse(String(init?.body)) }, 201);
  if (url.endsWith('/token')) {
    const params = new URLSearchParams(String(init?.body));
    if (params.get('grant_type') === 'refresh_token') {
      refreshCount++;
      if (transientRefreshFailure) return json({ error: 'server_error' }, 503);
      return json({
        access_token: 'access-2',
        refresh_token: 'refresh-2',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    assert.equal(params.get('code'), 'authorization-code');
    assert.ok(params.get('code_verifier'));
    assert.equal(params.get('resource'), source);
    return json({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }
  assert.equal(url, source);
  const headers = new Headers(init?.headers);
  if (
    !headers.get('authorization')?.startsWith('Bearer access-') &&
    headers.get('X-Api-Key') !== 'key-a'
  ) {
    return json({}, 401, {
      'WWW-Authenticate':
        'Bearer resource_metadata="https://resource.example/.well-known/oauth-protected-resource"',
    });
  }
  if (init?.method === 'GET') return new Response(null, { status: 405 });
  const body = JSON.parse(String(init?.body));
  if (!('id' in body)) return new Response(null, { status: 202 });
  let result: unknown;
  if (body.method === 'initialize')
    result = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'Fixture', version: '1' },
    };
  else if (body.method === 'tools/list')
    result = { tools: [{ name: 'read', inputSchema: { type: 'object' } }] };
  else if (body.method === 'tools/call') {
    toolCalls++;
    result = { content: [{ type: 'text', text: 'account-a' }] };
  } else throw new Error(`Unexpected RPC ${body.method}`);
  return json({ jsonrpc: '2.0', id: body.id, result });
};
mock.module('../remoteMcpFetch.js', { namedExports: { ...network, remoteMcpFetch: fixtureFetch } });
const remote = await import('../remoteMcp.js');
const store = await import('../remoteMcpStore.js');
const { normalizeRegistryEntry } = await import('../mcpRegistry.js');
const { remoteMcpPublicRoutes, remoteMcpRoutes } = await import('../../routes/remoteMcp.js');

test.beforeEach(() => {
  setPool(fakePool);
  connections.clear();
  flows.clear();
  locks.clear();
  sqlCalls.length = 0;
  agents.clear();
  agents.set('agent-a', { id: 'agent-a', ownerId: 'alice' });
  agents.set('agent-b', { id: 'agent-b', ownerId: 'bob' });
  networkCalls = [];
  toolCalls = 0;
  refreshCount = 0;
  useCimd = false;
  transientRefreshFailure = false;
});

test('OAuth discovers metadata, registers, persists encrypted PKCE, exchanges code and refreshes', async () => {
  const result = await remote.beginRemoteOAuth(
    server,
    scope,
    'alice',
    'https://team.example/api/remote-mcp/oauth/callback'
  );
  const url = new URL(result.authUrl);
  const state = url.searchParams.get('state')!;
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('resource'), source);
  assert.equal(url.searchParams.get('scope'), 'read');
  const persisted = [...flows.values()][0].secret;
  assert.match(persisted, /^enc:v1:/);
  assert.ok(!persisted.includes('registered-client'));
  const flow = await store.consumeRemoteFlow(state);
  assert.ok(flow);
  assert.equal(
    createHash('sha256').update(flow.credentials.verifier!).digest('base64url'),
    url.searchParams.get('code_challenge')
  );
  assert.equal(await store.consumeRemoteFlow(state), null, 'state is single use across replicas');
  await remote.finishRemoteOAuth(flow.credentials, 'authorization-code');
  assert.equal(flow.credentials.verifier, undefined);
  flow.credentials.expiresAt = 1;
  await store.writeRemoteCredentials(server.id, scope, flow.credentials);
  assert.ok(![...connections.values()][0].includes('refresh-1'));
  const resultCall = await remote.useRemoteClient(server, scope, client =>
    client.callTool('read', {})
  );
  assert.equal(resultCall.content[0].text, 'account-a');
  assert.equal(refreshCount, 1);
  assert.equal(toolCalls, 1);
  assert.equal(
    (await store.readRemoteCredentials(server.id, scope))?.tokens?.refresh_token,
    'refresh-2'
  );
  assert.equal(locks.size, 0);
});

test('PulsarTeam plugins discover and call existing surfaces with attachment-scoped keys', async t => {
  const calls: { url: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    calls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    return fixtureFetch(source, init);
  });
  for (const builtin of PULSAR_TEAM_MCP_SERVERS) {
    await store.writeRemoteCredentials(builtin.id, scope, {
      url: builtin.url,
      mode: 'api_key',
      apiKey: 'access-scoped-key',
      headerName: 'Authorization',
      prefix: 'Bearer ',
    });
    const attachment = await remote.remoteScopeForAgent(builtin.id, 'agent-a');
    const result = await remote.useRemoteClient(builtin, attachment, async client => {
      assert.equal(client.tools[0].name, 'read');
      return client.callTool('read', {});
    });
    assert.equal(result.content[0].text, 'account-a');
    await assert.rejects(remote.remoteScopeForAgent(builtin.id, 'agent-b'), /Connectez/);
    assert.ok(calls.some(c => c.url === builtin.url));
  }
  assert.equal(toolCalls, 3);
  assert.ok(calls.every(c => c.authorization === 'Bearer access-scoped-key'));
});

test('CIMD avoids dynamic registration when advertised', async () => {
  useCimd = true;
  const { authUrl } = await remote.beginRemoteOAuth(
    server,
    scope,
    'alice',
    'https://team.example/api/remote-mcp/oauth/callback'
  );
  assert.equal(
    new URL(authUrl).searchParams.get('client_id'),
    'https://team.example/api/remote-mcp/oauth/client-metadata'
  );
  assert.equal(networkCalls.filter(c => c.url.endsWith('/register')).length, 0);
});

test('API keys are scoped, encrypted, injected as custom headers, and never fall back across agents', async () => {
  const keyServer = { ...server, remoteAuth: 'api_key' as const };
  await store.writeRemoteCredentials(server.id, scope, {
    url: source,
    mode: 'api_key',
    apiKey: 'key-a',
    headerName: 'X-Api-Key',
    prefix: '',
  });
  assert.equal((await remote.remoteScopeForAgent(server.id, 'agent-a')).id, 'agent-a');
  await assert.rejects(remote.remoteScopeForAgent(server.id, 'agent-b'), /Connectez/);
  await remote.useRemoteClient(keyServer, scope, client => client.callTool('read', {}));
  assert.equal(toolCalls, 1);
  assert.ok(networkCalls.some(c => new Headers(c.init?.headers).get('X-Api-Key') === 'key-a'));
  await assert.rejects(
    remote.useRemoteClient(
      { ...keyServer, url: 'https://other.example/mcp' },
      scope,
      async () => {}
    ),
    /Connectez/
  );
  await store.disconnectRemote(server.id, scope);
  await assert.rejects(
    remote.useRemoteClient(keyServer, scope, async () => {}),
    /Connectez/
  );
});

test('only the board persisted on the agent is eligible for an inherited connection', async () => {
  agents.set('agent-a', { id: 'agent-a', ownerId: 'alice', boardId: 'board-a' });
  await store.writeRemoteCredentials(
    server.id,
    { type: 'board', id: 'board-b' },
    { url: source, mode: 'api_key', apiKey: 'other' }
  );
  await assert.rejects(remote.remoteScopeForAgent(server.id, 'agent-a'), /Connectez/);
  await store.writeRemoteCredentials(
    server.id,
    { type: 'board', id: 'board-a' },
    { url: source, mode: 'api_key', apiKey: 'own-board' }
  );
  assert.deepEqual(await remote.remoteScopeForAgent(server.id, 'agent-a'), {
    type: 'board',
    id: 'board-a',
  });
});

test('transient refresh failures preserve the refresh token and never initiate background consent', async () => {
  const { authUrl } = await remote.beginRemoteOAuth(
    server,
    scope,
    'alice',
    'https://team.example/api/remote-mcp/oauth/callback'
  );
  const flow = await store.consumeRemoteFlow(new URL(authUrl).searchParams.get('state')!);
  assert.ok(flow);
  await remote.finishRemoteOAuth(flow.credentials, 'authorization-code');
  flow.credentials.expiresAt = 1;
  await store.writeRemoteCredentials(server.id, scope, flow.credentials);
  transientRefreshFailure = true;
  await assert.rejects(remote.useRemoteClient(server, scope, async () => {}));
  assert.equal(
    (await store.readRemoteCredentials(server.id, scope))?.tokens?.refresh_token,
    'refresh-1'
  );
  assert.equal(flows.size, 0);
  assert.equal(toolCalls, 0);
});

test('registry keeps only concrete public remote HTTP endpoints and rejects local packages', () => {
  const raw = {
    server: {
      name: 'test',
      description: 'Test',
      version: '1',
      packages: [{ registryType: 'npm' }],
      remotes: [
        { type: 'stdio', url: 'https://safe.example' },
        { type: 'streamable-http', url: 'https://127.0.0.1/mcp' },
        { type: 'streamable-http', url: 'https://safe.example/{tenant}' },
        { type: 'streamable-http', url: source },
      ],
    },
  };
  assert.deepEqual(
    normalizeRegistryEntry(raw)?.remotes.map(r => r.url),
    [source]
  );
  assert.equal(normalizeRegistryEntry({ server: { ...raw.server, remotes: [] } }), null);
});

test('private URLs, metadata destinations and header injection are rejected', () => {
  for (const url of [
    'http://example.com',
    'https://localhost',
    'https://10.0.0.1',
    'https://169.254.169.254',
    'https://[::1]',
    'https://[::ffff:a00:1]',
    'https://user:secret@example.com',
  ])
    assert.throws(() => network.validateRemoteUrl(url));
  for (const ip of ['127.0.0.1', '192.168.1.1', '100.64.0.1', 'fe80::1', 'fc00::1'])
    assert.equal(network.isPublicAddress(ip), false);
  assert.equal(network.isPublicAddress('8.8.8.8'), true);
  for (const headerName of ['Host', 'Cookie', 'Proxy-Authorization', 'X-Key\r\nFoo'])
    assert.throws(() =>
      remote.remoteKeyHeaders({ url: source, mode: 'api_key', apiKey: 'secret', headerName })
    );
});

test('manager discovers remote tools for each account without using global keys or cached tools', async () => {
  const { MCPManager } = await import('../mcpManager.js');
  const manager = new MCPManager();
  manager.servers.set(server.id, {
    ...server,
    remoteAuth: 'api_key',
    tools: [{ name: 'other-account-tool' }],
    apiKey: 'global-key',
  });
  await store.writeRemoteCredentials(server.id, scope, {
    url: source,
    mode: 'api_key',
    apiKey: 'key-a',
    headerName: 'X-Api-Key',
  });
  assert.deepEqual(
    (await manager.getToolsForAgent([server.id], 'agent-a')).tools.map(t => t.name),
    ['read']
  );
  const denied = await manager.getToolsForAgent([server.id], 'agent-b');
  assert.equal(denied.tools.length, 0);
  assert.equal(denied.unavailable.length, 1);
  const result = await manager.callToolByNameForAgent(server.name, 'read', {}, 'agent-a');
  assert.equal(result.result, 'account-a');
  await assert.rejects(manager.callToolByNameForAgent(server.name, 'read', {}, 'agent-b'));
  assert.equal(toolCalls, 1);
});

test('disconnect cancels pending consent and expired states cannot be consumed', async () => {
  const { authUrl } = await remote.beginRemoteOAuth(
    server,
    scope,
    'alice',
    'https://team.example/api/remote-mcp/oauth/callback'
  );
  const state = new URL(authUrl).searchParams.get('state')!;
  await store.disconnectRemote(server.id, scope);
  assert.equal(await store.consumeRemoteFlow(state), null);
  const next = await remote.beginRemoteOAuth(
    server,
    scope,
    'alice',
    'https://team.example/api/remote-mcp/oauth/callback'
  );
  for (const flow of flows.values()) flow.expires_at = new Date(0);
  assert.equal(
    await store.consumeRemoteFlow(new URL(next.authUrl).searchParams.get('state')!),
    null
  );
});

test('connection locks prevent overlapping refreshes and release after exceptions', async () => {
  await store.withRemoteLock(server.id, scope, async () => {
    await assert.rejects(
      store.withRemoteLock(server.id, scope, async () => {}),
      /occupée/
    );
  });
  await assert.rejects(
    store.withRemoteLock(server.id, scope, async () => {
      throw new Error('operation failed');
    }),
    /operation failed/
  );
  assert.equal(locks.size, 0);
});

test('routes reject cross-user scope access, omit secrets, and consume OAuth callbacks once', async t => {
  const app = express();
  app.use(express.json());
  const manager = { getById: (id: string) => (id === server.id ? server : null) };
  app.use('/api/remote-mcp', remoteMcpPublicRoutes(manager as never));
  app.use((req, _res, next) => {
    req.user = { userId: 'alice', username: 'alice', role: 'advanced', csrf: '' };
    next();
  });
  app.use('/api/remote-mcp', remoteMcpRoutes(manager as never, {} as never));
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) =>
    res.status(400).json({ error: err.message })
  );
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  const addr = http.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}/api/remote-mcp`;
  const denied = await fetch(`${base}/${server.id}/status?agentId=agent-b`);
  assert.equal(denied.status, 403);
  for (const action of ['auth-url', 'api-key', 'disconnect', 'test']) {
    const deniedWrite = await fetch(`${base}/${server.id}/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: 'agent-b', apiKey: 'stolen' }),
    });
    assert.equal(deniedWrite.status, 403);
  }
  const both = await fetch(`${base}/${server.id}/status?agentId=agent-a&boardId=board-b`);
  assert.equal(both.status, 400);
  const { authUrl } = await remote.beginRemoteOAuth(
    server,
    scope,
    'alice',
    'https://team.example/api/remote-mcp/oauth/callback'
  );
  const state = new URL(authUrl).searchParams.get('state')!;
  const callback = `${base}/oauth/callback?${new URLSearchParams({ state, code: 'authorization-code' })}`;
  assert.match(await (await fetch(callback)).text(), /"success":true/);
  assert.match(await (await fetch(callback)).text(), /"success":false/);
  const status = await (await fetch(`${base}/${server.id}/status?agentId=agent-a`)).text();
  assert.match(status, /"connected":true/);
  assert.ok(!status.includes('access-1'));
  assert.ok(!status.includes('refresh-1'));
});
