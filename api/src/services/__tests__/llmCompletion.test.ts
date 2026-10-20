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
  const runner: CompletionRunner = {
    async sendMessage(_id, prompt, _cb, _d, _m, images) {
      calls.push({ prompt, images });
      if (opts.fail) throw opts.fail;
      const path = new RegExp('`(' + LLM_ANSWER_DIR + '/[^`]+)`').exec(prompt)![1];
      if (opts.fileContent != null) files.set(path, opts.fileContent);
      return opts.reply ?? 'Done.';
    },
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
  return { runner, calls, removed };
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
