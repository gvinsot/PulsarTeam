import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';

test('getLastMessages returns newest messages with original indexes', async () => {
  const io = { emit() {} };
  const manager = new AgentManager(io, null, null, null);
  const created = await manager.create({ name: 'Tester', role: 'developer' });
  const raw = manager.agents.get(created.id);

  raw.conversationHistory = [
    { role: 'user', content: 'one' },
    { role: 'assistant', content: 'two' },
    { role: 'user', content: 'three' },
  ];

  const result = manager.getLastMessages(created.id, 2);

  assert.equal(result.totalMessages, 3);
  assert.equal(result.returned, 2);
  assert.deepEqual(result.messages.map((m) => m.content), ['two', 'three']);
  assert.deepEqual(result.messages.map((m) => m.index), [1, 2]);
});

test('getLastMessagesByName is case-insensitive and clamps invalid limit', async () => {
  const io = { emit() {} };
  const manager = new AgentManager(io, null, null, null);
  const created = await manager.create({ name: 'Reviewer', role: 'reviewer' });
  const raw = manager.agents.get(created.id);

  raw.conversationHistory = [
    { role: 'user', content: 'alpha' },
    { role: 'assistant', content: 'beta' },
  ];

  const result = manager.getLastMessagesByName('reviewer', 0);
  assert.equal(result.agentName, 'Reviewer');
  assert.equal(result.limit, 1);
  assert.deepEqual(result.messages.map((m) => m.content), ['beta']);
});