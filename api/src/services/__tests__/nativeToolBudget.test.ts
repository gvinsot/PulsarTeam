import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';
import { chatMethods } from '../agentManager/chat.js';
import {
  capToolResultContent,
  interruptedWorkflowHistory,
  replayNativeToolHistory,
  toolResultMaxChars,
  ToolBudgetReachedError,
} from '../agentManager/nativeToolHistory.js';
import { serializeAgentData } from '../database/agents.js';

function response(text = '', toolCalls: any[] = []) {
  return {
    fullResponse: text,
    toolCalls,
    thinkingBuffer: '',
    finishReason: 'stop',
    outputTokens: 1,
    durationMs: 1,
  };
}

async function setup() {
  const manager = new AgentManager(
    { emit() {}, to: () => ({ emit() {} }) },
    null,
    null,
    null
  ) as any;
  const created = await manager.create({ name: 'Security', runner: 'sandbox' });
  const agent = manager.agents.get(created.id);
  manager._buildSystemPrompt = async () => 'Perform the requested audit.';
  manager.resolveLlmConfig = () => ({ provider: 'mistral', model: 'test', contextLength: 131072 });
  const calls: any[] = [];
  let actions = 0;
  manager._processPostResponseActions = async () => {
    actions++;
    return { earlyReturn: null };
  };
  manager._processToolCalls = async (_id: string, tools: any[]) => {
    calls.push(...tools);
    return tools.map(tool => ({
      toolCallId: tool.id,
      success: true,
      result: `checked ${tool.arguments.path}`,
    }));
  };
  return { manager, agent, calls, actions: () => actions };
}

test('40 tool rounds conclude without tools and resume with durable results, not repeated execution', async () => {
  const { manager, agent, calls, actions } = await setup();
  const prompts: any[] = [];
  manager._streamAndContinue = async (
    _a: any,
    _id: string,
    messages: any[],
    _config: any,
    stream: any,
    _abort: any,
    _task: any,
    options: any
  ) => {
    prompts.push(structuredClone(messages));
    if (options?.toolsEnabled === false) {
      assert.equal(options.maxTokens, 4096);
      stream('Checked forty files; authentication review remains.');
      // Even malformed legacy action text must not execute in the final summary.
      return response('Checked forty files; authentication review remains. {"tool":"update_task"}');
    }
    return response('', [
      {
        id: `read_${calls.length}`,
        name: 'read_file',
        arguments: { path: `file-${calls.length}.ts` },
      },
    ]);
  };
  const streamed: string[] = [];
  const result = await manager.sendMessage(agent.id, 'Audit the project', (s: string) =>
    streamed.push(s)
  );
  assert.equal(calls.length, 40);
  assert.equal(prompts.length, 41);
  assert.ok(
    prompts.some(p => p.some((m: any) => m.content?.includes('Only 5 tool rounds remain')))
  );
  assert.match(result, /Limite atteinte/);
  assert.match(streamed.join(''), /authentication review remains/);
  assert.equal(actions(), 0);
  assert.equal(agent.status, 'idle');
  assert.equal(manager._chatLocks.size, 0);

  // Simulate database persistence + reload before the user's continuation.
  const reloaded = JSON.parse(serializeAgentData(agent));
  manager.agents.set(agent.id, reloaded);
  assert.equal(reloaded.conversationHistory.at(-1).interruption, 'tool-budget');
  manager._streamAndContinue = async (_a: any, _id: string, messages: any[]) => {
    assert.equal(messages.filter(m => m.role === 'tool').length, 40);
    assert.ok(messages.some(m => m.content?.includes('checked file-39.ts')));
    return response('Audit complete.');
  };
  assert.equal(await manager.sendMessage(agent.id, 'Continue', () => {}), 'Audit complete.');
  assert.equal(calls.length, 40, 'replaying prior tool results must never execute calls');
  assert.equal(reloaded.conversationHistory.at(-1).interruption, undefined);
});

test('a failed final summary still persists a resumable turn and flags workflows incomplete', async () => {
  const { manager, agent, calls } = await setup();
  manager._streamAndContinue = async (
    _a: any,
    _id: string,
    _m: any,
    _c: any,
    _s: any,
    _abort: any,
    _task: any,
    options: any
  ) => {
    if (options?.toolsEnabled === false) throw new Error('upstream disconnected');
    return response('', [
      { id: `read_${calls.length}`, name: 'read_file', arguments: { path: 'a.ts' } },
    ]);
  };
  await assert.rejects(
    manager.sendMessage(agent.id, 'Audit', () => {}, 0, {
      type: 'workflow-action',
      taskId: 'task-a',
      mode: 'decide',
      currentStatus: 'qa',
    }),
    ToolBudgetReachedError
  );
  const last = agent.conversationHistory.at(-1);
  assert.match(last.content, /synthèse n’a pas pu/);
  assert.equal(last.nativeToolTrace.length, 40);
  assert.equal(last.taskId, 'task-a');
  assert.equal(agent.status, 'idle');
  assert.equal(manager.abortControllers.size, 0);
  manager._streamAndContinue = async (_a: any, _id: string, messages: any[]) => {
    assert.equal(messages.filter(m => m.role === 'tool').length, 40);
    return response('Review finished.');
  };
  assert.equal(
    await manager.sendMessage(agent.id, 'Audit', () => {}, 0, {
      type: 'workflow-action',
      taskId: 'task-a',
      mode: 'decide',
      currentStatus: 'qa',
    }),
    'Review finished.'
  );
});

test('an empty final summary leaves a visible fallback and a resumable trace', async () => {
  const { manager, agent, calls } = await setup();
  manager._streamAndContinue = async (
    _a: any,
    _id: string,
    _m: any,
    _c: any,
    _s: any,
    _abort: any,
    _task: any,
    options: any
  ) => {
    if (options?.toolsEnabled === false) return response('');
    return response('', [
      { id: `read_${calls.length}`, name: 'read_file', arguments: { path: 'a.ts' } },
    ]);
  };
  const result = await manager.sendMessage(agent.id, 'Audit', () => {});
  assert.match(result, /synthèse n’a pas pu/);
  assert.equal(agent.conversationHistory.at(-1).nativeToolTrace.length, 40);
  assert.equal(agent.conversationHistory.at(-1).interruption, 'tool-budget');
});

test('terminal completion before the limit remains successful without forced summary', async () => {
  const { manager, agent, actions } = await setup();
  manager._streamAndContinue = async () =>
    response('Finished', [{ id: 'done', name: 'update_task', arguments: {} }]);
  manager._processToolCalls = async () => [
    { toolCallId: 'done', success: true, isTerminal: true, result: 'done' },
  ];
  assert.equal(await manager.sendMessage(agent.id, 'Audit', () => {}), 'Finished');
  assert.equal(agent.conversationHistory.at(-1).interruption, undefined);
  assert.equal(actions(), 1);
});

test('tool-free summary continuations never re-enable schemas', async () => {
  const { manager, agent } = await setup();
  const contexts: any[] = [];
  manager._consumeStream = async (_provider: any, _messages: any[], context: any) => {
    contexts.push(context);
    return {
      text: 'summary',
      thinking: '',
      toolCalls: [],
      outputTokens: 1,
      finishReason: contexts.length === 1 ? 'length' : 'stop',
    };
  };
  await chatMethods._streamAndContinue.call(
    manager,
    agent,
    agent.id,
    [{ role: 'user', content: 'summarize' }],
    { provider: 'vllm', endpoint: 'http://unused', model: 'test', maxTokens: 128000 },
    () => {},
    new AbortController(),
    null,
    { toolsEnabled: false, maxTokens: 4096 }
  );
  assert.equal(contexts.length, 2);
  assert.ok(contexts.every(c => c.tools.length === 0 && c.maxTokens <= 4096));
});

test('workflow replay is scoped to the interrupted task, mode and column', () => {
  const scope = { taskId: 'a', mode: 'decide', currentStatus: 'qa' };
  const entry = {
    role: 'assistant',
    taskId: 'a',
    workflowMode: 'decide',
    workflowStatus: 'qa',
    interruption: 'tool-budget',
    content: 'first progress',
  };
  const history = [entry, { ...entry, taskId: 'b' }, { ...entry, content: 'second progress' }];
  assert.deepEqual(
    interruptedWorkflowHistory(history, scope).map(m => m.content),
    ['first progress', 'second progress']
  );
  assert.deepEqual(interruptedWorkflowHistory(history, { ...scope, currentStatus: 'done' }), []);
  assert.deepEqual(interruptedWorkflowHistory(history, { ...scope, mode: 'refine' }), []);
  assert.deepEqual(
    interruptedWorkflowHistory([...history, { ...entry, interruption: undefined }], scope),
    []
  );
});

test('history replay pairs every call and result, preserving falsy results and original history', () => {
  const history = [
    {
      role: 'assistant',
      content: 'progress',
      nativeToolTrace: [
        {
          id: 'one',
          name: 'read_file',
          arguments: { path: 'a.ts' },
          result: { success: true, result: false },
        },
        {
          id: 'two',
          name: 'run_command',
          arguments: {},
          result: { success: false, error: 'blocked' },
        },
      ],
    },
  ];
  const before = structuredClone(history);
  const replay = replayNativeToolHistory(history);
  assert.deepEqual(
    replay.map(m => m.role),
    ['assistant', 'tool', 'assistant', 'tool', 'assistant']
  );
  assert.equal(JSON.parse(String(replay[1].content)).result, false);
  assert.equal(replay[3].toolError, true);
  replay[4].content = 'truncated';
  assert.deepEqual(history, before);
});

test('an oversized tool result keeps its head and tail within the per-result budget', () => {
  const max = toolResultMaxChars(131072);
  assert.equal(max, Math.floor(131072 * 0.12 * 3));
  assert.ok(toolResultMaxChars(131072, 10) < max, 'a round of many results shares a budget');
  assert.equal(toolResultMaxChars(0), max, 'unset context falls back to the default window');

  const big = 'H'.repeat(300_000) + 'T'.repeat(300_000);
  const capped = capToolResultContent(big, max);
  assert.ok(capped.length <= max);
  assert.ok(capped.startsWith('HHH') && capped.endsWith('TTT'));
  assert.match(capped, /tool output truncated: 600000 chars/);
  assert.equal(capToolResultContent('small', max), 'small');
});

test('a huge tool result is bounded before it reaches the model, and replay is bounded too', async () => {
  const { manager, agent } = await setup();
  manager._processToolCalls = async (_id: string, tools: any[]) =>
    tools.map(tool => ({ toolCallId: tool.id, success: true, result: 'x'.repeat(600_000) }));
  const prompts: any[] = [];
  manager._streamAndContinue = async (_a: any, _id: string, messages: any[]) => {
    prompts.push(structuredClone(messages));
    return prompts.length === 1
      ? response('', [{ id: 'logs', name: 'run_command', arguments: { command: 'cat big.log' } }])
      : response('Logs checked.');
  };
  assert.equal(await manager.sendMessage(agent.id, 'Check logs', () => {}), 'Logs checked.');
  const toolMessage = prompts[1].find((m: any) => m.role === 'tool');
  assert.ok(toolMessage.content.length <= toolResultMaxChars(131072));
  assert.match(toolMessage.content, /tool output truncated/);

  // The durable trace still holds the full result; its replay must not.
  manager._streamAndContinue = async (_a: any, _id: string, messages: any[]) => {
    const replayed = messages.find((m: any) => m.role === 'tool');
    assert.ok(replayed.content.length <= toolResultMaxChars(131072));
    return response('Next.');
  };
  assert.equal(await manager.sendMessage(agent.id, 'Next', () => {}), 'Next.');
});

function streamContext(manager: any, results: any[]) {
  const calls: any[] = [];
  manager._consumeStream = async (_provider: any, messages: any[], context: any) => {
    calls.push({ messages: structuredClone(messages), context });
    return results[calls.length - 1];
  };
  return calls;
}

function streamResult(text: string, finishReason: string, thinking = '') {
  return { text, thinking, toolCalls: [], outputTokens: 1, finishReason };
}

const vllmConfig = {
  provider: 'vllm',
  endpoint: 'http://unused',
  model: 'test',
  maxTokens: 128000,
  contextLength: 131072,
};

test('a continuation after a reasoning-only cut never sends an empty assistant message', async () => {
  const { manager, agent } = await setup();
  const calls = streamContext(manager, [
    streamResult('', 'length', 'long reasoning'),
    streamResult('answer', 'stop'),
  ]);
  const messages = [{ role: 'user', content: 'decide' }];
  const out = await chatMethods._streamAndContinue.call(
    manager,
    agent,
    agent.id,
    messages,
    vllmConfig,
    () => {},
    new AbortController()
  );
  assert.equal(out.fullResponse, 'answer');
  const sent = calls[1].messages;
  assert.ok(!sent.some((m: any) => m.role === 'assistant' && !m.content));
  assert.match(sent.at(-1).content, /before you wrote any answer/);
  assert.deepEqual(messages, [{ role: 'user', content: 'decide' }], 'continuation prompts removed');
});

test('an over-full context is truncated to leave a usable output budget', async () => {
  const { manager, agent } = await setup();
  const calls = streamContext(manager, [streamResult('ok', 'stop')]);
  const messages = [
    { role: 'system', content: 'sys' },
    { role: 'tool', content: 'x'.repeat(540_000) },
  ];
  await chatMethods._streamAndContinue.call(
    manager,
    agent,
    agent.id,
    messages,
    vllmConfig,
    () => {},
    new AbortController()
  );
  // ~8192, less the few tokens of the "[truncated …]" notice.
  assert.ok(calls[0].context.maxTokens >= 8000, `maxTokens=${calls[0].context.maxTokens}`);
});

test('a length stop at the output floor is reported as a context error, not continued', async () => {
  const { manager, agent } = await setup();
  const calls = streamContext(manager, [streamResult('', 'length', 'thinking')]);
  manager._truncateMessagesToFit = () => false; // nothing left to truncate
  await assert.rejects(
    chatMethods._streamAndContinue.call(
      manager,
      agent,
      agent.id,
      [{ role: 'user', content: 'x'.repeat(400_000) }],
      vllmConfig,
      () => {},
      new AbortController()
    ),
    (err: any) => manager._isContextExceededError(err.message)
  );
  assert.equal(calls.length, 1);
});

test('a bodyless 4xx near the window is classified as a context error', async () => {
  const { manager } = await setup();
  const bare: any = Object.assign(new Error('400 status code (no body)'), { status: 400 });
  const near = manager._classifyLlmRequestError(bare, 117000, 1024, 131072);
  assert.ok(manager._isContextExceededError(near.message));
  assert.equal(near.status, 400);
  const far = manager._classifyLlmRequestError(bare, 2000, 4096, 131072);
  assert.ok(!manager._isContextExceededError(far.message));
  assert.match(far.message, /~2000 input \+ 4096 output tokens/);
  const auth: any = Object.assign(new Error('401'), { status: 401 });
  assert.equal(manager._classifyLlmRequestError(auth, 117000, 1024, 131072), auth);
});

test('a context error after tool execution compacts and retries a workflow action once', async () => {
  const { manager, agent, calls } = await setup();
  let compactions = 0;
  manager._compactHistory = async () => {
    compactions++;
  };
  let turns = 0;
  manager._streamAndContinue = async () => {
    turns++;
    if (turns === 1)
      return response('', [{ id: `r${turns}`, name: 'read_file', arguments: { path: 'a' } }]);
    if (turns === 2) throw new Error('LLM request rejected, context window likely exceeded');
    return response('Verified.');
  };
  const meta = { type: 'workflow-action', taskId: 't', mode: 'decide', currentStatus: 'verify' };
  assert.equal(await manager.sendMessage(agent.id, 'Verify', () => {}, 0, meta), 'Verified.');
  assert.equal(compactions, 1);
  assert.equal(calls.length, 1);
  assert.equal(agent._compactionRetried, undefined);
});

test('a rejected request after tool execution fails once, without blind retries', async () => {
  const { manager, agent } = await setup();
  let turns = 0;
  manager._streamAndContinue = async () => {
    turns++;
    if (turns === 1)
      return response('', [{ id: 'r', name: 'read_file', arguments: { path: 'a' } }]);
    throw Object.assign(new Error('LLM request rejected — HTTP 422'), { status: 422 });
  };
  await assert.rejects(
    manager.sendMessage(agent.id, 'Verify', () => {}),
    /HTTP 422/
  );
  assert.equal(turns, 2);
  assert.equal(agent.status, 'error');
});
