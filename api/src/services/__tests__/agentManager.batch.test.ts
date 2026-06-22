import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';

const io = { emit() {}, to() { return { emit() {} }; } };

test('convertToBatch keeps the original agent as member #1 and creates configured clones', async () => {
  const manager = new AgentManager(io, null, null, null) as any;
  const created = await manager.create({
    name: 'Builder',
    role: 'developer',
    description: 'Writes code',
    instructions: 'Build carefully.',
    project: 'acme/app',
    boardId: '11111111-1111-4111-8111-111111111111',
    ownerId: '22222222-2222-4222-8222-222222222222',
    skills: ['skill-review'],
    mcpServers: ['github'],
    mcpAuth: { github: { apiKey: 'secret' } },
    credentials: { GITHUB_TOKEN: 'token' },
    permissions: { execution: { shellAccess: true } },
    toolHooks: { enabled: true, rules: [] },
    runner: 'codex',
    color: '#123456',
    icon: 'B',
  });

  const original = manager.agents.get(created.id);
  original.conversationHistory = [{ role: 'user', content: 'hello' }];
  manager._tasks.set(created.id, [{ id: 'task-1', text: 'Ship it' }]);

  const batch = await manager.convertToBatch(created.id, 3);

  assert.equal(batch.length, 3);
  assert.equal(batch[0].id, created.id);
  assert.equal(batch[0].name, 'Builder #1');
  assert.equal(batch[1].name, 'Builder #2');
  assert.equal(batch[2].name, 'Builder #3');
  assert.equal(batch[0].batchId, batch[1].batchId);
  assert.equal(batch[1].batchId, batch[2].batchId);
  assert.deepEqual(batch.map((agent: any) => agent.batchIndex), [1, 2, 3]);

  const clone = manager.agents.get(batch[1].id);
  assert.equal(clone.role, 'developer');
  assert.equal(clone.project, 'acme/app');
  assert.deepEqual(clone.skills, ['skill-review']);
  assert.deepEqual(clone.mcpAuth, { github: { apiKey: 'secret' } });
  assert.deepEqual(clone.credentials, { GITHUB_TOKEN: 'token' });
  assert.deepEqual(clone.permissions, { execution: { shellAccess: true } });
  assert.deepEqual(clone.toolHooks, { enabled: true, rules: [] });
  assert.equal(clone.conversationHistory.length, 0);
  assert.deepEqual(manager._tasks.get(batch[1].id), []);
  assert.deepEqual(manager._tasks.get(created.id), [{ id: 'task-1', text: 'Ship it' }]);
});

test('convertToBatch rejects voice agents', async () => {
  const manager = new AgentManager(io, null, null, null) as any;
  const created = await manager.create({ name: 'Voice', isVoice: true });

  await assert.rejects(
    () => manager.convertToBatch(created.id, 2),
    /Voice agents cannot be converted to a batch/
  );
});
