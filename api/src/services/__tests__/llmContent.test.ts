import test from 'node:test';
import assert from 'node:assert/strict';

import { MistralProvider, OllamaProvider, OpenAIProvider, VLLMProvider } from '../llmProviders.js';

const messages = [{ role: 'user', content: 'Bonjour' }];
const toolCall = {
  id: 'call_1',
  type: 'function',
  function: { name: 'list_my_tasks', arguments: '{}' },
};
const expectedToolCalls = [{ id: 'call_1', name: 'list_my_tasks', arguments: {} }];
const usage = { prompt_tokens: 10, completion_tokens: 20 };

// Mistral's documented stream switches from thinking blocks, through a mixed
// closing-thinking/text delta, to plain strings for the rest of the answer.
// https://docs.mistral.ai/studio/conversations/reasoning#streaming
const streamChunks = [
  { choices: [{ delta: { role: 'assistant', content: null } }] },
  {
    choices: [
      { delta: { content: [{ type: 'thinking', thinking: [{ type: 'text', text: 'Je ' }] }] } },
    ],
  },
  {
    choices: [
      {
        delta: {
          content: [
            { type: 'thinking', thinking: [{ type: 'text', text: 'réfléchis.' }], closed: true },
            { type: 'text', text: 'Bon' },
            { type: 'text', text: 'jour' },
          ],
        },
      },
    ],
  },
  { choices: [{ delta: { content: ' !' } }] },
  { choices: [{ delta: { reasoning_content: [{ type: 'text', text: ' Vérification.' }] } }] },
  { choices: [{ delta: { reasoning: ' Prêt.' } }] },
  {
    choices: [
      {
        delta: {
          content: [
            null,
            42,
            {},
            { type: 'text', text: { unexpected: true } },
            { type: 'image_url', image_url: { url: 'image' } },
            { type: 'reference', text: 'metadata', reference_ids: [1] },
            { type: 'thinking', thinking: [], signature: 'signature', closed: true },
          ],
        },
      },
    ],
  },
  {
    choices: [{ delta: { tool_calls: [{ index: 0, ...toolCall }] }, finish_reason: 'tool_calls' }],
  },
  { choices: [], usage },
];

const expectedEvents = [
  { type: 'thinking', text: 'Je ' },
  { type: 'thinking', text: 'réfléchis.' },
  { type: 'text', text: 'Bon' },
  { type: 'text', text: 'jour' },
  { type: 'text', text: ' !' },
  { type: 'thinking', text: ' Vérification.' },
  { type: 'thinking', text: ' Prêt.' },
  { type: 'tool_calls', toolCalls: expectedToolCalls },
  { type: 'done', finishReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 20 } },
];

const providers = [
  () => new MistralProvider('test-key', 'mistral-large-4'),
  () => new VLLMProvider('http://vllm.local', 'test-model', 'test-key'),
  () => new OpenAIProvider('test-key', 'gpt-4o'),
  () => new OllamaProvider('http://ollama.local', 'test-model'),
];

for (const createProvider of providers) {
  const name = createProvider().constructor.name;

  test(`${name} streams structured content as text and separate thinking`, async t => {
    const provider = createProvider();
    if (provider instanceof OllamaProvider) {
      t.mock.method(
        globalThis,
        'fetch',
        async () =>
          new Response(
            streamChunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') +
              'data: [DONE]\n\n'
          )
      );
    } else {
      t.mock.method(provider.client.chat.completions, 'create', async function* () {
        yield* streamChunks;
      });
    }

    const events = [];
    let answer = '';
    let thinking = '';
    for await (const event of provider.chatStream(messages)) {
      events.push(event);
      // Exercise the same accumulation contract used by the sandbox chat.
      if (event.type === 'text') answer += event.text;
      if (event.type === 'thinking') thinking += event.text;
    }

    assert.deepEqual(events, expectedEvents);
    assert.equal(answer, 'Bonjour !');
    assert.equal(thinking, 'Je réfléchis. Vérification. Prêt.');
  });

  test(`${name} returns plain answer text from non-streamed structured content`, async t => {
    const provider = createProvider();
    const cases: [unknown, string][] = [
      ['Bonjour !', 'Bonjour !'],
      [
        [
          { type: 'thinking', thinking: [{ type: 'text', text: 'Je réfléchis.' }] },
          { type: 'text', text: 'Bonjour' },
          { type: 'reference', reference_ids: [1] },
          { type: 'text', text: ' !' },
        ],
        'Bonjour !',
      ],
      [{ type: 'text', text: 'Bonjour' }, 'Bonjour'],
      [null, ''],
      [[], ''],
      [[null, {}, { type: 'text', text: {} }], ''],
      [[{ type: 'thinking', thinking: [{ type: 'text', text: 'Thinking only' }] }], ''],
    ];

    for (const [content, expected] of cases) {
      const response = { choices: [{ message: { content, tool_calls: [toolCall] } }], usage };
      const stub =
        provider instanceof OllamaProvider
          ? t.mock.method(globalThis, 'fetch', async () => Response.json(response))
          : t.mock.method(provider.client.chat.completions, 'create', async () => response);
      try {
        const result = await provider.chat(messages);
        assert.equal(result.content, expected);
        assert.deepEqual(result.toolCalls, expectedToolCalls);
        assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 });
      } finally {
        stub.mock.restore();
      }
    }
  });
}
