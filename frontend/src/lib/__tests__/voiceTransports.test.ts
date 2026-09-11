import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAiTransport } from '../voice/openai.ts';

let liveCallbacks;
let liveSession;
let deferLive;
mock.module('@google/genai', {
  namedExports: {
    GoogleGenAI: class {
      live = {
        connect: async ({ callbacks }) => {
          liveCallbacks = callbacks;
          if (deferLive) await deferLive;
          callbacks.onmessage({ setupComplete: {} });
          return liveSession;
        },
      };
    },
  },
});
const { createGeminiTransport } = await import('../voice/gemini.ts');

function globals(t, values) {
  for (const [key, value] of Object.entries(values)) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    t.after(() => {
      if (original) Object.defineProperty(globalThis, key, original);
      else delete globalThis[key];
    });
  }
}
function options() {
  const track = { enabled: true };
  return {
    stream: { getTracks: () => [track], getAudioTracks: () => [track] },
    audio: { muted: false, srcObject: null, pause: mock.fn(), play: async () => {} },
    onEvent: mock.fn(),
    onConnected: mock.fn(),
    onError: mock.fn(),
    onClose: mock.fn(),
  };
}
function rtc(t) {
  const channel = { readyState: 'open', send: mock.fn(), close: mock.fn() };
  const peer = {
    createDataChannel: () => channel,
    addTrack: mock.fn(),
    close: mock.fn(),
    createOffer: async () => ({ type: 'offer', sdp: 'offer-sdp' }),
    setLocalDescription: async () => {},
    setRemoteDescription: async () => channel.onopen(),
  };
  globals(t, {
    RTCPeerConnection: class {
      constructor() {
        return peer;
      }
    },
  });
  return { peer, channel };
}

test('OpenAI uses GA SDP with token configuration and forwards tool results', async t => {
  const { peer, channel } = rtc(t);
  const opt = options();
  const fetch = t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.body, 'offer-sdp');
    assert.equal(init.headers['Content-Type'], 'application/sdp');
    return new Response('answer-sdp');
  });
  const transport = createOpenAiTransport(
    { provider: 'openai', token: 'temporary', model: 'gpt-realtime-2' },
    opt
  );
  t.after(() => transport.close());
  await transport.connect();
  assert.equal(fetch.mock.callCount(), 1);
  assert.equal(opt.onConnected.mock.callCount(), 1);
  assert.equal(channel.send.mock.callCount(), 0); // No legacy session.update.
  channel.onmessage({
    data: JSON.stringify({ type: 'response.output_audio_transcript.delta', delta: 'Hi' }),
  });
  assert.equal(opt.onEvent.mock.calls[0].arguments[0].delta, 'Hi');
  transport.sendFunctionOutput('call-one', 'Done');
  assert.equal(JSON.parse(channel.send.mock.calls[0].arguments[0]).item.call_id, 'call-one');
  assert.equal(JSON.parse(channel.send.mock.calls[1].arguments[0]).type, 'response.create');
  transport.setMuted(true);
  assert.equal(opt.stream.getTracks()[0].enabled, false);
  transport.close();
  assert.equal(peer.close.mock.callCount(), 1);
  channel.onmessage({ data: '{}' });
  assert.equal(opt.onEvent.mock.callCount(), 1);
});
test('OpenAI releases resources when SDP exchange fails', async t => {
  const { peer, channel } = rtc(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  const transport = createOpenAiTransport({ token: 'temporary' }, options());
  await assert.rejects(transport.connect(), /401/);
  assert.equal(peer.close.mock.callCount(), 1);
  assert.equal(channel.close.mock.callCount(), 1);
});

test('OpenAI waits for the active response before requesting a reply to concurrent tool results', async t => {
  const { channel } = rtc(t);
  t.mock.method(globalThis, 'fetch', async () => new Response('answer-sdp'));
  const transport = createOpenAiTransport({ token: 'temporary' }, options());
  t.after(() => transport.close());
  await transport.connect();
  channel.onmessage({ data: JSON.stringify({ type: 'response.created' }) });
  transport.sendFunctionOutput('first', 'result-one');
  transport.sendFunctionOutput('second', 'result-two');
  assert.equal(channel.send.mock.callCount(), 2);
  channel.onmessage({ data: JSON.stringify({ type: 'response.done' }) });
  assert.equal(channel.send.mock.callCount(), 3);
  assert.equal(JSON.parse(channel.send.mock.calls[2].arguments[0]).type, 'response.create');
});

function audio(t) {
  const nodes = [];
  let worklet;
  const ctx = {
    currentTime: 0,
    destination: {},
    resume: async () => {},
    close: mock.fn(async () => {}),
    audioWorklet: { addModule: async () => {} },
    createGain: () => ({ gain: { value: 1 }, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createBuffer: (_channels, length, rate) => ({ duration: length / rate, copyToChannel() {} }),
    createBufferSource: () => {
      const node = {
        connect() {},
        disconnect() {},
        start: mock.fn(),
        stop: mock.fn(),
        onended: null,
      };
      nodes.push(node);
      return node;
    },
  };
  globals(t, {
    AudioContext: class {
      constructor() {
        return ctx;
      }
    },
    AudioWorkletNode: class {
      constructor() {
        worklet = { port: { close() {}, onmessage: null }, connect() {}, disconnect() {} };
        return worklet;
      }
    },
  });
  liveSession = { close: mock.fn(), sendToolResponse: mock.fn(), sendRealtimeInput: mock.fn() };
  deferLive = undefined;
  return { ctx, nodes, worklet: () => worklet };
}
const geminiConfig = {
  provider: 'gemini',
  model: 'gemini-3.1-flash-live-preview',
  token: 'auth_tokens/temp',
  session: {},
};

test('Gemini streams PCM, flushes mute, interrupts playback and correlates tool results', async t => {
  const env = audio(t);
  const opt = options();
  const transport = createGeminiTransport(geminiConfig, opt);
  t.after(() => transport.close());
  await transport.connect();
  assert.equal(opt.onConnected.mock.callCount(), 1);
  env.worklet().port.onmessage({ data: { pcm: new Int16Array([10, 20]).buffer } });
  assert.equal(
    liveSession.sendRealtimeInput.mock.calls[0].arguments[0].audio.mimeType,
    'audio/pcm;rate=16000'
  );
  transport.setMuted(true);
  assert.deepEqual(liveSession.sendRealtimeInput.mock.calls[1].arguments[0], {
    audioStreamEnd: true,
  });
  env.worklet().port.onmessage({ data: { pcm: new Int16Array([30]).buffer } });
  assert.equal(liveSession.sendRealtimeInput.mock.callCount(), 2);
  liveCallbacks.onmessage({
    serverContent: {
      outputTranscription: { text: 'Bonjour' },
      modelTurn: {
        parts: [{ inlineData: { data: 'AAAAAA==', mimeType: 'audio/pcm;rate=24000' } }],
      },
    },
  });
  assert.equal(env.nodes.length, 1);
  liveCallbacks.onmessage({ serverContent: { interrupted: true } });
  assert.equal(env.nodes[0].stop.mock.callCount(), 1);
  liveCallbacks.onmessage({
    toolCall: {
      functionCalls: [
        { id: 'one', name: 'list_agents', args: {} },
        { id: 'two', name: 'list_projects', args: {} },
      ],
    },
  });
  liveCallbacks.onmessage({ toolCallCancellation: { ids: ['one'] } });
  transport.sendFunctionOutput('one', 'ignored');
  transport.sendFunctionOutput('two', 'project-result');
  assert.equal(liveSession.sendToolResponse.mock.callCount(), 1);
  assert.deepEqual(liveSession.sendToolResponse.mock.calls[0].arguments[0].functionResponses[0], {
    id: 'two',
    name: 'list_projects',
    response: { result: 'project-result' },
  });
  transport.close();
  assert.equal(liveSession.close.mock.callCount(), 1);
  assert.equal(env.ctx.close.mock.callCount(), 1);
});
test('Gemini closes a late SDK connection after the user disconnected', async t => {
  const env = audio(t);
  let finish;
  deferLive = new Promise(resolve => {
    finish = resolve;
  });
  const opt = options();
  const transport = createGeminiTransport(geminiConfig, opt);
  const connecting = transport.connect();
  await new Promise(resolve => setImmediate(resolve));
  transport.close();
  await assert.rejects(connecting, /closed/);
  finish();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(opt.onConnected.mock.callCount(), 0);
  assert.equal(liveSession.close.mock.callCount(), 1);
  assert.equal(env.ctx.close.mock.callCount(), 1);
});
