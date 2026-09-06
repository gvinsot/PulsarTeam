import test from 'node:test';
import assert from 'node:assert/strict';

import { NATIVE_TOOL_DEFINITIONS, toExecutionToolCall } from '../nativeTools.js';
import { ClaudeProvider, VLLMProvider } from '../llmProviders.js';

function mockProviderCreate(provider: VLLMProvider, create: (params: any) => any): void {
  (provider as any).client = { chat: { completions: { create } } };
}

function asyncChunks(chunks: any[]): AsyncIterable<any> {
  return (async function* () {
    for (const chunk of chunks) yield chunk;
  })();
}

test('VLLMProvider sends native schemas and preserves a non-streamed tool call', async () => {
  const provider = new VLLMProvider('http://vllm.local', 'Qwen3.6-27B', '');
  let capturedParams: any = null;
  mockProviderCreate(provider, async params => {
    capturedParams = params;
    return {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'call_tasks',
                type: 'function',
                function: { name: 'list_my_tasks', arguments: '{}' },
              },
            ],
          },
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    };
  });

  const result = await provider.chat([{ role: 'user', content: 'list tasks' }], {
    tools: NATIVE_TOOL_DEFINITIONS,
  });

  assert.equal(capturedParams.tool_choice, 'auto');
  assert.equal(capturedParams.tools, NATIVE_TOOL_DEFINITIONS);
  assert.equal(result.content, '');
  assert.deepEqual(result.toolCalls, [{ id: 'call_tasks', name: 'list_my_tasks', arguments: {} }]);
});

test('VLLMProvider streams Qwen reasoning and structured tool calls', async () => {
  const provider = new VLLMProvider('http://vllm.local', 'Qwen3.6-27B', '');
  let capturedParams: any = null;
  mockProviderCreate(provider, params => {
    capturedParams = params;
    return asyncChunks([
      { choices: [{ delta: { reasoning: 'thinking...' } }] },
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: 'call_1', type: 'function', function: { name: 'update_task' } },
              ],
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
                  function: {
                    arguments: '{"task_id":"abc-123","status":"done","comment":"Moved"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      { choices: [], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } },
    ]);
  });

  const chunks = [];
  for await (const chunk of provider.chatStream([{ role: 'user', content: 'move task' }], {
    tools: NATIVE_TOOL_DEFINITIONS,
  })) {
    chunks.push(chunk);
  }

  assert.equal(capturedParams.tool_choice, 'auto');
  assert.equal(capturedParams.tools, NATIVE_TOOL_DEFINITIONS);
  assert.deepEqual(chunks[0], { type: 'thinking', text: 'thinking...' });
  assert.deepEqual(chunks[1], {
    type: 'tool_calls',
    toolCalls: [
      {
        id: 'call_1',
        name: 'update_task',
        arguments: { task_id: 'abc-123', status: 'done', comment: 'Moved' },
      },
    ],
  });
  assert.deepEqual(chunks[2], {
    type: 'done',
    finishReason: 'tool_calls',
    usage: { inputTokens: 4, outputTokens: 5 },
  });
});

test('native arguments stay structured through the executor contract', () => {
  assert.deepEqual(
    toExecutionToolCall({
      id: 'call_mcp',
      name: 'mcp_call',
      arguments: {
        server: 'Swarm API',
        tool: 'get_agent_tasks',
        arguments: { agent_name: 'Test' },
      },
    }),
    {
      id: 'call_mcp',
      tool: 'mcp_call',
      args: ['Swarm API', 'get_agent_tasks'],
      nativeArguments: {
        server: 'Swarm API',
        tool: 'get_agent_tasks',
        arguments: { agent_name: 'Test' },
      },
    }
  );
});

test('ClaudeProvider drops the empty assistant turn a tool-only round leaves behind', () => {
  const provider = new ClaudeProvider('key', 'claude-sonnet-4-20250514');

  const mapped = (provider as any)._mapMessages([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'update the task' },
    // A previous turn that only called tools: no prose was streamed, and the
    // history keeps no toolCalls — replaying it verbatim 400s the API.
    { role: 'assistant', content: '' },
    { role: 'user', content: 'and now?' },
  ]);

  assert.deepEqual(
    mapped.map((m: any) => m.role),
    ['user', 'user']
  );
  assert.ok(mapped.every((m: any) => m.content));
});

test('ClaudeProvider keeps a tool-only assistant turn that still carries tool_use', () => {
  const provider = new ClaudeProvider('key', 'claude-sonnet-4-20250514');

  const mapped = (provider as any)._mapMessages([
    { role: 'user', content: 'read it' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }],
    },
    { role: 'tool', toolCallId: 'call_1', content: '{"success":true}' },
  ]);

  assert.deepEqual(mapped[1], {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }],
  });
  assert.equal(mapped[2].content[0].type, 'tool_result');
});
