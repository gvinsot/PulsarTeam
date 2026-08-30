/**
 * External-voice WebSocket proxy.
 *
 * Bridges the browser's WebSocket (`/ws/voice/stt/:agentId` and
 * `/ws/voice/tts/:agentId`) to the operator's STT / TTS services, so the
 * service API key never leaves this process.
 *
 * ── Why the audio now transits the API ──────────────────────────────────────
 * `/api/external-voice/config/:agentId` used to hand the browser fully-formed
 * WSS URLs with `?api_key=<operator key>` already injected. On a multi-tenant
 * instance that is ONE shared provider credential copied into every tenant's
 * browser: readable from devtools, replayable against the provider by anyone
 * who was ever allowed to talk to a voice agent. Paying the bandwidth for the
 * PCM frames is the cheaper half of that trade, so the browser now speaks to
 * us and we speak to the provider.
 *
 * ── Auth + authorization ────────────────────────────────────────────────────
 * The same chain as the terminal proxy (routes/terminal.ts), in the same order
 * and for the same reasons:
 *   • Origin is checked FIRST. The session cookie is ambient on an upgrade and
 *     a handshake cannot carry the `X-CSRF-Token` header the HTTP API relies
 *     on, so the CORS allow-list is the cross-site-hijacking defence.
 *   • The session comes from the HttpOnly cookie, or from
 *     `Authorization: Bearer` for the clients that can set headers.
 *   • Authorization is `checkAgentAccess(agent, user, 'read')` — the very rule
 *     `/api/external-voice/config/:agentId` applies — plus the same
 *     external-voice check, so a socket cannot be opened for an agent whose
 *     config the caller could not have read in the first place.
 *
 * WARNING for whoever edits this next: the route inventory ratchet
 * (services/__tests__/routeInventory.test.ts) enumerates EXPRESS routes only.
 * It does not see WebSocket upgrades, so nothing will catch a guard deleted
 * from here. `authorizeVoiceUpgrade` is exported and unit-tested for that
 * reason — keep the decision in it rather than inline in the handler.
 *
 * ── What the client cannot influence ────────────────────────────────────────
 * The path names a service ('stt' | 'tts') and an agent; the upstream URL and
 * key are read from admin settings. The client's own query string is
 * deliberately NOT forwarded upstream — forwarding it would let a caller
 * append or override provider parameters, `api_key` among them.
 */
import type { IncomingHttpHeaders, IncomingMessage, Server as HttpServer } from 'http';
import type { Duplex } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { RawData } from 'ws';

import { isOriginAllowed, logRejectedOrigin } from '../middleware/corsConfig.js';
import { resolveSessionToken, verifySessionToken } from '../middleware/session.js';
import { checkAgentAccess } from '../lib/agentAccess.js';
import { getAgentById } from '../services/database.js';
import type { Agent } from '../services/database/agents.js';
import { getSettings } from '../services/configManager.js';
import { errorMessage } from '../lib/errors.js';

/** The two speech services proxied here. */
export type VoiceService = 'stt' | 'tts';

/**
 * Upgrade paths owned by this proxy. Anything else is left strictly alone —
 * socket.io and the terminal proxy have their own listeners on the same
 * server, and consuming a socket that is not ours would break them.
 */
export const VOICE_PATH_RE = /^\/ws\/voice\/(stt|tts)(?:\/([^/]+))?$/;

/**
 * Same-origin path handed to the browser instead of a key-bearing provider URL.
 *
 * Two shapes, matching the two callers and their two authorization levels:
 *   `/ws/voice/stt/<agentId>` — `/api/external-voice/config/:agentId`, the
 *     external-voice agent flow. Authorized on the agent (checkAgentAccess).
 *   `/ws/voice/stt`           — `/api/external-voice/services`, the plain chat
 *     flow, which has no agent in hand. Authorized on the session alone, which
 *     is exactly what that route already required (`authenticateToken`, no role
 *     and no agent) — so the proxy neither widens nor narrows who may speak.
 */
export function voiceProxyPath(service: VoiceService, agentId?: string | null): string {
  return agentId ? `/ws/voice/${service}/${encodeURIComponent(agentId)}` : `/ws/voice/${service}`;
}

/**
 * Outcome of the guard chain. One interface rather than a discriminated union:
 * this project's tsc does not narrow the negative branch of such a union, so
 * `if (!decision.ok)` would leave `statusLine` unreachable.
 */
export interface VoiceUpgradeDecision {
  ok: boolean;
  /** Raw HTTP status line to write back when `ok` is false. */
  statusLine?: string;
  /** Optional body, for the refusals a developer needs explained. */
  body?: string;
  /** The authorized agent, when `ok` is true. */
  agent?: Agent;
}

/** The subset of a request the guard reads — an `IncomingMessage` satisfies it. */
export interface VoiceUpgradeRequest {
  headers: IncomingHttpHeaders;
}

/** `agent.isVoice` / `agent.voiceMode` are untyped JSONB fields, hence `unknown`. */
function isExternalVoiceAgent(agent: Agent): boolean {
  return Boolean(agent.isVoice) && agent.voiceMode === 'external';
}

/**
 * Origin → session → authorization, in that order. Exported so it can be
 * tested without standing up an HTTP server; the upgrade handler below does
 * nothing else before accepting a socket.
 */
export async function authorizeVoiceUpgrade(
  req: VoiceUpgradeRequest,
  agentId: string | null
): Promise<VoiceUpgradeDecision> {
  const origin = req.headers.origin;
  if (origin && !isOriginAllowed(origin)) {
    logRejectedOrigin(origin, 'ws');
    return { ok: false, statusLine: '403 Forbidden' };
  }

  const claims = verifySessionToken(resolveSessionToken(req)?.token);
  if (!claims) return { ok: false, statusLine: '401 Unauthorized' };

  // Session-scoped leg: the plain chat flow names no agent, so there is nothing
  // agent-shaped to authorize. A valid session is the whole gate, deliberately —
  // GET /api/external-voice/services, the route that hands out this path, is
  // mounted behind `authenticateToken` and nothing else.
  if (!agentId) return { ok: true };

  let agent: Agent | null;
  try {
    agent = await getAgentById(agentId);
  } catch (err) {
    console.error(`[VoiceProxy] agent lookup failed: ${errorMessage(err)}`);
    return { ok: false, statusLine: '500 Internal Server Error' };
  }
  if (!agent) return { ok: false, statusLine: '404 Not Found' };

  let access;
  try {
    access = await checkAgentAccess(agent, claims, 'read');
  } catch (err) {
    console.error(`[VoiceProxy] access check failed: ${errorMessage(err)}`);
    return { ok: false, statusLine: '500 Internal Server Error' };
  }
  if (!access.ok) {
    // 404 stays 404 so an unknown id and a forbidden id read the same as they
    // do over HTTP; everything else collapses to 403.
    return { ok: false, statusLine: access.status === 404 ? '404 Not Found' : '403 Forbidden' };
  }

  if (!isExternalVoiceAgent(agent)) {
    return {
      ok: false,
      statusLine: '400 Bad Request',
      body: 'Agent is not an external voice agent',
    };
  }

  return { ok: true, agent };
}

/**
 * Compose the provider's WS URL with the operator's key in the `api_key` query
 * param — the shape HighSpeedToText (https://speech-ui.methodinfo.fr/)
 * documents. Lives here, next to the only code that dials it, rather than in
 * externalVoice.ts where its output used to be handed to the browser.
 *
 * SERVER-SIDE ONLY. The returned string CARRIES THE CREDENTIAL: it may be
 * passed to `new WebSocket()` inside this process (here, and the admin probe in
 * externalVoice.ts POST /test/:service), and must never be written into an HTTP
 * response body.
 */
export function buildWsUrl(rawUrl: string, apiKey: string): string | null {
  if (!rawUrl) return null;
  try {
    const u = new URL(rawUrl);
    if (apiKey) u.searchParams.set('api_key', apiKey);
    return u.toString();
  } catch {
    // Allow operators to paste a URL with query already present
    if (apiKey && !rawUrl.includes('api_key=')) {
      const sep = rawUrl.includes('?') ? '&' : '?';
      return `${rawUrl}${sep}api_key=${encodeURIComponent(apiKey)}`;
    }
    return rawUrl;
  }
}

/**
 * The upstream URL, key included. Built here and never returned to a caller —
 * it is passed straight to `new WebSocket()` inside this process.
 */
export async function resolveUpstreamVoiceUrl(service: VoiceService): Promise<string | null> {
  const settings = await getSettings();
  const rawUrl = service === 'stt' ? settings.sttServiceUrl : settings.ttsServiceUrl;
  const apiKey = service === 'stt' ? settings.sttApiKey : settings.ttsApiKey;
  return buildWsUrl(rawUrl, apiKey);
}

/**
 * Reject an upgrade with a raw HTTP status line and tear the socket down.
 *
 * The peer may already be gone — an upgrade can be aborted while the guard
 * chain is awaiting the database. A write to a dead socket emits 'error'
 * instead of throwing, and an unhandled 'error' on a bare Duplex takes the
 * process down, so it is absorbed here rather than left as a crash path on the
 * one branch that only runs when something has already gone wrong.
 */
function rejectUpgrade(socket: Duplex, statusLine: string, body = ''): void {
  socket.on('error', () => {});
  if (socket.destroyed) return;
  try {
    socket.write(`HTTP/1.1 ${statusLine}\r\n\r\n${body}`);
  } catch {
    /* died mid-write — destroy() is all that is left to do */
  }
  socket.destroy();
}

/**
 * Install the voice proxy on the given http.Server. Adds a SECOND `upgrade`
 * listener next to the terminal proxy's and socket.io's: each returns
 * immediately for a path it does not own, so the three cohabit.
 */
export function installVoiceProxy(httpServer: HttpServer): void {
  // No perMessageDeflate: the payload is already-compact PCM and deflate would
  // burn CPU per frame on a latency-sensitive path for nothing.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const urlPath = req.url ? req.url.split('?')[0] : '';
    const match = urlPath ? VOICE_PATH_RE.exec(urlPath) : null;
    if (!match) return; // not our route — leave the socket for the other listeners

    const service: VoiceService = match[1] === 'stt' ? 'stt' : 'tts';
    // Absent on the session-scoped leg (`/ws/voice/stt`) — see voiceProxyPath.
    let agentId: string | null = null;
    if (match[2] !== undefined) {
      try {
        agentId = decodeURIComponent(match[2]);
      } catch {
        rejectUpgrade(socket, '400 Bad Request', 'Malformed agent id');
        return;
      }
    }

    // The listener itself stays synchronous so an async rejection can never
    // escape as an unhandled rejection and take the process down.
    void (async () => {
      try {
        const decision = await authorizeVoiceUpgrade(req, agentId);
        if (!decision.ok) {
          rejectUpgrade(socket, decision.statusLine || '403 Forbidden', decision.body || '');
          return;
        }

        const upstreamUrl = await resolveUpstreamVoiceUrl(service);
        if (!upstreamUrl) {
          rejectUpgrade(
            socket,
            '503 Service Unavailable',
            `${service.toUpperCase()} service is not configured`
          );
          return;
        }

        wss.handleUpgrade(req, socket, head, clientWs => {
          wireVoiceProxy(clientWs, upstreamUrl, service, agentId);
        });
      } catch (err) {
        console.error(`[VoiceProxy] upgrade failed: ${errorMessage(err)}`);
        rejectUpgrade(socket, '500 Internal Server Error');
      }
    })();
  });
}

// ── The bridge ──────────────────────────────────────────────────────────────
//
// The browser's socket is accepted BEFORE the upstream one is open, because a
// refused handshake reaches the page as a bare `error` event with no code and
// no reason. So the first frames — `{type:"session.start"}` and, for STT, the
// PCM that follows immediately — can arrive before upstream is ready. They are
// queued rather than dropped: losing session.start would leave a socket that is
// connected and silent, which is the worst failure shape here.
//
// The queue is bounded so a wedged upstream cannot grow it without limit.
// 1 MiB is ~30 s of 16 kHz mono PCM16, far beyond any sane connect time.
const MAX_PENDING_FRAMES = 64;
const MAX_PENDING_BYTES = 1024 * 1024;

interface PendingFrame {
  data: RawData;
  binary: boolean;
}

function frameSize(data: RawData): number {
  if (Buffer.isBuffer(data)) return data.length;
  if (Array.isArray(data)) return data.reduce((total, chunk) => total + chunk.length, 0);
  return data.byteLength;
}

/**
 * Close codes a WebSocket endpoint is allowed to SEND. `ws` throws a RangeError
 * on anything else — 1006 (abnormal closure) in particular, which is exactly
 * what an upstream that died mid-stream reports. Propagating it blindly would
 * throw inside the close path and leave the other side hanging open, so
 * anything unsendable is reported as 1011 (internal error).
 */
function sendableCloseCode(code: number): number {
  if (code === 1000) return code;
  if (code >= 1001 && code <= 1003) return code;
  if (code >= 1007 && code <= 1011) return code;
  if (code >= 3000 && code <= 4999) return code;
  return 1011;
}

/** A close reason travels in the control frame: 123 bytes, hard limit. */
function sendableReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out, 'utf8') > 123) out = out.slice(0, -1);
  return out;
}

/**
 * Close one side, whatever state it is in. `terminate()` is the backstop: if
 * `close()` throws we must still drop the socket, or the connection (and, on
 * the upstream side, the provider's quota) leaks.
 */
function hardClose(ws: WebSocket, code: number, reason: string): void {
  try {
    ws.close(code, reason);
  } catch {
    try {
      ws.terminate();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Shovel frames both ways until either side closes. BINARY IS THE POINT: STT
 * is browser→provider PCM and TTS is provider→browser PCM, so `isBinary` is
 * carried through on every send. A text-only bridge connects cleanly and
 * transports no audio at all.
 */
function wireVoiceProxy(
  clientWs: WebSocket,
  upstreamUrl: string,
  service: VoiceService,
  agentId: string | null
): void {
  const upstream = new WebSocket(upstreamUrl);
  // 'session' on the agent-less leg: the log line still says which flow it is.
  const tag = `${service}/${agentId ? agentId.slice(0, 8) : 'session'}`;

  const pending: PendingFrame[] = [];
  let pendingBytes = 0;
  let closed = false;

  // Both sockets always go down together: a browser that walks away must not
  // leave a provider socket (and its quota) running, and an upstream that dies
  // must not leave the page waiting on silence.
  const closeBoth = (code = 1000, reason = ''): void => {
    if (closed) return;
    closed = true;
    pending.length = 0;
    pendingBytes = 0;
    const safeCode = sendableCloseCode(code);
    const safeReason = sendableReason(reason);
    hardClose(clientWs, safeCode, safeReason);
    hardClose(upstream, safeCode, safeReason);
  };

  upstream.on('open', () => {
    for (const frame of pending) {
      try {
        upstream.send(frame.data, { binary: frame.binary });
      } catch (err) {
        closeBoth(1011, `upstream send failed: ${errorMessage(err)}`);
        return;
      }
    }
    pending.length = 0;
    pendingBytes = 0;
  });

  // upstream → browser: TTS audio (binary) and status envelopes (text).
  upstream.on('message', (data: RawData, isBinary: boolean) => {
    if (clientWs.readyState !== WebSocket.OPEN) return;
    try {
      clientWs.send(data, { binary: isBinary });
    } catch {
      closeBoth(1011, 'client send failed');
    }
  });

  upstream.on('close', (code: number, reason: Buffer) => {
    closeBoth(code, reason?.toString() || '');
  });

  // Unreachable service, TLS failure, a key the provider refused: the browser
  // gets an explicit close rather than a socket that opened and never spoke.
  // The real cause is logged here — it must not be echoed to the client, since
  // an upstream error message can quote the URL we dialled, key included.
  upstream.on('error', (err: Error) => {
    console.warn(`[VoiceProxy] upstream error (${tag}): ${errorMessage(err)}`);
    closeBoth(1011, 'voice service unavailable');
  });

  // browser → upstream: STT PCM (binary) and session control (text).
  clientWs.on('message', (data: RawData, isBinary: boolean) => {
    if (closed) return;
    if (upstream.readyState === WebSocket.OPEN) {
      try {
        upstream.send(data, { binary: isBinary });
      } catch (err) {
        closeBoth(1011, `upstream send failed: ${errorMessage(err)}`);
      }
      return;
    }
    if (upstream.readyState !== WebSocket.CONNECTING) return;
    pending.push({ data, binary: isBinary });
    pendingBytes += frameSize(data);
    if (pending.length > MAX_PENDING_FRAMES || pendingBytes > MAX_PENDING_BYTES) {
      closeBoth(1011, 'voice service did not accept the connection in time');
    }
  });

  clientWs.on('close', (code: number, reason: Buffer) => {
    closeBoth(code, reason?.toString() || '');
  });
  clientWs.on('error', (err: Error) => {
    console.warn(`[VoiceProxy] client error (${tag}): ${errorMessage(err)}`);
    closeBoth(1011, 'client error');
  });
}

/** @internal exposed for tests — the bounds the pending queue enforces. */
export const _voiceProxyInternals = {
  MAX_PENDING_FRAMES,
  MAX_PENDING_BYTES,
  sendableCloseCode,
  sendableReason,
  frameSize,
};
