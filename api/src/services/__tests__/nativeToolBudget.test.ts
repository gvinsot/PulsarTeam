import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentManager } from '../agentManager.js';
import { chatMethods } from '../agentManager/chat.js';
import {
  interruptedWorkflowHistory,
  replayNativeToolHistory,
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
