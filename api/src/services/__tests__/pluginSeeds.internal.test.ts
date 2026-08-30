import test from 'node:test';
import assert from 'node:assert/strict';
import * as skillsModule from '../../data/skills.js';
import * as mcpServersModule from '../../data/mcpServers.js';

// This suite deliberately refuses to name anything in the seed modules: it
// asserts that whichever array a seed file ships still cross-references the MCP
// server seeds, and it probes half a dozen candidate key spellings for the
// reference. So the modules and their entries come in as `unknown` and every
// field is checked before it is read, which is what the code already did by
// hand with `?.` and `typeof`.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function firstArrayExport(mod: unknown): unknown[] {
  const moduleExports: Record<string, unknown> = isRecord(mod) ? mod : {};
  if (Array.isArray(moduleExports.default)) {
    return moduleExports.default;
  }

  for (const value of Object.values(moduleExports)) {
    if (Array.isArray(value)) {
      return value;
    }
  }

  throw new Error('Could not find array export');
}

function collectServerRefs(skill: unknown): string[] {
  const refs = new Set<string>();
  const entry: Record<string, unknown> = isRecord(skill) ? skill : {};

  for (const key of ['mcpServerId', 'defaultMcpServerId', 'serverId', 'mcpId', 'mcpServer']) {
    const value = entry[key];
    if (typeof value === 'string' && value.trim()) {
      refs.add(value.trim());
    }
  }

  for (const key of ['mcpServerIds', 'defaultMcpServerIds', 'mcpServers', 'serverIds']) {
    const value = entry[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.trim()) {
          refs.add(item.trim());
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
    const skill = skills.find(entry => isRecord(entry) && entry.name === skillName);
    assert.ok(skill, `Expected seeded plugin for ${skillName}`);

    const mcpServer = mcpServers.find(entry => isRecord(entry) && entry.name === skillName);
    const mcpServerId = isRecord(mcpServer) && typeof mcpServer.id === 'string' ? mcpServer.id : '';
    assert.ok(mcpServerId, `Expected MCP server seed for ${skillName}`);

    const refs = collectServerRefs(skill);
    assert.ok(refs.length > 0, `${skillName} should declare an MCP server reference in seed data`);
    assert.ok(
      refs.includes(mcpServerId),
      `${skillName} should reference canonical MCP server id "${mcpServerId}", got: ${refs.join(', ') || '(none)'}`
    );
  }
});
