import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
import { BUILTIN_MCP_SERVERS } from '../../data/mcpServers.js';
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
  const decoded = jwt.verify(token, secret);
  assert.equal(decoded.username, 'internal-mcp');
  assert.equal(decoded.role, 'admin');
  assert.equal(decoded.internal, true);

  const onedrive = resolveInternalMcpConfig('__internal__onedrive', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(onedrive.url, 'http://localhost:4123/api/onedrive/mcp');

  const passthrough = resolveInternalMcpConfig('https://example.com/mcp', {
    port: 4123,
    jwtSecret: secret,
  });
  assert.equal(passthrough.url, 'https://example.com/mcp');
  assert.deepEqual(passthrough.headers, {});
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

  const listed = manager.getAll();
  assert.ok(listed.some((server) => server.id === 'mcp-code-index'));

  const byId = manager.getById('mcp-code-index');
  assert.ok(byId);
  assert.equal(byId.name, 'Code Index');

  const byName = manager.getById('Code Index');
  assert.ok(byName);
  assert.equal(byName.id, 'mcp-code-index');
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