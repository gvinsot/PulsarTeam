import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';

function createManager() {
  return new AgentManager(null, null, null, null);
}

test('returns last message by agent id', () => {
  const mgr = createManager();
  const created = mgr.create({
    name: 'Dev A',
    provider: 'openai',
    model: 'gpt-4o-mini',
    instructions: 'test'
  });

  const raw = mgr.agents.get(created.id);
  raw.conversationHistory.push(
    { role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00.000Z' },
    { role: 'assistant', content: 'hi', timestamp: '2026-01-01T00:00:01.000Z' },
    { role: 'user', content: 'status?', timestamp: '2026-01-01T00:00:02.000Z' }
  );

  const result = mgr.getLastMessages(created.id, 1);
  assert.ok(result);
  assert.equal(result.agentName, 'Dev A');
  assert.equal(result.returned, 1);
  assert.equal(result.messages[0].content, 'status?');
});

test('returns last N messages by agent name (case-insensitive)', () => {
  const mgr = createManager();
  const created = mgr.create({
    name: 'QA Bot',
    provider: 'openai',
    model: 'gpt-4o-mini',
    instructions: 'test'
  });

  const raw = mgr.agents.get(created.id);
  raw.conversationHistory.push(
    { role: 'user', content: 'm1' },
    { role: 'assistant', content: 'm2' },
    { role: 'user', content: 'm3' }
  );

  const result = mgr.getLastMessagesByName('qa bot', 2);
  assert.ok(result);
  assert.equal(result.returned, 2);
  assert.deepEqual(result.messages.map(m => m.content), ['m2', 'm3']);
});

test('clamps limit and handles unknown agent', () => {
  const mgr = createManager();
  assert.equal(mgr.getLastMessages('missing-id', 3), null);

  const created = mgr.create({
    name: 'Ops',
    provider: 'openai',
    model: 'gpt-4o-mini',
    instructions: 'test'
  });
  const raw = mgr.agents.get(created.id);
  raw.conversationHistory.push({ role: 'user', content: 'only' });

  const result = mgr.getLastMessages(created.id, 999);
  assert.equal(result.limit, 50);
  assert.equal(result.returned, 1);
});
