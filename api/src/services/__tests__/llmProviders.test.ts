import test from 'node:test';
import assert from 'node:assert/strict';

import { parseToolCalls } from '../agentTools.js';
import { VLLMProvider } from '../llmProviders.js';

function mockProviderCreate(provider: VLLMProvider, create: (params: any) => any): void {
  (provider as any).client = {
    chat: {
      completions: { create },
    },
  };
}

function asyncChunks(chunks: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

test('VLLMProvider asks vLLM for plain text instead of native tool calls', async () => {
  const provider = new VLLMProvider('http://vllm.local', 'Qwen3.6-27B', '');
  let capturedParams: any = null;
  mockProviderCreate(provider, async params => {
    capturedParams = params;
    return {
      choices: [{ message: { content: '@list_my_tasks()' } }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
  });

  const result = await provider.chat([{ role: 'user', content: 'list tasks' }]);

  assert.equal(capturedParams.tool_choice, 'none');
  assert.equal(result.content, '@list_my_tasks()');
});

test('VLLMProvider streams Qwen reasoning deltas and keeps text output', async () => {
  const provider = new VLLMProvider('http://vllm.local', 'Qwen3.6-27B', '');
  let capturedParams: any = null;
  mockProviderCreate(provider, params => {
    capturedParams = params;
    return asyncChunks([
      { choices: [{ delta: { reasoning: 'thinking...' } }] },
      { choices: [{ delta: { content: '@list_my_tasks()' }, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
    ]);
  });

  const chunks = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'list tasks' }])) {
    chunks.push(chunk);
  }

  assert.equal(capturedParams.tool_choice, 'none');
  assert.deepEqual(chunks[0], { type: 'thinking', text: 'thinking...' });
  assert.deepEqual(chunks[1], { type: 'text', text: '@list_my_tasks()' });
  assert.deepEqual(chunks[2], {
    type: 'done',
    finishReason: 'stop',
    usage: { inputTokens: 4, outputTokens: 5 },
  });
});

test('OpenAI-compatible native tool_calls are converted to Pulsar tool text', async () => {
  const provider = new VLLMProvider('http://vllm.local', 'Qwen3.6-27B', '');
  mockProviderCreate(provider, () =>
    asyncChunks([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'update_task' },
                },
              ],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"task_id":"abc-123"' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: ',"status":"done","comment":"Moved"}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 8, completion_tokens: 13, total_tokens: 21 } },
    ])
  );

  let toolText = '';
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'move task' }])) {
    if (chunk.type === 'text') toolText += chunk.text;
  }

  const calls = parseToolCalls(toolText);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'update_task');
  assert.deepEqual(calls[0].args, ['abc-123', 'done', 'Moved', '']);
});
