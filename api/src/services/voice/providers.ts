import { GoogleGenAI, Modality, type LiveConnectConfig } from '@google/genai';
import { buildRealtimeSessionConfig, DEFAULT_REALTIME_MODEL, VOICE_TOOLS } from './config.js';

export const DEFAULT_GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
export type VoiceProvider = 'openai' | 'gemini';

interface VoiceConfig {
  provider?: string;
  model?: string;
  apiKey: string;
  voice?: string;
  instructions: string;
}

export function resolveVoiceProvider(provider = '', model = ''): VoiceProvider {
  if (provider === 'google' || provider === 'gemini') return 'gemini';
  if (provider === 'openai' || (!provider && model.startsWith('gpt-realtime'))) return 'openai';
  throw new Error(
    `Unsupported voice provider: ${provider || '(unset)'}. Use OpenAI or Google Gemini.`
  );
}

export function resolveVoiceModel(provider: VoiceProvider, configured = ''): string {
  if (provider === 'gemini') {
    return (
      process.env.GEMINI_LIVE_MODEL ||
      (/^gemini-.*(?:live|native-audio)/.test(configured) ? configured : DEFAULT_GEMINI_LIVE_MODEL)
    );
  }
  // Upgrade the old default; explicit mini and dated model selections remain available.
  return (
    process.env.OPENAI_REALTIME_MODEL ||
    (configured.startsWith('gpt-realtime') &&
    !['gpt-realtime', 'gpt-realtime-1.5'].includes(configured)
      ? configured
      : DEFAULT_REALTIME_MODEL)
  );
}

export function buildGeminiSessionConfig(instructions: string, voice = 'Kore'): LiveConnectConfig {
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: instructions,
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
    tools: [
      {
        functionDeclarations: VOICE_TOOLS.map(({ name, description, parameters }) => ({
          name,
          description,
          parametersJsonSchema: parameters,
        })),
      },
    ],
  };
}

const providers = {
  openai: async (config: VoiceConfig, model: string) => {
    const voice =
      config.voice && /^[a-z]+$/.test(config.voice)
        ? config.voice
        : process.env.OPENAI_REALTIME_VOICE || 'alloy';
    const session = buildRealtimeSessionConfig({
      instructions: config.instructions,
      voice,
      model,
      transcriptionModel: process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL,
    });
    const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok)
      throw new Error(
        `OpenAI voice session failed (${response.status}). Check the API key, model access and quota.`
      );
    const data = await response.json();
    const token = data.client_secret?.value || data.value;
    if (!token) throw new Error('OpenAI returned no voice session token.');
    return {
      provider: 'openai' as const,
      token,
      model,
      voice,
      session,
      expiresAt: data.client_secret?.expires_at || data.expires_at,
    };
  },
  gemini: async (config: VoiceConfig, model: string) => {
    // Older voice agents persist OpenAI's "alloy". Use Gemini's default on provider switch.
    const voice =
      config.voice && /^[A-Z]/.test(config.voice)
        ? config.voice
        : process.env.GEMINI_LIVE_VOICE || 'Kore';
    const session = buildGeminiSessionConfig(config.instructions, voice);
    const client = new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: { apiVersion: 'v1beta', timeout: 30000 },
    });
    const expiresAt = Math.floor(Date.now() / 1000) + 1800;
    const token = await client.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(expiresAt * 1000).toISOString(),
        newSessionExpireTime: new Date(Date.now() + 60000).toISOString(),
        liveConnectConstraints: { model, config: session },
      },
    });
    if (!token.name) throw new Error('Gemini returned no voice session token.');
    return { provider: 'gemini' as const, token: token.name, expiresAt, model, voice, session };
  },
};

export async function createVoiceSession(config: VoiceConfig) {
  const provider = resolveVoiceProvider(config.provider, config.model);
  try {
    return await providers[provider](config, resolveVoiceModel(provider, config.model));
  } catch (error) {
    if (provider !== 'gemini') throw error;
    const status =
      error && typeof error === 'object' && 'status' in error ? error.status : 'unavailable';
    throw new Error(
      `Gemini voice session failed (${status}). Check the Google API key, model access and quota.`
    );
  }
}
