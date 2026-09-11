import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGeminiSessionConfig,
  createVoiceSession,
  resolveVoiceModel,
  resolveVoiceProvider,
} from '../voice/providers.js';
import { VOICE_TOOLS } from '../voice/config.js';

test('resolves supported voice providers without sending other provider keys to OpenAI', () => {
  assert.equal(resolveVoiceProvider('openai'), 'openai');
  assert.equal(resolveVoiceProvider('google'), 'gemini');
  assert.equal(resolveVoiceProvider('gemini'), 'gemini');
  assert.throws(() => resolveVoiceProvider('anthropic'), /Unsupported/);
});
test('upgrades old OpenAI defaults but preserves explicit model selection', t => {
  const previous = process.env.OPENAI_REALTIME_MODEL;
  delete process.env.OPENAI_REALTIME_MODEL;
  t.after(() => {
    if (previous === undefined) delete process.env.OPENAI_REALTIME_MODEL;
    else process.env.OPENAI_REALTIME_MODEL = previous;
  });
  assert.equal(resolveVoiceModel('openai', 'gpt-realtime-1.5'), 'gpt-realtime-2');
  assert.equal(resolveVoiceModel('openai', 'gpt-realtime-mini'), 'gpt-realtime-mini');
});
test('Gemini exposes the same agent tools with native audio and both transcriptions', () => {
  const session = buildGeminiSessionConfig('Pilot the agents.', 'Kore');
  assert.deepEqual(session.responseModalities, ['AUDIO']);
  assert.equal(session.systemInstruction, 'Pilot the agents.');
  assert.deepEqual(session.inputAudioTranscription, {});
  assert.deepEqual(session.outputAudioTranscription, {});
  const tools = session.tools?.[0];
  assert.ok(tools && 'functionDeclarations' in tools);
  assert.deepEqual(
    tools.functionDeclarations?.map(tool => tool.name),
    VOICE_TOOLS.map(tool => tool.name)
  );
  assert.deepEqual(tools.functionDeclarations?.[0].parametersJsonSchema, VOICE_TOOLS[0].parameters);
});
test('OpenAI creates an ephemeral GA session and never returns the permanent key', async t => {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ value: 'ephemeral-token', expires_at: 123 }));
  });
  const result = await createVoiceSession({
    provider: 'openai',
    apiKey: 'permanent-test-key',
    instructions: 'Pilot.',
  });
  assert.match(requests[0].url, /realtime\/client_secrets$/);
  assert.equal(result.provider, 'openai');
  assert.equal(result.token, 'ephemeral-token');
  assert.equal(JSON.stringify(result).includes('permanent-test-key'), false);
  assert.equal('modalities' in requests[0].body, false);
});
test('provider failure does not expose response bodies or credentials', async t => {
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('sensitive-upstream-body', { status: 401 })
  );
  await assert.rejects(
    createVoiceSession({ provider: 'openai', apiKey: 'test', instructions: '' }),
    /OpenAI voice session failed \(401\)/
  );
});

test('Gemini uses one-use constrained tokens, preserving tool schemas and keeping its key server-side', async t => {
  let requestBody = '';
  let requestUrl = '';
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requestUrl = String(url);
    requestBody = String(init?.body);
    return new Response(JSON.stringify({ name: 'auth_tokens/test-session' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const result = await createVoiceSession({
    provider: 'google',
    model: 'gemini-3.1-flash-live-preview',
    apiKey: 'permanent-google-key',
    voice: 'alloy',
    instructions: 'Pilot.',
  });
  assert.match(requestUrl, /v1beta\/auth_tokens$/);
  const body = JSON.parse(requestBody);
  assert.equal(body.uses, 1);
  assert.ok(body.newSessionExpireTime);
  assert.ok(requestBody.includes('delegate'));
  assert.ok(requestBody.includes('gemini-3.1-flash-live-preview'));
  assert.equal(result.provider, 'gemini');
  assert.equal(result.voice, 'Kore');
  assert.equal(result.token, 'auth_tokens/test-session');
  assert.equal(JSON.stringify(result).includes('permanent-google-key'), false);
});
