/**
 * The OpenAI-compatible completion (services/llmCompletion.ts): a CLI agent
 * answers in its shared terminal through submit_answer; on the chat path the
 * agent writes its answer to a file, and that file is the completion.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LLM_ANSWER_DIR,
  LlmRequestError,
  buildAgentPrompt,
  chatCompletionBody,
  chatCompletionRequestSchema,
  checkJsonOutput,
  parseResponseFormat,
  runAgentCompletion,
  type CompletionRunner,
  type JsonOutputFormat,
} from '../llmCompletion.js';
import { closeLlmAnswer, openLlmAnswer, submitLlmAnswer } from '../llmAnswers.js';

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
    { file: '/tmp/pulsar-llm-api/x.out' }
  );
  assert.match(prompt, /Answer in French\./);
  assert.match(prompt, /Request:\nWhat is 2\+2\?/);
  assert.match(prompt, /`\/tmp\/pulsar-llm-api\/x\.out`/);
  assert.match(prompt, /exactly the format the request asks for/);
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
    { file: '/tmp/a.out' }
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
  assert.match(removed[0], /^rm -f '\/tmp\/pulsar-llm-api\/[0-9a-f-]+\.out'$/);
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
  const pending = runAgentCompletion(
    runner,
    AGENT,
    [{ role: 'user', content: 'x' }],
    client.signal
  );
  client.abort();
  await assert.rejects(pending, isClientClosed);
  assert.deepEqual(aborts, ['agent-1: LLM API client disconnected']);
  assert.equal(removed.length, 1);
});

test('a hang-up before the turn has registered is retried until it can abort', async () => {
  const { runner, aborts, attempts } = hangingRunner(2);
  const client = new AbortController();
  const pending = runAgentCompletion(
    runner,
    AGENT,
    [{ role: 'user', content: 'x' }],
    client.signal
  );
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
 * A CLI agent whose shared terminal "answers" by calling submit_answer with
 * `answer`, `writeAfter` polls after the prompt was pasted.
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
  // Polled once per wait iteration: the CLI "works", then submits.
  runner.isCliTurnActive = (_id, prompt) => {
    polls++;
    if (opts.answer != null && polls === (opts.writeAfter ?? 1) + 1) {
      const requestId = /request_id "([0-9a-f-]+)"/.exec(prompt)![1];
      assert.equal(submitLlmAnswer(requestId, AGENT.id, opts.answer), 'accepted');
    }
    return lock === prompt;
  };
  runner.endCliTurn = (_id, prompt, o) => {
    if (lock !== prompt) return;
    lock = null;
    ended.push({ interrupt: !!o?.interrupt });
  };
  runner._checkTerminalAuthError = async () => opts.authError ?? null;
  runner._isCliQuiet = async () => !!opts.quiet;
  runner.addActionLog = (_id, type, message) => logs.push(`${type}: ${message}`);
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

test('a CLI agent answers in its shared terminal by calling submit_answer', async () => {
  const t = terminalRunner({ answer: '4\n', writeAfter: 2 });
  const result = await runAgentCompletion(t.runner, AGENT, ASK, undefined, FAST);
  assert.deepEqual([result.content, result.source], ['4', 'tool']);
  assert.equal(t.pasted.length, 1);
  assert.match(t.pasted[0], /Request:\n2\+2\?/);
  assert.match(t.pasted[0], /`submit_answer` tool of the Pulsar Gateway/);
  assert.match(t.pasted[0], /`~\/pulsar-llm-api\/[0-9a-f-]+\.out`/, 'answer file out of the repo');
  assert.doesNotMatch(t.pasted[0], /\/tmp\//);
  assert.deepEqual(t.ended, [{ interrupt: false }]);
});

test('submit_answer takes only the pending request of the agent it was sent to', () => {
  const id = openLlmAnswer('agent-1');
  assert.equal(submitLlmAnswer(id, 'agent-2', 'x'), 'not_yours');
  assert.equal(submitLlmAnswer('nope', 'agent-1', 'x'), 'unknown');
  assert.equal(submitLlmAnswer(id, 'agent-1', 'x'), 'accepted');
  closeLlmAnswer(id);
  assert.equal(submitLlmAnswer(id, 'agent-1', 'y'), 'unknown', 'closed once the wait ended');
});

test('a CLI gone quiet without submitting has finished: 502, not interrupted', async () => {
  const t = terminalRunner({ answer: null, quiet: true });
  await assert.rejects(
    runAgentCompletion(t.runner, AGENT, ASK, undefined, { ...FAST, quietMs: 20 }),
    (e: any) => e.status === 502 && e.toJSON().error.code === 'no_answer'
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

// ── response_format ─────────────────────────────────────────────────────────

const FR_ASK = [
  { role: 'system' as const, content: 'Answer in French.' },
  { role: 'user' as const, content: 'What is 2+2?' },
];

/** The prompt as it was before response_format was read — byte for byte. */
const FREE_FORM_FILE_PROMPT = [
  'You are answering a request received through the OpenAI-compatible API of PulsarTeam.',
  '',
  'Instructions from the caller:',
  'Answer in French.',
  '',
  'Request:',
  'What is 2+2?',
  '',
  'IMPORTANT — how to deliver your answer:',
  'Write your complete final answer, and nothing else, to the file `/tmp/pulsar-llm-api/x.out` (create the parent directory if needed; overwrite the file if it exists).',
  'The content of that file is returned verbatim to the caller as the assistant message: no preamble, no notes about the file, no commentary about your process.',
  'Give it in exactly the format the request asks for (plain text, Markdown, JSON, TOML, code…): when a raw format is asked for, give it raw — no Markdown code fence around it.',
  'Do not commit that file. Once it is written, reply briefly that you are done.',
].join('\n');

const FREE_FORM_TOOL_PROMPT = [
  'You are answering a request received through the OpenAI-compatible API of PulsarTeam.',
  '',
  'Instructions from the caller:',
  'Answer in French.',
  '',
  'Request:',
  'What is 2+2?',
  '',
  'IMPORTANT — how to deliver your answer:',
  '1. Write your complete final answer, and nothing else, to the file `~/pulsar-llm-api/req-1.out` (create the parent directory if needed).',
  '2. Call the `submit_answer` tool of the Pulsar Gateway MCP with request_id "req-1" and that file as `file_path`.',
  'The content of that file is returned verbatim to the caller as the assistant message: no preamble, no commentary about your process.',
  'Give it in exactly the format the request asks for (plain text, Markdown, JSON, TOML, code…): when a raw format is asked for, give it raw — no Markdown code fence around it.',
  'Calling submit_answer is what completes the request — without it the caller gets no answer. If it reports an error, fix it and call it again. Then reply briefly that you are done.',
].join('\n');

test('without a JSON response_format the prompt is byte-for-byte the free-form one', () => {
  for (const raw of [
    undefined,
    null,
    'json',
    { type: 'text' },
    { type: 'xml' },
    { type: 'json_schema_v2', json_schema: 5 },
  ]) {
    const format = parseResponseFormat(raw);
    assert.equal(format, null, `${JSON.stringify(raw)} is free-form`);
    assert.equal(
      buildAgentPrompt(FR_ASK, { file: '/tmp/pulsar-llm-api/x.out' }, format).prompt,
      FREE_FORM_FILE_PROMPT
    );
    assert.equal(
      buildAgentPrompt(FR_ASK, { requestId: 'req-1' }, format).prompt,
      FREE_FORM_TOOL_PROMPT
    );
  }
  assert.equal(
    buildAgentPrompt(FR_ASK, { file: '/tmp/pulsar-llm-api/x.out' }).prompt,
    FREE_FORM_FILE_PROMPT
  );
  assert.equal(buildAgentPrompt(FR_ASK, { requestId: 'req-1' }).prompt, FREE_FORM_TOOL_PROMPT);
});

test('the request schema lets any response_format through — unknown ones are ignored', () => {
  for (const response_format of [
    null,
    'json',
    { type: 'xml' },
    { type: 'json_schema', json_schema: 5 },
  ]) {
    const parsed = chatCompletionRequestSchema.safeParse({
      model: 'Dev',
      messages: ASK,
      response_format,
    });
    assert.ok(parsed.success, JSON.stringify(response_format));
  }
});

const N_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: ['n'],
  properties: { n: { type: 'number' } },
  additionalProperties: false,
};

function jsonSchemaFormat(strict: boolean): JsonOutputFormat {
  const format = parseResponseFormat({
    type: 'json_schema',
    json_schema: { name: 'n', schema: N_SCHEMA, strict },
  });
  assert.ok(format);
  return format;
}

test('response_format json_object / json_schema are parsed; a schema that does not compile is a 400', () => {
  assert.deepEqual(parseResponseFormat({ type: 'json_object' }), {
    schema: null,
    strict: false,
    validate: null,
  });
  const noSchema = parseResponseFormat({ type: 'json_schema', json_schema: { name: 'x' } });
  assert.equal(noSchema?.schema, null, 'a json_schema without schema is a json_object');

  const format = jsonSchemaFormat(true);
  assert.equal(format.strict, true);
  assert.equal(format.schema, N_SCHEMA, 'the schema quoted to the agent is the caller’s');
  assert.ok(format.validate);
  assert.equal(N_SCHEMA.$schema, 'http://json-schema.org/draft-07/schema#', 'not mutated');

  assert.throws(
    () => parseResponseFormat({ type: 'json_schema', json_schema: { schema: { type: 'nope' } } }),
    (e: unknown) =>
      e instanceof LlmRequestError &&
      e.status === 400 &&
      e.toJSON().error.code === 'invalid_request'
  );
  assert.throws(
    () => parseResponseFormat({ type: 'json_schema', json_schema: { schema: 'object' } }),
    (e: unknown) => e instanceof LlmRequestError && e.status === 400
  );
});

test('a JSON response_format adds its rule (and schema) to both delivery modes', () => {
  const format = jsonSchemaFormat(true);
  const schemaRule =
    'Your final answer is ONLY a JSON document conforming to the following JSON schema, with no text before or after it and no Markdown code block around it:\n' +
    JSON.stringify(N_SCHEMA);
  for (const delivery of [{ file: '/tmp/pulsar-llm-api/x.out' }, { requestId: 'req-1' }]) {
    const { prompt } = buildAgentPrompt(FR_ASK, delivery, format);
    assert.ok(prompt.includes(`no Markdown code fence around it.\n${schemaRule}\n`), prompt);
  }
  const { prompt } = buildAgentPrompt(
    FR_ASK,
    { requestId: 'req-1' },
    parseResponseFormat({ type: 'json_object' })
  );
  assert.ok(
    prompt.includes(
      'no Markdown code fence around it.\nYour final answer is ONLY a JSON object, with no text before or after it and no Markdown code block around it.\nCalling submit_answer'
    )
  );
});

test('a JSON answer is cleaned of its code fence, parsed and validated', () => {
  const format = jsonSchemaFormat(true);
  assert.deepEqual(checkJsonOutput('```json\n{"n": 4}\n```\n', format), {
    text: '{"n": 4}',
    error: null,
    offSchema: false,
  });
  const jsonObject = parseResponseFormat({ type: 'json_object' });
  assert.ok(jsonObject);
  assert.equal(checkJsonOutput('```\n[1, 2]\n```', jsonObject).text, '[1, 2]');
  for (const notObject of ['[1, 2]', '"text"', '4', 'null']) {
    assert.deepEqual(
      checkJsonOutput(notObject, jsonObject),
      { text: notObject, error: 'it is not a JSON object', offSchema: false },
      `json_object: ${notObject} is refused`
    );
  }
  assert.equal(checkJsonOutput('{"a": [1]}', jsonObject).error, null);
  const notJson = checkJsonOutput('Here it is: {"n": 4}', format);
  assert.match(notJson.error || '', /not valid JSON/);
  assert.equal(notJson.offSchema, false);
  const offSchema = checkJsonOutput('{"n": "four"}', format);
  assert.match(offSchema.error || '', /does not conform to the JSON schema: \/n must be number/);
  assert.equal(offSchema.offSchema, true);
});

test('the code fence is stripped in linear time, whatever the answer', () => {
  const format = parseResponseFormat({ type: 'json_object' });
  assert.ok(format);
  assert.equal(checkJsonOutput('```json {"a": 1}```', format).text, '{"a": 1}');
  assert.equal(checkJsonOutput('``` \n{"a": 1}\n \t```', format).text, '{"a": 1}');
  assert.equal(checkJsonOutput('`````', format).text, '`````');
  const started = Date.now();
  for (const hostile of [
    '```' + ' '.repeat(200_000) + 'x',
    '```\n' + ' '.repeat(200_000) + 'x',
    '```' + ' \t'.repeat(100_000) + '\n```x',
  ]) {
    assert.match(checkJsonOutput(hostile, format).error || '', /not valid JSON/);
  }
  assert.ok(Date.now() - started < 1000, `took ${Date.now() - started} ms`);
});

test('a caller schema costs a bounded time: size cap, $async refused, slow patterns cut short', () => {
  const isBadSchema = (e: unknown) =>
    e instanceof LlmRequestError && e.status === 400 && e.code === 'invalid_request';
  const big = { type: 'object', description: 'x'.repeat(70_000) };
  assert.throws(
    () => parseResponseFormat({ type: 'json_schema', json_schema: { schema: big } }),
    (e: unknown) => isBadSchema(e) && /longer than 64000 characters/.test((e as Error).message)
  );
  assert.throws(
    () =>
      parseResponseFormat({
        type: 'json_schema',
        json_schema: { schema: { $async: true, type: 'string' } },
      }),
    (e: unknown) => isBadSchema(e) && /\$async/.test((e as Error).message)
  );

  // Exponential backtracking: ~minutes unbounded, cut at the validation limit.
  const format = parseResponseFormat({
    type: 'json_schema',
    json_schema: { schema: { type: 'string', pattern: '^(a+)+$' }, strict: true },
  });
  assert.ok(format);
  const started = Date.now();
  const check = checkJsonOutput(JSON.stringify('a'.repeat(40) + '!'), format);
  assert.ok(Date.now() - started < 2000, `took ${Date.now() - started} ms`);
  assert.equal(check.offSchema, true);
  assert.match(check.error || '', /could not be checked against the JSON schema within 250 ms/);
  // The same pattern on a well-behaved answer is checked as usual.
  assert.equal(checkJsonOutput('"aaa"', format).error, null);
  assert.match(checkJsonOutput('"ab"', format).error || '', /must match pattern/);
});

/** A chat agent whose successive turns write `answers` to their answer files. */
function chatSequence(answers: string[]) {
  const { runner } = fakeRunner();
  const prompts: string[] = [];
  const files = new Map<string, string>();
  runner.sendMessage = async (_id, prompt) => {
    prompts.push(prompt);
    const path = new RegExp('`(' + LLM_ANSWER_DIR + '/[^`]+)`').exec(prompt)?.[1] ?? '';
    files.set(path, answers[prompts.length - 1] ?? '');
    return 'Done.';
  };
  runner.executionManager = {
    async readFile(_id, path) {
      const content = files.get(path);
      if (content === undefined) throw new Error('No such file');
      return content;
    },
    async exec() {
      return { stdout: '', stderr: '' };
    },
  };
  return { runner, prompts };
}

const isInvalidJson = (e: unknown) =>
  e instanceof LlmRequestError &&
  e.status === 502 &&
  e.toJSON().error.code === 'invalid_json_output';

test('chat path: a valid JSON answer takes one turn and is returned clean', async () => {
  const { runner, prompts } = chatSequence(['```json\n{"n": 4}\n```']);
  const result = await runAgentCompletion(runner, AGENT, ASK, undefined, {
    responseFormat: jsonSchemaFormat(true),
  });
  assert.equal(result.content, '{"n": 4}');
  assert.equal(prompts.length, 1);
});

test('chat path: a wrong answer gets one correction turn quoting the error', async () => {
  const { runner, prompts } = chatSequence(['{"n": "four"}', '{"n": 4}']);
  const result = await runAgentCompletion(runner, AGENT, ASK, undefined, {
    responseFormat: jsonSchemaFormat(true),
  });
  assert.equal(result.content, '{"n": 4}');
  assert.equal(prompts.length, 2);
  assert.match(
    prompts[1],
    /was rejected: it does not conform to the JSON schema: \/n must be number/
  );
  assert.match(prompts[1], /Your final answer is ONLY a JSON document conforming/);
  const files = prompts.map(p => new RegExp('`(' + LLM_ANSWER_DIR + '/[^`]+)`').exec(p)?.[1]);
  assert.notEqual(files[0], files[1], 'a new answer file');
});

test('chat path: still wrong after the correction → 502 invalid_json_output', async () => {
  const { runner, prompts } = chatSequence(['not json', 'still not json']);
  await assert.rejects(
    runAgentCompletion(runner, AGENT, ASK, undefined, {
      responseFormat: parseResponseFormat({ type: 'json_object' }),
    }),
    isInvalidJson
  );
  assert.equal(prompts.length, 2, 'one correction only');

  const strict = chatSequence(['{"n": "four"}', '{"n": "4"}']);
  await assert.rejects(
    runAgentCompletion(strict.runner, AGENT, ASK, undefined, {
      responseFormat: jsonSchemaFormat(true),
    }),
    isInvalidJson
  );
});

test('a correction turn that fails leaves the first answer standing', async () => {
  for (const [strict, first] of [
    [false, '{"n": "four"}'],
    [true, '{"n": "four"}'],
  ] as const) {
    const { runner, prompts } = chatSequence([first]);
    const send = runner.sendMessage;
    runner.sendMessage = async (...args) => {
      if (prompts.length === 1) {
        prompts.push(args[1]);
        throw new Error('Agent is already processing a message');
      }
      return send(...args);
    };
    const run = runAgentCompletion(runner, AGENT, ASK, undefined, {
      responseFormat: jsonSchemaFormat(strict),
    });
    if (strict) await assert.rejects(run, isInvalidJson, 'strict: 502, not the 409');
    else assert.equal((await run).content, first, 'non-strict: the first answer');
    assert.equal(prompts.length, 2);
  }
  // A hang-up during the correction is still the hang-up.
  const controller = new AbortController();
  const { runner, prompts } = chatSequence(['{"n": "four"}']);
  const send = runner.sendMessage;
  runner.sendMessage = async (...args) => {
    if (prompts.length === 1) {
      prompts.push(args[1]);
      controller.abort();
      throw new Error('aborted');
    }
    return send(...args);
  };
  await assert.rejects(
    runAgentCompletion(runner, AGENT, ASK, controller.signal, {
      responseFormat: jsonSchemaFormat(false),
    }),
    (e: unknown) => e instanceof LlmRequestError && e.code === 'client_closed'
  );
});

test('onTurnSettled fires once the chat turn settles, before the answer file is read', async () => {
  const events: string[] = [];
  const { runner } = fakeRunner({ fileContent: 'Answer' });
  const exec = runner.executionManager;
  assert.ok(exec);
  const read = exec.readFile;
  exec.readFile = async (id, path) => {
    events.push('read');
    return read(id, path);
  };
  const send = runner.sendMessage;
  runner.sendMessage = async (...args) => {
    const reply = await send(...args);
    events.push('sent');
    return reply;
  };
  const result = await runAgentCompletion(runner, AGENT, ASK, undefined, {
    onTurnSettled: () => events.push('settled'),
  });
  assert.equal(result.content, 'Answer');
  assert.deepEqual(events, ['sent', 'settled', 'read']);
});

test('a non-strict schema only steers: JSON off the schema is returned', async () => {
  const { runner, prompts } = chatSequence(['{"n": "four"}', '{"n": "4"}']);
  const result = await runAgentCompletion(runner, AGENT, ASK, undefined, {
    responseFormat: jsonSchemaFormat(false),
  });
  assert.equal(prompts.length, 2, 'the agent is still asked to correct it');
  assert.equal(result.content, '{"n": "4"}');
});

test('terminal path: the correction is a new terminal turn with a new request id', async () => {
  const answers = ['{"n": "four"}', '{"n": 4}'];
  const t = terminalRunner();
  const start = t.runner.startCliTurn;
  let refused = 0;
  t.runner.startCliTurn = async (id, prompt, label) => {
    // Busy a moment after the first turn, until its idle timer fires.
    if (t.pasted.length === 1 && refused < 2) {
      refused++;
      throw new Error('Agent is already processing a message (its terminal is active)');
    }
    return start(id, prompt, label);
  };
  t.runner.isCliTurnActive = (_id, prompt) => {
    const requestId = /request_id "([0-9a-f-]+)"/.exec(prompt)?.[1] ?? '';
    submitLlmAnswer(requestId, AGENT.id, answers[t.pasted.length - 1]);
    return true;
  };
  const result = await runAgentCompletion(t.runner, AGENT, ASK, undefined, {
    ...FAST,
    responseFormat: jsonSchemaFormat(true),
  });
  assert.deepEqual([result.content, result.source], ['{"n": 4}', 'tool']);
  assert.equal(refused, 2, 'waited for the agent to be free again');
  assert.equal(t.pasted.length, 2);
  const ids = t.pasted.map(p => /request_id "([0-9a-f-]+)"/.exec(p)?.[1]);
  assert.notEqual(ids[0], ids[1]);
  assert.match(t.pasted[1], /was rejected: it does not conform to the JSON schema/);
  assert.deepEqual(t.ended, [{ interrupt: false }, { interrupt: false }]);
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
