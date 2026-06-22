import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { BUILTIN_MCP_SERVERS, INTERNAL_MCP_SERVERS } from '../../data/mcpServers.js';
import { BUILTIN_SKILLS } from '../../data/skills.js';
import { MCPManager, resolveInternalMcpConfig } from '../mcpManager.js';

test('resolveInternalMcpConfig maps internal MCP URLs and signs an auth token', () => {
  const secret = 'test-secret';

  const codeIndex = resolveInternalMcpConfig('__internal__code_index', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(codeIndex.url, 'http://localhost:4123/api/code-index/mcp');
  assert.ok(codeIndex.headers.Authorization.startsWith('Bearer '));

  const token = codeIndex.headers.Authorization.slice('Bearer '.length);
  const decoded = jwt.verify(token, secret) as any;
  assert.equal(decoded.username, 'internal-mcp');
  assert.equal(decoded.role, 'admin');
  assert.equal(decoded.internal, true);

  const onedrive = resolveInternalMcpConfig('__internal__onedrive', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(onedrive.url, 'http://localhost:4123/api/onedrive/mcp');

  // Paths are not derivable from the url slug — pin the irregular one.
  const s3 = resolveInternalMcpConfig('__internal__aws_s3', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(s3.url, 'http://localhost:4123/api/s3/mcp');

  // Legacy dashed alias must keep resolving to the same endpoint.
  const dashAlias = resolveInternalMcpConfig('__internal__code-index', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(dashAlias.url, 'http://localhost:4123/api/code-index/mcp');

  const passthrough = resolveInternalMcpConfig('https://example.com/mcp', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(passthrough.url, 'https://example.com/mcp');
  assert.deepEqual(passthrough.headers, {});
});

test('internal MCP agent-context set matches the per-agent credential servers', () => {
  const agentContextUrls = [...INTERNAL_MCP_SERVERS.entries()]
    .filter(([, def]) => def.agentContext)
    .map(([url]) => url)
    .sort();

  assert.deepEqual(agentContextUrls, [
    '__internal__gdrive',
    '__internal__github',
    '__internal__gmail',
    '__internal__jira',
    // Resolves X-Agent-Id → agent.ownerId to reach the right user's desktop app.
    '__internal__local_folder',
    '__internal__onedrive',
    '__internal__outlook',
    '__internal__pulsar_gateway',
    '__internal__slack',
    '__internal__wordpress',
  ]);

  // Every internal builtin server URL must have a definition (plus the alias).
  for (const server of BUILTIN_MCP_SERVERS) {
    if (typeof server.url === 'string' && server.url.startsWith('__internal__')) {
      assert.ok(INTERNAL_MCP_SERVERS.has(server.url), `missing INTERNAL_MCP_SERVERS entry for ${server.url}`);
    }
  }
});

test('builtin Code Index plugin is wired to the internal MCP server', () => {
  const codeIndexServer = BUILTIN_MCP_SERVERS.find((server) => server.id === 'mcp-code-index');
  assert.ok(codeIndexServer);
  assert.equal(codeIndexServer.url, '__internal__code_index');

  const codeIndexSkill = BUILTIN_SKILLS.find((skill) => skill.id === 'skill-code-index');
  assert.ok(codeIndexSkill);
  assert.deepEqual(codeIndexSkill.mcpServerIds, ['mcp-code-index']);
  assert.match(codeIndexSkill.instructions, /Code Index/i);
  assert.match(codeIndexSkill.instructions, /search_semantic/i);
});

test('builtin MCP servers remain discoverable before explicit seeding', () => {
  const manager = new MCPManager();

  const listed = manager.getAll() as any[];
  assert.ok(listed.some((server) => server.id === 'mcp-code-index'));

  const byId = manager.getById('mcp-code-index');
  assert.ok(byId);
  assert.equal(byId.name, 'Code Index');

  const byName = manager.getById('Code Index');
  assert.ok(byName);
  assert.equal(byName.id, 'mcp-code-index');
});
test('_isSessionExpired matches the session/token expiry heuristics', () => {
  const manager = new MCPManager() as any;

  assert.equal(manager._isSessionExpired(new Error('HTTP 404: Not Found')), true);
  assert.equal(manager._isSessionExpired(new Error('session terminated')), true);
  assert.equal(manager._isSessionExpired(new Error('Invalid token')), true);
  assert.equal(manager._isSessionExpired(new Error('401 Unauthorized')), true);

  assert.equal(manager._isSessionExpired(new Error('ECONNREFUSED')), false);
  assert.equal(manager._isSessionExpired({}), false);
  assert.equal(manager._isSessionExpired(undefined), false);
});

test('_callAgentClient retries once through a fresh client when the session expired', async () => {
  const manager = new MCPManager() as any;
  const server = { id: 'srv-1', name: 'Test Server', url: 'https://example.com/mcp' };
  const cacheKey = 'agent-1:srv-1';

  const staleClient = {
    isConnected: true,
    closed: false,
    async callTool() { throw new Error('404 session not found'); },
    async close() { this.closed = true; },
  };
  const freshClient = {
    isConnected: true,
    async callTool(toolName: string) {
      return { isError: false, content: [{ type: 'text', text: `ok:${toolName}` }] };
    },
    async close() {},
  };

  manager.agentClients.set(cacheKey, staleClient);
  const connectCalls: any[] = [];
  manager._connectAgentClient = async (key: string, _srv: any, headers: any) => {
    connectCalls.push({ key, headers });
    manager.agentClients.set(key, freshClient);
    return freshClient;
  };

  const result = await manager._callAgentClient(
    cacheKey, server, { 'X-Agent-Id': 'agent-1' }, 'do_thing', {}, 'Agent context session expired',
  );

  assert.equal(result.success, true);
  assert.equal(result.result, 'ok:do_thing');
  assert.equal(staleClient.closed, true, 'stale client must be closed before retrying');
  assert.equal(connectCalls.length, 1);
  assert.deepEqual(connectCalls[0].headers, { 'X-Agent-Id': 'agent-1' });
  assert.equal(manager.agentClients.get(cacheKey), freshClient);
});

test('_callAgentClient rethrows non-expiry errors without retrying', async () => {
  const manager = new MCPManager() as any;
  const server = { id: 'srv-1', name: 'Test Server', url: 'https://example.com/mcp' };
  const cacheKey = 'agent-1:srv-1';

  const client = {
    isConnected: true,
    closed: false,
    async callTool() { throw new Error('ECONNRESET'); },
    async close() { this.closed = true; },
  };
  manager.agentClients.set(cacheKey, client);
  manager._connectAgentClient = async () => {
    throw new Error('should not reconnect on non-expiry errors');
  };

  await assert.rejects(
    () => manager._callAgentClient(cacheKey, server, {}, 'do_thing', {}, 'Agent session/token expired'),
    /ECONNRESET/,
  );
  assert.equal(client.closed, false, 'client must stay cached on non-expiry errors');
  assert.equal(manager.agentClients.get(cacheKey), client);
});

test('deprecated builtin skills are no longer exposed', () => {
  const removedSkillIds = [
    'skill-docker-expert',
    'skill-code-review',
    'skill-api-design',
    'skill-testing',
    'skill-git-workflow',
    'skill-security-audit',
    'skill-performance',
    'skill-documentation',
  ];

  const activeIds = new Set(BUILTIN_SKILLS.map((skill) => skill.id));

  for (const skillId of removedSkillIds) {
    assert.equal(activeIds.has(skillId), false);
  }
});