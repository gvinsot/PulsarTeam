// Reusable browser-side STT + TTS pipeline shared by the text chat and the
// external-voice tab. All audio runs entirely in the browser; the backend
// only hands us WSS URLs for the STT/TTS services configured in admin.
//
// STT: mic → AudioWorklet (PCM16 + RMS) → STT WS → transcript.final
//      Uses client-side VAD: trailing silence after speech triggers
//      session.end so the STT service emits a final transcript.
//
// TTS: text → TTS WS → PCM16 chunks → AudioContext playback
//
// Both helpers are exposed as small classes so the React components only
// wire up callbacks and start/stop.

// Silence-detection tuning (browser-side VAD).
const SILENCE_MS = 900;      // Trailing silence required to end an utterance.
const MIN_SPEECH_MS = 300;   // Discard utterances shorter than this.
const RMS_SPEECH = 0.02;     // Above → speech.
const RMS_SILENCE = 0.012;   // Below → silence.

// AudioWorklet — downsamples mic input to `targetRate` PCM16 frames and posts
// the per-block RMS so the main thread can run silence detection.
const WORKLET_CODE = `
class PcmDownsamplerProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = (options.processorOptions && options.processorOptions.targetRate) || 16000;
    this.inputRate = sampleRate;
    this.ratio = this.inputRate / this.targetRate;
    this.acc = 0;
    this.buffer = [];
  }
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch = input[0];
    if (!ch) return true;
    let sumSq = 0;
    for (let i = 0; i < ch.length; i++) sumSq += ch[i] * ch[i];
    const rms = Math.sqrt(sumSq / ch.length);
    for (let i = 0; i < ch.length; i++) {
      this.acc += 1;
      if (this.acc >= this.ratio) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.buffer.push(s < 0 ? s * 0x8000 : s * 0x7fff);
        this.acc -= this.ratio;
      }
    }
    if (this.buffer.length >= 1600) {
      const out = new Int16Array(this.buffer);
      this.buffer = [];
      this.port.postMessage({ pcm: out.buffer, rms }, [out.buffer]);
    } else {
      this.port.postMessage({ rms });
    }
    return true;
  }
}
registerProcessor('pcm-downsampler', PcmDownsamplerProcessor);
`;

export interface SttConfig {
  wsUrl: string;
  sampleRate: number;
  language?: string;
}

export interface SttCallbacks {
  onPartial?: (text: string) => void;
  onFinal: (text: string) => void;
  onError?: (msg: string) => void;
  onStateChange?: (state: 'idle' | 'listening' | 'finalizing') => void;
}

// One-shot single-utterance STT capture. Call start() to begin recording,
// the onFinal callback fires once trailing silence triggers session.end and
// the service returns transcript.final. Call stop() to abort early.
export class SttSession {
  private socket: WebSocket | null = null;
  private audioCtx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private vad = { speechStartedAt: 0, lastSpeechAt: 0, ended: false };
  private stopped = false;
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private config: SttConfig, private cb: SttCallbacks) {}

  async start(): Promise<void> {
    this.cb.onStateChange?.('listening');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      const ctx = new AudioContext();
      this.audioCtx = ctx;
      const workletBlob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(workletBlob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      const source = ctx.createMediaStreamSource(this.stream);
      this.sourceNode = source;
      const node = new AudioWorkletNode(ctx, 'pcm-downsampler', {
        processorOptions: { targetRate: this.config.sampleRate || 16000 },
      });
      this.workletNode = node;
      node.port.onmessage = (ev) => this.onFrame(ev);
      source.connect(node);

      const stt = new WebSocket(this.config.wsUrl);
      stt.binaryType = 'arraybuffer';
      this.socket = stt;
      stt.onopen = () => {
        stt.send(JSON.stringify({
          type: 'session.start',
          config: { language: this.config.language || 'fr' },
        }));
      };
      stt.onmessage = (evt) => {
        try {
          const raw = typeof evt.data === 'string'
            ? evt.data
            : new TextDecoder().decode(evt.data as ArrayBuffer);
          const msg = JSON.parse(raw);
          if (msg.type === 'transcript.partial') {
            this.cb.onPartial?.(msg.text || '');
          } else if (msg.type === 'transcript.final') {
            const finalText = (msg.text || '').trim();
            this.cleanup();
            this.cb.onStateChange?.('idle');
            this.cb.onFinal(finalText);
          } else if (msg.type === 'error') {
            this.cb.onError?.(msg.message || 'unknown STT error');
            this.cleanup();
            this.cb.onStateChange?.('idle');
          }
        } catch (e) {
          console.warn('[SttSession] message parse failed', e);
        }
      };
      stt.onerror = () => this.cb.onError?.('STT WebSocket error');
      stt.onclose = () => {
        // On the normal final/error paths cleanup() nulls this.socket before
        // the close event fires, so this only handles the service dropping
        // the connection mid-utterance.
        if (this.socket !== stt) return;
        this.socket = null;
        if (!this.stopped) {
          this.stopped = true;
          this.cleanup();
          this.cb.onError?.('STT connection closed before transcript');
          this.cb.onStateChange?.('idle');
        }
      };
    } catch (err: any) {
      this.cb.onError?.(err?.message || 'Could not start microphone');
      this.cleanup();
      this.cb.onStateChange?.('idle');
      throw err;
    }
  }

  // Force-finalize the current utterance — tell the STT service to emit a
  // transcript.final for whatever we've captured so far. The user clicked
  // the mic again to stop recording manually.
  finalize(): void {
    const ws = this.socket;
    if (ws && ws.readyState === WebSocket.OPEN && !this.vad.ended) {
      this.vad.ended = true;
      this.cb.onStateChange?.('finalizing');
      try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* ignore */ }
      this.armFinalizeTimeout();
    } else {
      this.stop();
    }
  }

  // The service may never answer session.end (restart, wedged connection) —
  // bail out of 'finalizing' instead of leaving the mic recording forever.
  private armFinalizeTimeout(): void {
    if (this.finalizeTimer) clearTimeout(this.finalizeTimer);
    this.finalizeTimer = setTimeout(() => {
      this.finalizeTimer = null;
      if (this.stopped) return;
      this.cb.onError?.('STT service did not return a transcript');
      this.stop();
    }, 10000);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.cleanup();
    this.cb.onStateChange?.('idle');
  }

  private cleanup(): void {
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    try { this.workletNode?.disconnect(); } catch { /* ignore */ }
    try { this.sourceNode?.disconnect(); } catch { /* ignore */ }
    this.workletNode = null;
    this.sourceNode = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }

  private onFrame(ev: MessageEvent): void {
    const data = ev.data as { pcm?: ArrayBuffer; rms: number };
    const ws = this.socket;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (data.pcm) ws.send(data.pcm);
    const vad = this.vad;
    if (vad.ended) return;
    const now = performance.now();
    if (data.rms >= RMS_SPEECH) {
      if (!vad.speechStartedAt) vad.speechStartedAt = now;
      vad.lastSpeechAt = now;
    } else if (data.rms <= RMS_SILENCE && vad.speechStartedAt) {
      const speechDur = vad.lastSpeechAt - vad.speechStartedAt;
      const silenceDur = now - vad.lastSpeechAt;
      if (speechDur >= MIN_SPEECH_MS && silenceDur >= SILENCE_MS) {
        vad.ended = true;
        this.cb.onStateChange?.('finalizing');
        try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* ignore */ }
        this.armFinalizeTimeout();
      }
    }
  }
}

export interface TtsConfig {
  wsUrl: string;
  sampleRate: number;
  voiceId?: string;
}

export interface TtsCallbacks {
  onStart?: () => void;
  onEnd?: () => void;
  onError?: (msg: string) => void;
}

// Plays a single utterance through the TTS WebSocket. Use stop() to cancel
// playback (closes the socket and silences the queued PCM buffer).
export class TtsPlayer {
  private socket: WebSocket | null = null;
  private playCtx: AudioContext | null = null;
  private playbackQueue: Promise<void> = Promise.resolve();
  private cancelled = false;
  private pendingSources: AudioBufferSourceNode[] = [];

  constructor(private config: TtsConfig, private cb: TtsCallbacks = {}) {}

  speak(text: string): void {
    if (!text || !text.trim()) {
      this.cb.onEnd?.();
      return;
    }
    const ws = new WebSocket(this.config.wsUrl);
    ws.binaryType = 'arraybuffer';
    this.socket = ws;
    this.cb.onStart?.();
    ws.onopen = () => {
      const startMsg: any = { type: 'session.start', config: { text, mode: 'zero_shot' } };
      if (this.config.voiceId) startMsg.config.voice_id = this.config.voiceId;
      ws.send(JSON.stringify(startMsg));
    };
    ws.onmessage = (evt) => {
      if (this.cancelled) return;
      if (typeof evt.data === 'string') {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'session.summary' || msg.type === 'session.end') {
            try { ws.close(); } catch { /* ignore */ }
          } else if (msg.type === 'error') {
            this.cb.onError?.(msg.message || 'unknown TTS error');
          }
        } catch { /* binary chunk path */ }
      } else {
        this.enqueuePcm(evt.data as ArrayBuffer);
      }
    };
    ws.onerror = () => this.cb.onError?.('TTS WebSocket error');
    ws.onclose = () => {
      this.playbackQueue = this.playbackQueue.then(() => {
        this.socket = null;
        // Close the AudioContext once the queue drains — stop() handles the
        // cancelled path, but the normal completion path would leak one live
        // context (and its audio thread) per spoken message otherwise.
        if (this.playCtx) {
          this.playCtx.close().catch(() => {});
          this.playCtx = null;
        }
        if (!this.cancelled) this.cb.onEnd?.();
      });
    };
  }

  stop(): void {
    this.cancelled = true;
    try { this.socket?.close(); } catch { /* ignore */ }
    this.socket = null;
    for (const src of this.pendingSources) {
      try { src.stop(); } catch { /* ignore */ }
    }
    this.pendingSources = [];
    if (this.playCtx) {
      this.playCtx.close().catch(() => {});
      this.playCtx = null;
    }
    this.cb.onEnd?.();
  }

  private enqueuePcm(arrayBuf: ArrayBuffer): void {
    if (this.cancelled) return;
    const sampleRate = this.config.sampleRate || 22050;
    this.playbackQueue = this.playbackQueue.then(async () => {
      if (this.cancelled) return;
      if (!this.playCtx) {
        this.playCtx = new AudioContext({ sampleRate });
      }
      const ctx = this.playCtx;
      const int16 = new Int16Array(arrayBuf);
      const float = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float[i] = int16[i] / 0x8000;
      const buf = ctx.createBuffer(1, float.length, sampleRate);
      buf.copyToChannel(float, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      this.pendingSources.push(src);
      await new Promise<void>(resolve => {
        src.onended = () => {
          this.pendingSources = this.pendingSources.filter(s => s !== src);
          resolve();
        };
        src.start();
      });
    }).catch(err => {
      console.error('[TtsPlayer] playback error', err);
    });
  }
}
