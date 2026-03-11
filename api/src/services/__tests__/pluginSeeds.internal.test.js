import test from 'node:test';
import assert from 'node:assert/strict';
import * as skillsModule from '../../data/skills.js';
import * as mcpServersModule from '../../data/mcpServers.js';

function firstArrayExport(mod) {
  if (Array.isArray(mod?.default)) {
    return mod.default;
  }

  for (const value of Object.values(mod)) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  throw new Error('Could not find array export');
}

function collectServerRefs(skill) {
  const refs = new Set();

  for (const key of ['mcpServerId', 'defaultMcpServerId', 'serverId', 'mcpId', 'mcpServer']) {
    if (typeof skill?.[key] === 'string' && skill[key].trim()) {
      refs.add(skill[key].trim());
    }
  }

  for (const key of ['mcpServerIds', 'defaultMcpServerIds', 'mcpServers', 'serverIds']) {
    if (Array.isArray(skill?.[key])) {
      for (const entry of skill[key]) {
        if (typeof entry === 'string' && entry.trim()) {
          refs.add(entry.trim());
        }
      }
    }
  }

  return [...refs];
}

const skills = firstArrayExport(skillsModule);
const mcpServers = firstArrayExport(mcpServersModule);

test('seeded builtin plugins reference the canonical MCP server ids', () => {
  for (const skillName of ['OneDrive', 'Code Index']) {
    const skill = skills.find((entry) => entry?.name === skillName);
    assert.ok(skill, `Expected seeded plugin for ${skillName}`);

    const mcpServer = mcpServers.find((entry) => entry?.name === skillName);
    assert.ok(mcpServer?.id, `Expected MCP server seed for ${skillName}`);

    const refs = collectServerRefs(skill);
    assert.ok(refs.length > 0, `${skillName} should declare an MCP server reference in seed data`);
    assert.ok(
      refs.includes(mcpServer.id),
      `${skillName} should reference canonical MCP server id "${mcpServer.id}", got: ${refs.join(', ') || '(none)'}`,
    );
  }
});