/**
 * External-voice WebSocket proxy + the /config route that points at it.
 *
 * What is actually being defended here:
 *   1. `/api/external-voice/config/:agentId` must hand out same-origin PATHS
 *      and no credential in any form — that was the leak the proxy exists for.
 *   2. The upgrade must run the same guard chain as the HTTP route. Nothing
 *      else will catch a missing one: routeInventory.test.ts enumerates Express
 *      routes and is blind to WebSocket upgrades.
 *   3. The bridge must carry BINARY frames both ways. A text-only bridge
 *      connects, looks healthy, and transports no audio whatsoever.
 *   4. Neither socket may outlive the other, and an upstream that never opens
 *      must reach the browser as an explicit close rather than silence.
 *
 * The upstream provider is a local `WebSocketServer` that echoes what it is
 * sent, so the whole path (browser → api → provider → api → browser) is
 * exercised for real, frame flags included.
 */
import test, { mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server as HttpServer } from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import jwt from 'jsonwebtoken';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';
import type { EventEmitter } from 'node:events';

process.env.JWT_SECRET = 'test-secret';
process.env.CORS_ORIGINS = 'http://localhost:5173';

// ── Fixtures the mocked modules serve ───────────────────────────────────────

interface FakeAgent {
  id: string;
  name: string;
  ownerId: string | null;
  boardId: string | null;
  project: null;
  isVoice?: boolean;
  voiceMode?: string;
  ttsVoiceId?: string;
  llmConfigId?: string | null;
}

const VOICE_AGENT: FakeAgent = {
  id: 'agent-voice',
  name: 'Voice',
  ownerId: 'user-owner',
  boardId: null,
  project: null,
  isVoice: true,
  voiceMode: 'external',
  ttsVoiceId: 'agent-voice-id',
  llmConfigId: 'llm-1',
};

const TEXT_AGENT: FakeAgent = {
  id: 'agent-text',
  name: 'Text',
  ownerId: 'user-owner',
  boardId: null,
  project: null,
};

const agents = new Map<string, FakeAgent>([
  [VOICE_AGENT.id, VOICE_AGENT],
  [TEXT_AGENT.id, TEXT_AGENT],
]);

const STT_KEY = 'SECRET-STT-KEY';
const TTS_KEY = 'SECRET-TTS-KEY';

interface VoiceSettings {
  sttServiceUrl: string;
  sttApiKey: string;
  ttsServiceUrl: string;
  ttsApiKey: string;
  ttsVoiceId: string;
}

// Mutable so a test can point the proxy at a dead port or blank the config out.
let settings: VoiceSettings = {
  sttServiceUrl: '',
  sttApiKey: STT_KEY,
  ttsServiceUrl: '',
  ttsApiKey: TTS_KEY,
  ttsVoiceId: 'global-voice-id',
};

mock.module('../database/agents.js', {
  namedExports: {
    getAgentById: async (id: string) => agents.get(id) ?? null,
    getAllAgents: async () => [...agents.values()],
    getAgentsByBoard: async () => [],
    saveAgent: async () => {},
    deleteAgentFromDb: async () => {},
    rowToAgent: (row: { data: FakeAgent }) => row.data,
  },
});

mock.module('../configManager.js', {
  namedExports: {
    getSettings: async () => ({ ...settings }),
  },
});

const { externalVoiceRoutes } = await import('../../routes/externalVoice.js');
const { installVoiceProxy, VOICE_PATH_RE, voiceProxyPath, buildWsUrl } =
  await import('../../routes/voiceProxy.js');

// ── Helpers ─────────────────────────────────────────────────────────────────

const ORIGIN = 'http://localhost:5173';

function sessionCookie(userId: string, role = 'user'): string {
  const token = jwt.sign({ userId, username: userId, role, csrf: 'csrf-secret' }, 'test-secret', {
    expiresIn: 600,
  });
  return `pt_session=${token}`;
}

function portOf(server: HttpServer | WebSocketServer): number {
  const address = 'address' in server ? server.address() : null;
  if (!address || typeof address === 'string') throw new Error('server is not listening on a port');
  return (address as AddressInfo).port;
}

function listen(server: HttpServer): Promise<void> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve()));
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(new Uint8Array(data));
}

/** Resolve on the next `event`, or reject rather than hang the suite. */
function once<T>(emitter: EventEmitter, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for "${event}"`)),
      timeoutMs
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args as T);
    });
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition never became true');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

interface UpstreamFrame {
  binary: boolean;
  bytes: Buffer;
}

/**
 * Stand-in for the STT/TTS provider: records the URL it was dialled with (the
 * api_key lives there) and echoes every frame back with the same binary flag.
 */
function startFakeProvider(): {
  wss: WebSocketServer;
  url: () => string;
  dialledUrls: string[];
  frames: UpstreamFrame[];
  sockets: WebSocket[];
} {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  const dialledUrls: string[] = [];
  const frames: UpstreamFrame[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (socket, req) => {
    dialledUrls.push(req.url ?? '');
    sockets.push(socket);
    socket.on('message', (data: RawData, isBinary: boolean) => {
      frames.push({ binary: isBinary, bytes: toBuffer(data) });
      socket.send(toBuffer(data), { binary: isBinary });
    });
  });
  return { wss, url: () => `ws://127.0.0.1:${portOf(wss)}/speech`, dialledUrls, frames, sockets };
}

// ── The API under test ──────────────────────────────────────────────────────

const provider = startFakeProvider();
await once(provider.wss, 'listening');

// One http.Server carrying both the Express app and the upgrade listeners, the
// same shape as index.ts.
const app = express();
// Stands in for authenticateToken: the router itself only calls sessionUser().
let currentUser: { userId: string; username: string; role: string; csrf: string } | null = null;
app.use((req, _res, next) => {
  if (currentUser) req.user = currentUser;
  next();
});
// `agents` is the only member the route touches; the real AgentManager is a
// 3000-line class, so it is narrowed here rather than constructed.
app.use('/api/external-voice', externalVoiceRoutes({ agents } as unknown as AgentManagerLike));
type AgentManagerLike = Parameters<typeof externalVoiceRoutes>[0];

const httpServer = createServer(app);
installVoiceProxy(httpServer);
// A second upgrade listener, standing in for socket.io + the terminal proxy:
// it must still get its turn on a path the voice proxy does not own.
httpServer.on('upgrade', (_req, socket) => {
  if (_req.url?.startsWith('/ws/other')) {
    socket.write('HTTP/1.1 418 I am a teapot\r\n\r\n');
    socket.destroy();
  }
});
await listen(httpServer);
const apiPort = portOf(httpServer);

// Nothing may keep the process alive once the suite is done: `npm test` runs
// each file as its own child, and a lingering socket hangs the whole run.
after(() => {
  for (const socket of openedSockets) socket.terminate();
  for (const socket of provider.sockets) socket.terminate();
  httpServer.closeAllConnections();
  httpServer.close();
  provider.wss.close();
});

function configUrl(agentId: string): string {
  return `http://127.0.0.1:${apiPort}/api/external-voice/config/${agentId}`;
}

const openedSockets: WebSocket[] = [];
function openClientSocket(path: string, headers: Record<string, string>): WebSocket {
  const socket = new WebSocket(`ws://127.0.0.1:${apiPort}${path}`, { headers });
  openedSockets.push(socket);
  return socket;
}

/** Drive an upgrade that is expected to fail, and return the HTTP status. */
async function rejectedStatus(path: string, headers: Record<string, string>): Promise<number> {
  const socket = openClientSocket(path, headers);
  const [err] = await once<[Error]>(socket, 'error');
  socket.terminate();
  const match = /(\d{3})/.exec(err.message);
  return match ? Number(match[1]) : 0;
}

// ── 1. The config route no longer carries a credential ──────────────────────

test('GET /config hands out same-origin proxy paths and no key in any form', async () => {
  settings = { ...settings, sttServiceUrl: provider.url(), ttsServiceUrl: provider.url() };
  currentUser = { userId: 'user-owner', username: 'owner', role: 'user', csrf: 'csrf-secret' };

  const res = await fetch(configUrl('agent-voice'));
  assert.equal(res.status, 200);
  const raw = await res.text();

  // The whole body, not just the fields we remember to look at.
  assert.ok(!raw.includes(STT_KEY), 'STT key leaked into /config');
  assert.ok(!raw.includes(TTS_KEY), 'TTS key leaked into /config');
  assert.ok(!raw.includes('api_key'), 'an api_key param leaked into /config');
  assert.ok(!raw.includes('ws://'), '/config still hands out an absolute provider URL');
  assert.ok(!raw.includes('wss://'), '/config still hands out an absolute provider URL');

  const body: unknown = JSON.parse(raw);
  assert.deepEqual(body, {
    stt: {
      available: true,
      wsUrl: '/ws/voice/stt/agent-voice',
      sampleRate: 16000,
      encoding: 'pcm16',
      channels: 1,
    },
    tts: {
      available: true,
      wsUrl: '/ws/voice/tts/agent-voice',
      sampleRate: 22050,
      encoding: 'pcm16',
      channels: 1,
      voiceId: 'agent-voice-id',
    },
    llmConfigId: 'llm-1',
  });
});

test('GET /config still 503s when the operator configured no service', async () => {
  const saved = settings;
  settings = { ...settings, sttServiceUrl: '' };
  currentUser = { userId: 'user-owner', username: 'owner', role: 'user', csrf: 'csrf-secret' };
  const res = await fetch(configUrl('agent-voice'));
  assert.equal(res.status, 503);
  settings = saved;
});

test('GET /config refuses an agent the caller cannot read', async () => {
  currentUser = { userId: 'user-other', username: 'other', role: 'user', csrf: 'csrf-secret' };
  const res = await fetch(configUrl('agent-voice'));
  assert.equal(res.status, 403);
  currentUser = null;
});

test('buildWsUrl still puts the key on the upstream URL — server side only', () => {
  const url = buildWsUrl('wss://speech.example/stt', STT_KEY);
  assert.ok(url);
  assert.ok(url.includes(`api_key=${STT_KEY}`));
  assert.equal(buildWsUrl('', STT_KEY), null);
});

test('voiceProxyPath and VOICE_PATH_RE agree, and the regex claims nothing else', () => {
  assert.equal(voiceProxyPath('stt', 'agent-voice'), '/ws/voice/stt/agent-voice');
  assert.equal(voiceProxyPath('tts', 'a/b'), '/ws/voice/tts/a%2Fb');
  assert.ok(VOICE_PATH_RE.exec('/ws/voice/stt/agent-voice'));
  assert.ok(VOICE_PATH_RE.exec('/ws/voice/tts/agent-voice'));
  // Sockets belonging to the other upgrade listeners.
  assert.equal(VOICE_PATH_RE.exec('/socket.io/'), null);
  assert.equal(VOICE_PATH_RE.exec('/ws/agents/agent-voice/terminal'), null);
  assert.equal(VOICE_PATH_RE.exec('/ws/voice/other/agent-voice'), null);
  assert.equal(VOICE_PATH_RE.exec('/ws/voice/stt/agent/extra'), null);
});

// ── 2. The upgrade guard chain ──────────────────────────────────────────────

test('upgrade without a session is refused', async () => {
  assert.equal(await rejectedStatus('/ws/voice/stt/agent-voice', { origin: ORIGIN }), 401);
});

test('upgrade with a garbage session token is refused', async () => {
  const status = await rejectedStatus('/ws/voice/stt/agent-voice', {
    origin: ORIGIN,
    cookie: 'pt_session=not-a-jwt',
  });
  assert.equal(status, 401);
});

test('upgrade for an agent the caller cannot read is refused', async () => {
  const status = await rejectedStatus('/ws/voice/stt/agent-voice', {
    origin: ORIGIN,
    cookie: sessionCookie('user-other'),
  });
  assert.equal(status, 403);
});

test('upgrade from a foreign origin is refused even with a valid session', async () => {
  const status = await rejectedStatus('/ws/voice/stt/agent-voice', {
    origin: 'http://evil.example',
    cookie: sessionCookie('user-owner'),
  });
  assert.equal(status, 403);
});

test('upgrade for an unknown agent is refused', async () => {
  const status = await rejectedStatus('/ws/voice/stt/nope', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  assert.equal(status, 404);
});

test('upgrade for a non-external-voice agent is refused', async () => {
  const status = await rejectedStatus('/ws/voice/stt/agent-text', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  assert.equal(status, 400);
});

test('an upgrade on another listener path is left untouched', async () => {
  // 418 comes from the second listener installed above: the voice proxy saw a
  // path it does not own and returned without consuming the socket.
  const status = await rejectedStatus('/ws/other', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  assert.equal(status, 418);
});

// ── 3. The bridge itself ────────────────────────────────────────────────────

test('relays text AND binary frames both ways, with the key only on the upstream leg', async () => {
  settings = { ...settings, sttServiceUrl: provider.url(), ttsServiceUrl: provider.url() };
  provider.dialledUrls.length = 0;
  provider.frames.length = 0;

  const client = openClientSocket('/ws/voice/stt/agent-voice', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  const received: UpstreamFrame[] = [];
  client.on('message', (data: RawData, isBinary: boolean) =>
    received.push({ binary: isBinary, bytes: toBuffer(data) })
  );
  await once(client, 'open');

  // Sent immediately on open — before the upstream socket can possibly be
  // ready, which is exactly the frame that must not be dropped.
  client.send(JSON.stringify({ type: 'session.start' }));
  const pcm = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80]);
  client.send(pcm);

  await waitFor(() => received.length >= 2);

  // Upstream saw both frames, with the flags intact.
  assert.equal(provider.frames.length, 2);
  assert.equal(provider.frames[0].binary, false);
  assert.equal(
    provider.frames[0].bytes.toString('utf8'),
    JSON.stringify({ type: 'session.start' })
  );
  assert.equal(provider.frames[1].binary, true);
  assert.deepEqual(provider.frames[1].bytes, pcm);

  // And the echo came back down the same way — this is the TTS direction.
  assert.equal(received[0].binary, false);
  assert.equal(received[0].bytes.toString('utf8'), JSON.stringify({ type: 'session.start' }));
  assert.equal(received[1].binary, true);
  assert.deepEqual(received[1].bytes, pcm);

  // The credential travelled on the server→provider leg, and only there.
  assert.equal(provider.dialledUrls.length, 1);
  assert.ok(provider.dialledUrls[0].includes(`api_key=${STT_KEY}`));

  const upstreamSocket = provider.sockets[provider.sockets.length - 1];
  const upstreamClosed = once(upstreamSocket, 'close');
  client.close(1000, 'done');
  // A browser walking away must not leave the provider socket (and its quota)
  // running.
  await upstreamClosed;
});

test('the tts path dials the tts service with the tts key', async () => {
  provider.dialledUrls.length = 0;
  const client = openClientSocket('/ws/voice/tts/agent-voice', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  await once(client, 'open');
  await waitFor(() => provider.dialledUrls.length === 1);
  assert.ok(provider.dialledUrls[0].includes(`api_key=${TTS_KEY}`));
  assert.ok(!provider.dialledUrls[0].includes(STT_KEY));
  client.close();
});

test('an upstream close reaches the browser, code and all', async () => {
  const socketsBefore = provider.sockets.length;
  const client = openClientSocket('/ws/voice/tts/agent-voice', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  await once(client, 'open');
  await waitFor(() => provider.sockets.length > socketsBefore);
  const upstreamSocket = provider.sockets[provider.sockets.length - 1];
  const closed = once<[number, Buffer]>(client, 'close');
  upstreamSocket.close(4002, 'provider gone');
  const [code] = await closed;
  assert.equal(code, 4002);
});

test('an unreachable voice service closes the browser socket instead of hanging', async () => {
  const saved = settings;
  // Port 1: nothing listens there, so the upstream dial fails outright.
  settings = { ...settings, sttServiceUrl: 'ws://127.0.0.1:1/speech' };
  const client = openClientSocket('/ws/voice/stt/agent-voice', {
    origin: ORIGIN,
    cookie: sessionCookie('user-owner'),
  });
  await once(client, 'open');
  const [code] = await once<[number, Buffer]>(client, 'close');
  assert.equal(code, 1011);
  settings = saved;
});
