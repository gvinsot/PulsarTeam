import { createGeminiTransport } from './gemini';
import { createOpenAiTransport } from './openai';
import type { VoiceSessionConfig, VoiceTransport, VoiceTransportOptions } from './types';

export function createVoiceTransport(
  config: VoiceSessionConfig,
  options: VoiceTransportOptions
): VoiceTransport {
  switch (config.provider) {
    case 'gemini':
      return createGeminiTransport(config, options);
    case 'openai':
      return createOpenAiTransport(config, options);
    default:
      throw new Error('Unsupported voice provider returned by the server.');
  }
}
