import type { LiveConnectConfig } from '@google/genai';

export type VoiceSessionConfig =
  | {
      provider: 'openai';
      token: string;
      model: string;
      voice: string;
      expiresAt: number;
      session: unknown;
    }
  | {
      provider: 'gemini';
      token: string;
      model: string;
      voice: string;
      expiresAt: number;
      session: LiveConnectConfig;
    };

// Common events consumed by the agent controller. Adapters normalize provider frames.
export interface VoiceEvent {
  type?: string;
  transcript?: string;
  delta?: string;
  message?: string;
  error?: { message?: string };
  name?: string;
  call_id?: string;
  arguments?: string;
}

export interface VoiceTransportOptions {
  stream: MediaStream;
  audio: HTMLAudioElement;
  onEvent: (event: VoiceEvent) => void;
  onConnected: () => void;
  onError: (message: string) => void;
  onClose: () => void;
}

export interface VoiceTransport {
  connect: () => Promise<void>;
  close: () => void;
  sendFunctionOutput: (callId: string, output: string) => void;
  setMuted: (muted: boolean) => void;
  setSpeakerOff: (off: boolean) => void;
}
