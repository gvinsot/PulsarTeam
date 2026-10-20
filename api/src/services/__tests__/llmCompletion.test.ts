/**
 * The OpenAI-compatible completion (services/llmCompletion.ts): the agent is
 * asked to write its answer to a file, and that file is the completion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_ANSWER_DIR,
  LlmRequestError,
  buildAgentPrompt,
  chatCompletionBody,
  chatCompletionRequestSchema,
  runAgentCompletion,
  type CompletionRunner,
} from '../llmCompletion.js';

const AGENT = { id: 'agent-1', name: 'Dev', status: 'idle', enabled: true };

/** A runner whose agent "writes" `fileContent` to the path named in the prompt. */
function fakeRunner(opts: { fileContent?: string | null; reply?: unknown; fail?: Error } = {}) {
  const files = new Map<string, string>();
  const calls: { prompt: string; images: unknown }[] = [];
  const removed: string[] = [];
  const stream: string[] = [];
  const runner: CompletionRunner = {
    async sendMessage(_id, prompt, cb, _d, _m, images) {
      calls.push({ prompt, images });
      if (opts.fail) throw opts.fail;
      cb('Working…');
      const path = new RegExp('`(' + LLM_ANSWER_DIR + '/[^`]+)`').exec(prompt)![1];
      if (opts.fileContent != null) files.set(path, opts.fileContent);
      return opts.reply ?? 'Done.';
    },
    abortChatTurn() {
      return true;
    },
    beginStream: id => stream.push(`begin ${id}`),
    appendStreamChunk: (_id, chunk) => stream.push(`chunk ${chunk}`),
    endStream: () => stream.push('end'),
    errorStream: (_id, error) => stream.push(`error ${error}`),
    isTerminalDriven: () => false,
    startCliTurn: async () => {
      throw new Error('not a CLI agent');
    },
    isCliTurnActive: () => false,
    endCliTurn: () => {},
    _checkTerminalAuthError: async () => null,
    addActionLog: () => {},
    _isCliQuiet: async () => false,
    executionManager: {
      async readFile(_id, path) {
        if (!files.has(path)) throw new Error('No such file');
        return files.get(path)!;
      },
      async exec(_id, command) {
        removed.push(command);
        return { stdout: '', stderr: '' };
      },
    },
  };
  return { runner, calls, removed, stream };
}

test('the request schema accepts a classic OpenAI body and ignores sampling params', () => {
  const parsed = chatCompletionRequestSchema.safeParse({
    model: 'Dev',
    temperature: 0.2,
    max_tokens: 100,
    messages: [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
    ],
  });
  assert.ok(parsed.success);
  assert.equal(
    chatCompletionRequestSchema.safeParse({ model: 'Dev', messages: [] }).success,
    false
  );
  assert.equal(
    chatCompletionRequestSchema.safeParse({ messages: [{ role: 'user', content: 'x' }] }).success,
    false
  );
});

test('the prompt carries the system instructions, the request and the answer file', () => {
  const { prompt, images } = buildAgentPrompt(
    [
      { role: 'system', content: 'Answer in French.' },
      { role: 'user', content: 'What is 2+2?' },
    ],
    '/tmp/pulsar-llm-api/x.md'
  );
  assert.match(prompt, /Answer in French\./);
  assert.match(prompt, /Request:\nWhat is 2\+2\?/);
  assert.match(prompt, /`\/tmp\/pulsar-llm-api\/x\.md`/);
  assert.deepEqual(images, []);
});

test('a multi-turn conversation becomes a labelled transcript; inline images are passed', () => {
  const { prompt, images } = buildAgentPrompt(
    [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is on this picture?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: 'https://example.com/a.png' },
        ],
      },
    ],
    '/tmp/a.md'
  );
  assert.match(
    prompt,
    /### User\nHello\n\n### Assistant\nHi!\n\n### User\nWhat is on this picture\?/
  );
  assert.match(prompt, /\[image: https:\/\/example\.com\/a\.png\]/);
  assert.deepEqual(images, [{ mediaType: 'image/png', data: 'AAAA' }]);
});

test('the completion is the content of the answer file, which is then removed', async () => {
  const { runner, removed } = fakeRunner({ fileContent: '4\n\n', reply: 'I wrote the file.' });
  const result = await runAgentCompletion(runner, AGENT, [{ role: 'user', content: '2+2?' }]);
  assert.equal(result.content, '4');
  assert.equal(result.source, 'file');
  assert.equal(removed.length, 1);
  assert.match(removed[0], /^rm -f '\/tmp\/pulsar-llm-api\/[0-9a-f-]+\.md'$/);
});

test('without an answer file, the chat reply is returned (reasoning stripped)', async () => {
  const { runner } = fakeRunner({ fileContent: null, reply: '<think>hmm</think> 4' });
  const result = await runAgentCompletion(runner, AGENT, [{ role: 'user', content: '2+2?' }]);
  assert.deepEqual([result.content, result.source], ['4', 'reply']);
});

test('busy, disabled and failing agents answer OpenAI-shaped errors', async () => {
  const { runner, calls } = fakeRunner({ fileContent: 'x' });
  const msgs = [{ role: 'user' as const, content: 'x' }];

  await assert.rejects(runAgentCompletion(runner, { ...AGENT, status: 'busy' }, msgs), (e: any) => {
    assert.ok(e instanceof LlmRequestError);
    assert.equal(e.status, 409);
    assert.equal(e.toJSON().error.code, 'agent_busy');
    return true;
  });
  await assert.rejects(runAgentCompletion(runner, { ...AGENT, enabled: false }, msgs), /disabled/);
  assert.equal(calls.length, 0, 'no turn is started for a busy or disabled agent');

  const locked = fakeRunner({ fail: new Error('Agent is already processing a message') });
  await assert.rejects(
    runAgentCompletion(locked.runner, AGENT, msgs),
    (e: any) => e.status === 409
  );

  const broken = fakeRunner({ fail: new Error('LLM down') });
  await assert.rejects(
    runAgentCompletion(broken.runner, AGENT, msgs),
    (e: any) => e.status === 502
  );

  const empty = fakeRunner({ fileContent: null, reply: '' });
  await assert.rejects(runAgentCompletion(empty.runner, AGENT, msgs), /no answer/);
});

/**
 * A runner whose turn only ends when aborted, like a real sendMessage does on
 * abort. Its controller registers after `registerAfter` abort attempts.
 */
function hangingRunner(registerAfter = 0) {
  const { runner, removed } = fakeRunner({ fileContent: 'x' });
  const aborts: string[] = [];
  let attempts = 0;
  let endTurn: (err: Error) => void = () => {};
  runner.sendMessage = () =>
    new Promise((_resolve, reject) => {
      endTurn = reject;
    });
  runner.abortChatTurn = (id, reason) => {
    if (attempts++ < registerAfter) return false;
    aborts.push(`${id}: ${reason}`);
    endTurn(new Error('Agent stopped by user'));
    return true;
  };
  return { runner, removed, aborts, attempts: () => attempts };
}

const isClientClosed = (e: any) =>
  e instanceof LlmRequestError && e.toJSON().error.code === 'client_closed';

test('a client hanging up ends the agent turn and removes the answer file', async () => {
  const { runner, removed, aborts } = hangingRunner();
  const client = new AbortController();
  const pending = runAgentCompletion(runner, AGENT, [{ role: 'user', content: 'x' }], client.signal);
  client.abort();
  await assert.rejects(pending, isClientClosed);
  assert.deepEqual(aborts, ['agent-1: LLM API client disconnected']);
  assert.equal(removed.length, 1);
});

test('a hang-up before the turn has registered is retried until it can abort', async () => {
  const { runner, aborts, attempts } = hangingRunner(2);
  const client = new AbortController();
  const pending = runAgentCompletion(runner, AGENT, [{ role: 'user', content: 'x' }], client.signal);
  client.abort();
  await assert.rejects(pending, isClientClosed);
  assert.equal(attempts(), 3);
  assert.equal(aborts.length, 1);
});

test('a finished turn is never aborted, and a gone client starts no turn', async () => {
  const { runner, calls } = fakeRunner({ fileContent: '4' });
  let aborted = 0;
  runner.abortChatTurn = () => {
    aborted++;
    return true;
  };
  const client = new AbortController();
  const result = await runAgentCompletion(
    runner,
    AGENT,
    [{ role: 'user', content: 'x' }],
    client.signal
  );
  client.abort();
  assert.equal(result.content, '4');
  assert.equal(aborted, 0, 'the agent may be on other work by now');

  await assert.rejects(
    runAgentCompletion(runner, AGENT, [{ role: 'user', content: 'x' }], client.signal),
    isClientClosed
  );
  assert.equal(calls.length, 1);
});

test('the turn streams into the agent chat of the UI', async () => {
  const { runner, stream } = fakeRunner({ fileContent: '4' });
  await runAgentCompletion(runner, AGENT, [{ role: 'user', content: '2+2?' }]);
  assert.deepEqual(stream, ['begin agent-1', 'chunk Working…', 'end']);
});

test('a turn refused before running opens no stream — the running turn keeps its own', async () => {
  const { runner, stream } = fakeRunner({
    fail: new Error('Agent is already processing a message'),
  });
  await assert.rejects(runAgentCompletion(runner, AGENT, [{ role: 'user', content: 'x' }]));
  assert.deepEqual(stream, []);
});

/**
 * A CLI agent whose shared terminal "answers" by writing `answer` to the answer
 * file `writeAfter` polls after the prompt was pasted.
 */
function terminalRunner(
  opts: {
    answer?: string | null;
    writeAfter?: number;
    authError?: string | null;
    startError?: Error;
    /** The CLI sits quiet at its prompt (default: working). */
    quiet?: boolean;
  } = {}
) {
  const { runner, removed } = fakeRunner();
  const files = new Map<string, string>();
  const pasted: string[] = [];
  const ended: { interrupt: boolean }[] = [];
  const logs: string[] = [];
  let lock: string | null = null;
  let polls = 0;
  runner.sendMessage = async () => {
    throw new Error('a CLI agent must not take the chat path');
  };
  runner.isTerminalDriven = () => true;
  runner.startCliTurn = async (_id, prompt) => {
    if (opts.startError) throw opts.startError;
    lock = prompt;
    pasted.push(prompt);
  };
  runner.isCliTurnActive = (_id, prompt) => lock === prompt;
  runner.endCliTurn = (_id, prompt, o) => {
    if (lock !== prompt) return;
    lock = null;
    ended.push({ interrupt: !!o?.interrupt });
  };
  runner._checkTerminalAuthError = async () => opts.authError ?? null;
  runner._isCliQuiet = async () => !!opts.quiet;
  runner.addActionLog = (_id, type, message) => logs.push(`${type}: ${message}`);
  runner.executionManager!.readFile = async (_id, path) => {
    polls++;
    if (opts.answer != null && polls > (opts.writeAfter ?? 1)) files.set(path, opts.answer);
    if (!files.has(path)) throw new Error('No such file');
    return files.get(path)!;
  };
  return {
    runner,
    removed,
    pasted,
    ended,
    logs,
    stop: () => {
      lock = null;
    },
  };
}

const FAST = { pollMs: 5, timeoutMs: 2000 };
const ASK = [{ role: 'user' as const, content: '2+2?' }];

test('a CLI agent answers in its shared terminal, once the answer file stops changing', async () => {
  const t = terminalRunner({ answer: '4\n', writeAfter: 2 });
  const result = await runAgentCompletion(t.runner, AGENT, ASK, undefined, FAST);
  assert.deepEqual([result.content, result.source], ['4', 'file']);
  assert.equal(t.pasted.length, 1);
  assert.match(t.pasted[0], /Request:\n2\+2\?/);
  assert.deepEqual(t.ended, [{ interrupt: false }]);
  assert.equal(t.removed.length, 1);
});

test('a CLI gone quiet without the answer file has finished: 502, not interrupted', async () => {
  const t = terminalRunner({ answer: null, quiet: true });
  await assert.rejects(
    runAgentCompletion(t.runner, AGENT, ASK, undefined, { ...FAST, quietMs: 20 }),
    (e: any) => e.status === 502 && e.toJSON().error.code === 'no_answer_file'
  );
  assert.deepEqual(t.ended, [{ interrupt: false }]);
});

test('a CLI quiet on an authentication error waits for the login, noting it once', async () => {
  const t = terminalRunner({
    answer: '4',
    writeAfter: 12,
    authError: 'Please run /login',
    quiet: true,
  });
  const result = await runAgentCompletion(t.runner, AGENT, ASK, undefined, {
    ...FAST,
    quietMs: 20,
  });
  assert.equal(result.content, '4');
  assert.equal(t.logs.length, 1);
  assert.match(t.logs[0], /^warning: .*\/login/);
});

test('a client hanging up interrupts the terminal turn', async () => {
  const t = terminalRunner({ answer: null });
  const client = new AbortController();
  const pending = runAgentCompletion(t.runner, AGENT, ASK, client.signal, FAST);
  setTimeout(() => client.abort(), 20);
  await assert.rejects(pending, isClientClosed);
  assert.deepEqual(t.ended, [{ interrupt: true }]);
  assert.equal(t.removed.length, 1);
});

test('a Stop ends the terminal wait; a timeout interrupts the CLI', async () => {
  const stopped = terminalRunner({ answer: null });
  const pending = runAgentCompletion(stopped.runner, AGENT, ASK, undefined, FAST);
  setTimeout(stopped.stop, 20);
  await assert.rejects(pending, (e: any) => e.toJSON().error.code === 'agent_stopped');
  assert.deepEqual(stopped.ended, [], 'the turn no longer held the agent');

  const slow = terminalRunner({ answer: null });
  await assert.rejects(
    runAgentCompletion(slow.runner, AGENT, ASK, undefined, { pollMs: 5, timeoutMs: 30 }),
    (e: any) => e.status === 504
  );
  assert.deepEqual(slow.ended, [{ interrupt: true }]);
});

test('a CLI agent already at work answers 409; images keep the chat path', async () => {
  const busy = terminalRunner({
    startError: new Error('Agent is already processing a message (its terminal is active)'),
  });
  await assert.rejects(
    runAgentCompletion(busy.runner, AGENT, ASK, undefined, FAST),
    (e: any) => e.toJSON().error.code === 'agent_busy'
  );

  const withImage = terminalRunner();
  let chatTurns = 0;
  withImage.runner.sendMessage = async () => {
    chatTurns++;
    return 'A cat.';
  };
  const result = await runAgentCompletion(
    withImage.runner,
    AGENT,
    [
      {
        role: 'user',
        content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
      },
    ],
    undefined,
    FAST
  );
  assert.equal(chatTurns, 1);
  assert.equal(withImage.pasted.length, 0);
  assert.equal(result.content, 'A cat.');
});

test('the response is a chat.completion object', () => {
  const body = chatCompletionBody(
    'Dev',
    { content: 'Hello', source: 'file', promptTokens: 10 },
    'chatcmpl-1',
    123
  );
  assert.equal(body.object, 'chat.completion');
  assert.equal(body.choices[0].message.content, 'Hello');
  assert.equal(body.choices[0].finish_reason, 'stop');
  assert.equal(body.usage.total_tokens, 12);
});
