// External Voice Agent — browser-side pipeline:
//   mic → AudioWorklet (16 kHz PCM16 + RMS) → STT WS → text →
//   regular /chat → text → TTS WS → PCM16 (22050 Hz) → playback
//
// The STT service (HighSpeedToText) only emits `transcript.final` after the
// client sends `session.end`. We therefore run client-side voice-activity
// detection: when RMS energy drops below a threshold for `SILENCE_MS` after
// the user has spoken, we close the utterance with `session.end`, wait for
// the final transcript, forward it to the agent chat, play the TTS reply,
// then reopen a fresh STT session for the next turn.
//
// All audio runs through the browser; this component only talks to the
// backend to fetch STT/TTS WS URLs and to forward the transcript through
// the regular agent chat endpoint.
import { useEffect, useRef, useState, useCallback } from 'react';
import { Mic, MicOff, PhoneOff, Loader2, Volume2, VolumeX, RefreshCw, MessageSquare } from 'lucide-react';
import { api } from '../api';
import {
  WORKLET_CODE, SILENCE_MS, MIN_SPEECH_MS, RMS_SPEECH, RMS_SILENCE, decodePcm16ToBuffer,
} from '../lib/externalVoiceClient';

type Status = 'disconnected' | 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error';

const STATUS_LABEL: Record<Status, string> = {
  disconnected: 'Disconnected',
  connecting:   'Connecting…',
  listening:    'Listening',
  thinking:     'Thinking…',
  speaking:     'Speaking',
  error:        'Error',
};

export default function ExternalVoiceChatTab({ agent }) {
  const [status, setStatus] = useState<Status>('disconnected');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [partial, setPartial] = useState<string>('');
  const [history, setHistory] = useState<Array<{ role: string; content: string; timestamp?: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const sttSocketRef = useRef<WebSocket | null>(null);
  const ttsSocketRef = useRef<WebSocket | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const playCtxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const playbackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mutedRef = useRef(false);
  const speakerOffRef = useRef(false);
  const configRef = useRef<any>(null);
  const sessionActiveRef = useRef(false);
  const sttRetryRef = useRef(0);
  const transcriptListRef = useRef<HTMLDivElement | null>(null);

  // Voice-activity-detection state for the current utterance.
  const vadRef = useRef({
    speechStartedAt: 0,   // ts of first speech sample in current utterance
    lastSpeechAt: 0,      // ts of most recent speech sample
    ended: false,         // session.end already sent for this utterance
  });

  useEffect(() => { mutedRef.current = muted; }, [muted]);
  useEffect(() => { speakerOffRef.current = speakerOff; }, [speakerOff]);

  const refreshHistory = useCallback(async () => {
    setHistoryLoading(true);
    try {
      const data = await api.getHistory(agent.id);
      setHistory(Array.isArray(data?.history) ? data.history : Array.isArray(data) ? data : []);
    } catch (err) {
      console.warn('[ExternalVoice] history reload failed', err);
    } finally {
      setHistoryLoading(false);
    }
  }, [agent.id]);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  // Auto-scroll the transcript list when new messages arrive.
  useEffect(() => {
    const el = transcriptListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [history.length, partial]);

  const cleanup = useCallback(() => {
    sessionActiveRef.current = false;
    try { sttSocketRef.current?.close(); } catch { /* ignore */ }
    try { ttsSocketRef.current?.close(); } catch { /* ignore */ }
    sttSocketRef.current = null;
    ttsSocketRef.current = null;
    try { workletNodeRef.current?.disconnect(); } catch { /* ignore */ }
    try { sourceNodeRef.current?.disconnect(); } catch { /* ignore */ }
    workletNodeRef.current = null;
    sourceNodeRef.current = null;
    if (streamRef.current) {
      for (const t of streamRef.current.getTracks()) t.stop();
      streamRef.current = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => {});
      audioCtxRef.current = null;
    }
    if (playCtxRef.current) {
      playCtxRef.current.close().catch(() => {});
      playCtxRef.current = null;
    }
  }, []);

  useEffect(() => cleanup, [cleanup]);

  // Schedule a PCM16 chunk for playback. We chain promises so chunks play in
  // order and don't overlap.
  const enqueuePcmChunk = useCallback((arrayBuf: ArrayBuffer, sampleRate: number) => {
    if (speakerOffRef.current) return;
    playbackQueueRef.current = playbackQueueRef.current.then(async () => {
      if (speakerOffRef.current) return;
      if (!playCtxRef.current) {
        playCtxRef.current = new AudioContext({ sampleRate });
      }
      const ctx = playCtxRef.current;
      const buf = decodePcm16ToBuffer(ctx, arrayBuf, sampleRate);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      await new Promise<void>(resolve => {
        src.onended = () => resolve();
        src.start();
      });
    }).catch(err => {
      console.error('[ExternalVoice] playback error', err);
    });
  }, []);

  // Forward to LLM, then speak the reply, then reopen STT for next turn.
  const handleTranscript = useCallback(async (text: string) => {
    if (!text.trim()) {
      if (sessionActiveRef.current) openStt();
      return;
    }
    setStatus('thinking');
    try {
      await api.chatAgent(agent.id, text);
      await refreshHistory();
      const updated = await api.getHistory(agent.id);
      const histArr = Array.isArray(updated?.history) ? updated.history : Array.isArray(updated) ? updated : [];
      const lastAssistant = [...histArr].reverse().find((m: any) => m.role === 'assistant');
      const reply = (lastAssistant?.content || '').toString().trim();
      if (!reply) {
        if (sessionActiveRef.current) openStt();
        return;
      }
      speak(reply);
    } catch (err: any) {
      console.error('[ExternalVoice] chat error', err);
      setError(err.message || 'Chat call failed');
      setStatus('error');
      cleanup();
    }
    // openStt/speak hoisted below — see closures resolved at call time
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, refreshHistory]);

  // Speak text using the TTS WebSocket, then loop back to listening.
  const speak = useCallback((text: string) => {
    const cfg = configRef.current;
    if (!cfg || !text.trim()) {
      if (sessionActiveRef.current) openStt();
      return;
    }
    setStatus('speaking');
    const ws = new WebSocket(cfg.tts.wsUrl);
    ws.binaryType = 'arraybuffer';
    ttsSocketRef.current = ws;
    ws.onopen = () => {
      const startMsg: any = {
        type: 'session.start',
        config: { text, mode: 'zero_shot' },
      };
      if (cfg.tts.voiceId) startMsg.config.voice_id = cfg.tts.voiceId;
      ws.send(JSON.stringify(startMsg));
    };
    ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        try {
          const msg = JSON.parse(evt.data);
          if (msg.type === 'session.summary' || msg.type === 'session.end') {
            try { ws.close(); } catch { /* ignore */ }
          } else if (msg.type === 'error') {
            setError(`TTS: ${msg.message || 'unknown error'}`);
          }
        } catch { /* binary chunks come as ArrayBuffer */ }
      } else {
        enqueuePcmChunk(evt.data as ArrayBuffer, cfg.tts.sampleRate);
      }
    };
    ws.onerror = () => setError('TTS WebSocket error');
    ws.onclose = () => {
      // Wait for the playback queue to drain, then reopen STT.
      playbackQueueRef.current = playbackQueueRef.current.then(() => {
        ttsSocketRef.current = null;
        if (sessionActiveRef.current) openStt();
      });
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enqueuePcmChunk]);

  // Open a fresh STT WebSocket for the next utterance.
  function openStt() {
    const cfg = configRef.current;
    if (!cfg || !sessionActiveRef.current) return;
    setPartial('');
    vadRef.current = { speechStartedAt: 0, lastSpeechAt: 0, ended: false };

    const stt = new WebSocket(cfg.stt.wsUrl);
    stt.binaryType = 'arraybuffer';
    sttSocketRef.current = stt;

    stt.onopen = () => {
      sttRetryRef.current = 0;
      stt.send(JSON.stringify({ type: 'session.start', config: { language: 'fr' } }));
      setStatus('listening');
    };
    stt.onmessage = (evt) => {
      try {
        const raw = typeof evt.data === 'string'
          ? evt.data
          : new TextDecoder().decode(evt.data as ArrayBuffer);
        const msg = JSON.parse(raw);
        if (msg.type === 'transcript.partial') {
          setPartial(msg.text || '');
        } else if (msg.type === 'transcript.final') {
          const finalText = (msg.text || '').trim();
          setPartial('');
          // Null the ref before closing so onclose treats this as intentional.
          sttSocketRef.current = null;
          try { stt.close(); } catch { /* ignore */ }
          handleTranscript(finalText);
        } else if (msg.type === 'error') {
          setError(`STT: ${msg.message || 'unknown error'}`);
        }
      } catch (e) {
        console.warn('[ExternalVoice] STT message parse failed', e);
      }
    };
    stt.onerror = () => setError('STT WebSocket error');
    stt.onclose = () => {
      // Intentional closes null the ref first; only genuine drops reach here.
      if (sttSocketRef.current !== stt) return;
      sttSocketRef.current = null;
      if (!sessionActiveRef.current) return;
      if (sttRetryRef.current >= 3) {
        setError('STT connection lost');
        setStatus('error');
        cleanup();
        return;
      }
      sttRetryRef.current += 1;
      setTimeout(() => {
        if (sessionActiveRef.current && !sttSocketRef.current) openStt();
      }, 500 * sttRetryRef.current);
    };
  }

  // Handle worklet output (audio frames + RMS).
  function onWorkletFrame(ev: MessageEvent) {
    const data = ev.data as { pcm?: ArrayBuffer; rms: number };
    const ws = sttSocketRef.current;
    if (mutedRef.current || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (data.pcm) ws.send(data.pcm);

    // VAD: track speech/silence and finalize the utterance on trailing silence.
    const vad = vadRef.current;
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
        try { ws.send(JSON.stringify({ type: 'session.end' })); } catch { /* ignore */ }
      }
    }
  }

  const connect = useCallback(async () => {
    // Release any mic/contexts left over from a previous (errored) session.
    cleanup();
    setError(null);
    setStatus('connecting');
    sttRetryRef.current = 0;
    try {
      const cfg = await api.getExternalVoiceConfig(agent.id);
      configRef.current = cfg;
      sessionActiveRef.current = true;

      // ── Mic + worklet ─────────────────────────────────────────────────
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      const ctx = new AudioContext();
      audioCtxRef.current = ctx;
      const workletBlob = new Blob([WORKLET_CODE], { type: 'application/javascript' });
      const workletUrl = URL.createObjectURL(workletBlob);
      await ctx.audioWorklet.addModule(workletUrl);
      URL.revokeObjectURL(workletUrl);
      const source = ctx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;
      const node = new AudioWorkletNode(ctx, 'pcm-downsampler', {
        processorOptions: { targetRate: cfg.stt.sampleRate },
      });
      workletNodeRef.current = node;
      node.port.onmessage = onWorkletFrame;
      source.connect(node);
      // Worklet doesn't need to reach the destination — we only consume frames.

      // ── Kick off the first STT session ───────────────────────────────
      openStt();
    } catch (err: any) {
      console.error('[ExternalVoice] connect failed', err);
      setError(err.message || 'Connection failed');
      setStatus('error');
      cleanup();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, cleanup]);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus('disconnected');
    setPartial('');
  }, [cleanup]);

  const isActive = status !== 'disconnected' && status !== 'error';

  return (
    <div className="flex h-full flex-col">
      {/* Conversation history ─────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b border-dark-700 px-4 py-2">
        <div className="flex items-center gap-2 text-xs text-dark-400">
          <MessageSquare className="h-3.5 w-3.5" />
          Conversation
        </div>
        <button
          onClick={refreshHistory}
          disabled={historyLoading}
          className="flex items-center gap-1 text-xs text-dark-400 hover:text-dark-200 disabled:opacity-50"
          title="Refresh from DB"
        >
          <RefreshCw className={`h-3.5 w-3.5 ${historyLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>
      <div ref={transcriptListRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {history.length === 0 && !partial && (
          <div className="text-center text-xs text-dark-500 py-8">
            No messages yet. Start a voice session to talk to {agent.name}.
          </div>
        )}
        {history.map((m, i) => (
          <div key={i} className={`flex flex-col ${m.role === 'user' ? 'items-end' : 'items-start'}`}>
            <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
              m.role === 'user'
                ? 'bg-indigo-500/15 text-indigo-100 border border-indigo-500/30'
                : 'bg-dark-800 text-dark-100 border border-dark-700'
            }`}>
              <div className="text-[10px] uppercase tracking-wide text-dark-500 mb-1">
                {m.role === 'user' ? 'You' : agent.name}
              </div>
              <div className="whitespace-pre-wrap">{m.content}</div>
            </div>
          </div>
        ))}
        {partial && (
          <div className="flex flex-col items-end">
            <div className="max-w-[80%] rounded-lg px-3 py-2 text-sm bg-indigo-500/5 text-dark-300 border border-dashed border-indigo-500/30 italic">
              <div className="text-[10px] uppercase tracking-wide text-dark-500 mb-1">You (live)</div>
              {partial}
            </div>
          </div>
        )}
      </div>

      {/* Voice controls ──────────────────────────────────────────────── */}
      <div className="border-t border-dark-700 px-4 py-4 flex flex-col items-center gap-3">
        <div className="flex items-center gap-3">
          <div className={`
            flex h-14 w-14 items-center justify-center rounded-full transition-all duration-300
            ${status === 'listening' ? 'bg-emerald-500/20 ring-2 ring-emerald-500/40 animate-pulse' : ''}
            ${status === 'speaking'  ? 'bg-indigo-500/20  ring-2 ring-indigo-500/40' : ''}
            ${status === 'thinking'  ? 'bg-amber-500/20   ring-2 ring-amber-500/40 animate-pulse' : ''}
            ${status === 'connecting'? 'bg-dark-700 ring-2 ring-dark-500 animate-pulse' : ''}
            ${status === 'disconnected' ? 'bg-dark-800 ring-2 ring-dark-600' : ''}
            ${status === 'error'     ? 'bg-red-500/20 ring-2 ring-red-500/40' : ''}
          `}>
            {status === 'connecting' && <Loader2 className="h-5 w-5 animate-spin text-dark-300" />}
            {status === 'thinking'   && <Loader2 className="h-5 w-5 animate-spin text-amber-400" />}
            {status === 'listening'  && <Mic className="h-5 w-5 text-emerald-400" />}
            {status === 'speaking'   && <Volume2 className="h-5 w-5 text-indigo-400" />}
            {status === 'disconnected' && <Mic className="h-5 w-5 text-dark-500" />}
            {status === 'error'      && <MicOff className="h-5 w-5 text-red-400" />}
          </div>

          <div className="text-sm">
            <p className={`font-medium ${
              status === 'listening' ? 'text-emerald-400' :
              status === 'speaking'  ? 'text-indigo-400'  :
              status === 'thinking'  ? 'text-amber-400'   :
              status === 'error'     ? 'text-red-400'     :
              'text-dark-300'
            }`}>
              {STATUS_LABEL[status]}
            </p>
            {error && <p className="text-xs text-red-400/70">{error}</p>}
          </div>

          <div className="flex items-center gap-2 ml-2">
            {!isActive ? (
              <button
                onClick={connect}
                className="flex items-center gap-2 rounded-full bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-500"
              >
                <Mic className="h-4 w-4" />
                Start Voice
              </button>
            ) : (
              <>
                <button
                  onClick={() => setMuted(m => !m)}
                  className={`rounded-full p-2 transition-colors ${
                    muted ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                  title={muted ? 'Unmute mic' : 'Mute mic'}
                >
                  {muted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                </button>
                <button
                  onClick={() => setSpeakerOff(s => !s)}
                  className={`rounded-full p-2 transition-colors ${
                    speakerOff ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30' : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                  }`}
                  title={speakerOff ? 'Enable speaker' : 'Mute speaker'}
                >
                  {speakerOff ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
                </button>
                <button
                  onClick={disconnect}
                  className="rounded-full bg-red-500/20 p-2 text-red-400 transition-colors hover:bg-red-500/30"
                  title="End session"
                >
                  <PhoneOff className="h-4 w-4" />
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
