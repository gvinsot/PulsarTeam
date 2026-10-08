import test, { mock } from 'node:test';
import assert from 'node:assert/strict';

let fail = false;
let stored = '';
mock.module('../database/connection.js', {
  namedExports: {
    getPool: () => ({
      query: async (_sql: string, values: unknown[]) => {
        if (fail) throw new Error('database unavailable');
        stored = String(values[1]);
      },
    }),
  },
});
const { serializeAgentData, saveAgent } = await import('../database/agents.js');

test('agent JSONB encoding handles actual NUL and lone surrogates, preserving literal escapes and Unicode', () => {
  const agent = {
    id: 'agent',
    conversationHistory: [
      {
        nativeToolTrace: [
          {
            result: {
              content: "source.replace(/\\*\\*/g, '\0') é 🔐 \ud800 end \udc00",
              literal: String.raw`\u0000 \ud800 C:\new\test`,
              ['key\0']: 'value',
            },
          },
        ],
      },
    ],
    projectContexts: { other: { content: 'a\0b' } },
  };
  const before = structuredClone(agent);
  const loaded = JSON.parse(serializeAgentData(agent));
  assert.equal(
    loaded.conversationHistory[0].nativeToolTrace[0].result.content,
    "source.replace(/\\*\\*/g, '�') é 🔐 � end �"
  );
  assert.equal(
    loaded.conversationHistory[0].nativeToolTrace[0].result.literal,
    String.raw`\u0000 \ud800 C:\new\test`
  );
  assert.equal(loaded.conversationHistory[0].nativeToolTrace[0].result['key�'], 'value');
  assert.equal(loaded.projectContexts.other.content, 'a�b');
  assert.deepEqual(agent, before, 'encoding must not mutate tool results used in memory');
});

test('save failure is observable, cleared by a successful save and never persisted', async () => {
  const agent: { id: string; persistenceError?: string } = { id: 'agent' };
  fail = true;
  assert.equal(await saveAgent(agent), false);
  assert.match(agent.persistenceError || '', /Échec de sauvegarde/);
  fail = false;
  assert.equal(await saveAgent(agent), true);
  assert.equal(agent.persistenceError, undefined);
  assert.equal(JSON.parse(stored).persistenceError, undefined);
});
