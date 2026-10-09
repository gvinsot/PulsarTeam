import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSchema, updateAgentSchema } from '../../schemas/agents.js';

test('create and update discard the removed root permission, preserving other permissions', () => {
  const permissions = {
    linuxUser: { runAsRoot: true },
    network: { internetAccess: true },
    execution: { shellAccess: true, dangerousSkipPermissions: true },
  };
  const expected = {
    network: permissions.network,
    execution: permissions.execution,
  };
  const created = createAgentSchema.parse({
    name: 'Agent',
    boardId: '266e192c-c110-4762-bf36-89ad1e46c1d2',
    permissions,
  });
  assert.deepEqual(created.permissions, expected);
  assert.deepEqual(updateAgentSchema.parse({ permissions }).permissions, expected);
});
