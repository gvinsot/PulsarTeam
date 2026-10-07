import test from 'node:test';
import assert from 'node:assert/strict';
import { chatMethods } from '../agentManager/chat.js';

function harness(rounds: any[][], terminal = false, runner = 'sandbox') {
  const agent: any = {
    id: 'sandbox-history-test',
    name: 'Sandbox',
    runner,
    conversationHistory: [],
    metrics: { totalMessages: 0, totalTokensIn: 0, totalTokensOut: 0 },
  };
  const manager: any = {
    ...chatMethods,
    agents: new Map([[agent.id, agent]]),
    abortControllers: new Map(),
    _chatLocks: new Map(),
    setStatus: (_id: string, status: string) => {
      agent.status = status;
    },
    _emit() {},
    resolveLlmConfig: () => ({}),
    _buildSystemPrompt: async () => 'Test system prompt',
    _assembleMessages: async () => ({ managesContext: false, isTaskExecution: false }),
    _cleanMarkdown: (text: string) => text,
    _parseRateLimitReset: () => null,
    async _streamAndContinue(
      _agent: any,
      id: string,
      messages: any[],
      llmConfig: any,
      streamCallback: any,
      abortController: AbortController
    ) {
      const chunks = rounds.shift();
      assert.ok(chunks, 'unexpected extra LLM call');
      const provider = {
        async *chatStream() {
          yield* chunks;
        },
      };
      const result = await this._consumeStream(provider, messages, {
        agent,
        id,
        useCliRunner: runner !== 'sandbox',
        streamCallback,
        abortController,
        contextTokens: 0,
        activeTaskId: null,
        sessionKey: '_default',
        maxTokens: 1000,
        llmConfig,
        isContinuation: false,
        tools: [],
      });
      return {
        ...result,
        fullResponse: result.text,
        thinkingBuffer: result.thinking,
        durationMs: 1,
      };
    },
    async _processToolCalls(_id: string, calls: any[], callback: any) {
      callback?.('\n✓ read_file\n');
      return calls.map(call => ({
        toolCallId: call.id,
        success: true,
        result: 'file contents',
        isTerminal: terminal,
      }));
    },
  };
  return { agent, manager };
}

const toolCalls = {
  type: 'tool_calls',
  toolCalls: [{ id: 'read-1', name: 'read_file', arguments: { path: 'README.md' } }],
};

test('sandbox history retains all streamed prose, tool progress and reasoning across rounds', async () => {
  const { manager, agent } = harness([
    [
      { type: 'thinking', text: 'Inspecting the files.\n' },
      { type: 'text', text: 'Let me check.\n' },
      toolCalls,
    ],
    [
      { type: 'thinking', text: 'The file confirms it.' },
      { type: 'text', text: 'Here is the answer.' },
    ],
  ]);
  let displayed = '';
  const response = await manager.sendMessage(agent.id, 'Check the file', (text: string) => {
    displayed += text;
  });
  // JSON round-trip represents persisted history reloaded by a new client.
  const entry = JSON.parse(JSON.stringify(agent.conversationHistory.at(-1)));
  assert.equal(response, 'Let me check.\nHere is the answer.');
  assert.equal(entry.content, response);
  assert.equal(entry.displayContent, displayed);
  assert.match(entry.displayContent, /✓ read_file/);
  assert.equal(entry.thinking, 'Inspecting the files.\nThe file confirms it.');
  assert.equal(entry.nativeToolTrace.length, 1);
});

test('tool-only sandbox turns retain their visible output even without a stream subscriber', async () => {
  const { manager, agent } = harness([
    [{ type: 'thinking', text: 'Checking the file.' }, toolCalls],
    [],
  ]);
  await manager.sendMessage(agent.id, 'Check the file', null);
  const entry = agent.conversationHistory.at(-1);
  assert.equal(entry.content, '(used tools: read_file)');
  assert.equal(entry.displayContent, '\n✓ read_file\n');
  assert.equal(entry.thinking, 'Checking the file.');
});

test('terminal tool turns preserve the preceding output without another model call', async () => {
  const { manager, agent } = harness(
    [[{ type: 'thinking', text: 'Work complete.' }, toolCalls]],
    true
  );
  await manager.sendMessage(agent.id, 'Finish', null);
  assert.equal(agent.conversationHistory.at(-1).thinking, 'Work complete.');
  assert.equal(agent.conversationHistory.at(-1).displayContent, '\n✓ read_file\n');
});

test('CLI terminal activity is not copied into sandbox history fields', async () => {
  const { manager, agent } = harness(
    [
      [
        { type: 'thinking', text: 'CLI activity' },
        { type: 'text', text: 'CLI answer' },
      ],
    ],
    false,
    'codex'
  );
  await manager.sendMessage(agent.id, 'Hello', null);
  const entry = agent.conversationHistory.at(-1);
  assert.equal(entry.content, 'CLI answer');
  assert.equal(entry.displayContent, undefined);
  assert.equal(entry.thinking, undefined);
});
