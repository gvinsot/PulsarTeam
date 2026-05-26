// External voice agent endpoints.
//
// A different model from /api/realtime (OpenAI Realtime, speech-to-speech):
// this one wires three independent services together
//   1. STT (browser audio → text) — WebSocket URL exposed to the browser
//   2. LLM (text → text)         — call routed through the regular /api/agents/:id/chat
//   3. TTS (text → audio)        — WebSocket URL exposed to the browser
//
// Both URLs and API keys live in admin settings (sttServiceUrl, sttApiKey,
// ttsServiceUrl, ttsApiKey). We hand them to the browser as fully-formed
// WSS URLs with the api_key query param already injected — the same shape
// HighSpeedToText (https://speech-ui.methodinfo.fr/) documents.
import express from 'express';
import { getSettings } from '../services/configManager.js';

function buildWsUrl(rawUrl: string, apiKey: string): string | null {
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

export function externalVoiceRoutes(agentManager) {
  const router = express.Router();

  // Returns connection info for a given external-voice agent so the browser
  // can open STT + TTS WebSockets directly. No audio passes through this
  // backend — only credentials and per-agent voice config.
  router.get('/config/:agentId', async (req, res) => {
    const agent = agentManager.agents.get(req.params.agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.isVoice || agent.voiceMode !== 'external') {
      return res.status(400).json({ error: 'Agent is not an external voice agent' });
    }

    const settings = await getSettings();
    const sttUrl = buildWsUrl(settings.sttServiceUrl, settings.sttApiKey);
    const ttsUrl = buildWsUrl(settings.ttsServiceUrl, settings.ttsApiKey);

    if (!sttUrl || !ttsUrl) {
      return res.status(503).json({
        error: 'STT/TTS services are not configured. Set sttServiceUrl and ttsServiceUrl in Admin Settings.',
      });
    }

    res.json({
      stt: { wsUrl: sttUrl, sampleRate: 16000, encoding: 'pcm16', channels: 1 },
      tts: {
        wsUrl: ttsUrl,
        sampleRate: 22050,
        encoding: 'pcm16',
        channels: 1,
        voiceId: agent.ttsVoiceId || settings.ttsVoiceId || '',
      },
      llmConfigId: agent.llmConfigId || null,
    });
  });

  // Returns the global STT/TTS service availability and WS URLs so that the
  // regular text chat (any agent) can offer mic-input (STT) and spoken reply
  // (TTS). Unlike /config/:agentId, this route does not require the agent to
  // be a voice agent — it just exposes whatever the operator configured.
  // The per-agent ttsVoiceId is used when an agentId is provided.
  router.get('/services', async (req, res) => {
    const settings = await getSettings();
    const sttUrl = buildWsUrl(settings.sttServiceUrl, settings.sttApiKey);
    const ttsUrl = buildWsUrl(settings.ttsServiceUrl, settings.ttsApiKey);

    let voiceId = settings.ttsVoiceId || '';
    const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : null;
    if (agentId) {
      const agent = agentManager.agents.get(agentId);
      if (agent && agent.ttsVoiceId) voiceId = agent.ttsVoiceId;
    }

    res.json({
      stt: sttUrl
        ? { available: true, wsUrl: sttUrl, sampleRate: 16000, encoding: 'pcm16', channels: 1 }
        : { available: false },
      tts: ttsUrl
        ? { available: true, wsUrl: ttsUrl, sampleRate: 22050, encoding: 'pcm16', channels: 1, voiceId }
        : { available: false },
    });
  });

  return router;
}
