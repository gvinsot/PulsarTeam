import { AgentManager } from '../agentManager.js';

function createManager() {
  return new AgentManager(null, null, null, null);
}

describe('AgentManager last messages tool API', () => {
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
    expect(result).toBeTruthy();
    expect(result.agentName).toBe('Dev A');
    expect(result.returned).toBe(1);
    expect(result.messages[0].content).toBe('status?');
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
    expect(result).toBeTruthy();
    expect(result.returned).toBe(2);
    expect(result.messages.map(m => m.content)).toEqual(['m2', 'm3']);
  });

  test('clamps limit and handles unknown agent', () => {
    const mgr = createManager();
    expect(mgr.getLastMessages('missing-id', 3)).toBeNull();

    const created = mgr.create({
      name: 'Ops',
      provider: 'openai',
      model: 'gpt-4o-mini',
      instructions: 'test'
    });
    const raw = mgr.agents.get(created.id);
    raw.conversationHistory.push({ role: 'user', content: 'only' });

    const result = mgr.getLastMessages(created.id, 999);
    expect(result.limit).toBe(50);
    expect(result.returned).toBe(1);
  });
});