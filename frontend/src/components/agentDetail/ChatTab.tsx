import { useRef, useState, useEffect, useCallback } from 'react';
import {
  MessageSquare, Send, RotateCcw, StopCircle, ArrowDownToLine, ImagePlus, X, RefreshCw,
  Mic, MicOff, Volume2, VolumeX, Loader2,
} from 'lucide-react';
import ChatMessage from './ChatMessage';
import { RichAssistantContent } from './ChatMessage';
import { api } from '../../api';
import { SttSession, TtsPlayer } from '../../lib/externalVoiceClient';

export default function ChatTab({
  history, thinking, streamBuffer, message, setMessage, sending, isBusy, onSend, onStop,
  onClear, onReload, onTruncate, chatEndRef, agentName, autoScroll, onToggleAutoScroll,
  supportsImages, pendingImages, onAddImages, onRemoveImage,
  agent,
}) {
  const fileInputRef = useRef(null);
  const [reloading, setReloading] = useState(false);

  // ── STT / TTS state ──────────────────────────────────────────────────
  // Voice services are global (Admin Settings). We probe availability once
  // per agent and only render the mic/speaker affordances when the operator
  // actually configured the services.
  const [voiceServices, setVoiceServices] = useState<any>(null);
  const [sttState, setSttState] = useState<'idle' | 'listening' | 'finalizing'>('idle');
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [partial, setPartial] = useState('');
  const [ttsSpeaking, setTtsSpeaking] = useState(false);
  // Speaker can be muted ad-hoc by the user even when the agent has TTS on.
  const [speakerMuted, setSpeakerMuted] = useState(false);

  const sttRef = useRef<SttSession | null>(null);
  const ttsRef = useRef<TtsPlayer | null>(null);
  // Track which assistant message we've already spoken so a UI re-render
  // doesn't cause us to speak the same reply twice.
  const lastSpokenRef = useRef<string | null>(null);
  // Capture the assistant history length at the moment the user submits, so
  // we only speak replies that arrive AFTER the current turn — not stale
  // ones already in history when the chat tab opens.
  const turnBaselineRef = useRef<number>(-1);

  const ttsEnabled = !!agent?.ttsEnabled && !!voiceServices?.tts?.available;
  const sttAvailable = !!voiceServices?.stt?.available;

  useEffect(() => {
    if (!agent?.id) return;
    api.getExternalVoiceServices(agent.id)
      .then(setVoiceServices)
      .catch(() => setVoiceServices(null));
  }, [agent?.id]);

  // Initialize the baseline so we don't speak existing history on mount —
  // only future replies (any assistant message beyond the current count).
  useEffect(() => {
    if (turnBaselineRef.current < 0 && history) {
      turnBaselineRef.current = history.length;
    }
  }, [agent?.id, history?.length]);

  // Reset baseline + speaker state when switching agents.
  useEffect(() => {
    turnBaselineRef.current = history ? history.length : 0;
    lastSpokenRef.current = null;
    stopTts();
    stopStt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  // Speak the latest assistant reply when streaming completes — but only if
  // it appeared after the current turn baseline and isn't the one we already
  // spoke. Streaming is detected via `streamBuffer` / agent.status === busy.
  useEffect(() => {
    if (!ttsEnabled || speakerMuted) return;
    if (isBusy || streamBuffer) return;
    if (!Array.isArray(history) || history.length === 0) return;
    if (history.length <= turnBaselineRef.current) return;
    const last = history[history.length - 1];
    if (!last || last.role !== 'assistant') return;
    const text = (last.content || '').toString().trim();
    if (!text) return;
    const key = `${history.length}:${text.slice(0, 64)}`;
    if (lastSpokenRef.current === key) return;
    lastSpokenRef.current = key;
    speak(text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history, streamBuffer, isBusy, ttsEnabled, speakerMuted]);

  const speak = useCallback((text: string) => {
    const cfg = voiceServices?.tts;
    if (!cfg?.available || !cfg.wsUrl) return;
    stopTts();
    const player = new TtsPlayer(
      { wsUrl: cfg.wsUrl, sampleRate: cfg.sampleRate || 22050, voiceId: cfg.voiceId || '' },
      {
        onStart: () => setTtsSpeaking(true),
        onEnd: () => { setTtsSpeaking(false); ttsRef.current = null; },
        onError: (msg) => { setVoiceError(msg); setTtsSpeaking(false); },
      },
    );
    ttsRef.current = player;
    player.speak(text);
  }, [voiceServices]);

  const stopTts = useCallback(() => {
    if (ttsRef.current) {
      try { ttsRef.current.stop(); } catch { /* ignore */ }
      ttsRef.current = null;
    }
    setTtsSpeaking(false);
  }, []);

  const stopStt = useCallback(() => {
    if (sttRef.current) {
      try { sttRef.current.stop(); } catch { /* ignore */ }
      sttRef.current = null;
    }
    setSttState('idle');
    setPartial('');
  }, []);

  const startStt = useCallback(async () => {
    const cfg = voiceServices?.stt;
    if (!cfg?.available || !cfg.wsUrl) {
      setVoiceError('STT service is not configured.');
      return;
    }
    setVoiceError(null);
    setPartial('');
    // Stop any ongoing playback so the mic doesn't capture our own TTS.
    stopTts();
    const session = new SttSession(
      { wsUrl: cfg.wsUrl, sampleRate: cfg.sampleRate || 16000 },
      {
        onStateChange: (state) => setSttState(state),
        onPartial: (text) => setPartial(text),
        onError: (msg) => setVoiceError(msg),
        onFinal: (text) => {
          sttRef.current = null;
          setPartial('');
          setSttState('idle');
          const trimmed = (text || '').trim();
          if (!trimmed) return;
          // Mark the baseline so the upcoming assistant reply is spoken.
          turnBaselineRef.current = (history ? history.length : 0) + 1;
          // Append (rather than replace) so the user can chain dictation
          // onto whatever is already in the textarea.
          setMessage((prev) => (prev && prev.trim() ? `${prev.trim()} ${trimmed}` : trimmed));
          // Auto-send on a microtask so React commits the textarea update.
          setTimeout(() => { onSend?.(); }, 0);
        },
      },
    );
    sttRef.current = session;
    try {
      await session.start();
    } catch {
      sttRef.current = null;
    }
  }, [voiceServices, history, setMessage, onSend, stopTts]);

  // Tear everything down when leaving the tab / unmounting.
  useEffect(() => {
    return () => {
      stopStt();
      stopTts();
    };
  }, [stopStt, stopTts]);

  const handleMicClick = () => {
    if (sttState === 'listening') {
      // Second click → tell STT to finalize the current utterance.
      sttRef.current?.finalize();
    } else if (sttState === 'idle') {
      startStt();
    }
  };

  const handleReload = async () => {
    if (!onReload || reloading) return;
    setReloading(true);
    try {
      await onReload();
    } finally {
      setReloading(false);
    }
  };

  // When streamBuffer is active, the last assistant message in history may be
  // a duplicate (agent:updated can arrive before the buffer is cleared).
  // Hide it to prevent a brief "doubled text" flash.
  const displayHistory = (streamBuffer && history.length > 0 && history[history.length - 1].role === 'assistant')
    ? history.slice(0, -1)
    : history;

  const handleFileSelect = (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      if (!file.type.match(/^image\/(png|jpeg|gif|webp)$/)) continue;
      if (file.size > 10 * 1024 * 1024) continue; // 10MB max

      const reader = new FileReader();
      reader.onload = (ev) => {
        const dataUrl = ev.target.result;
        // Extract base64 data and media type from data URL
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (match) {
          onAddImages?.([{ mediaType: match[1], data: match[2], preview: dataUrl }]);
        }
      };
      reader.readAsDataURL(file);
    }
    // Reset input so same file can be selected again
    e.target.value = '';
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto p-4 space-y-4">
        {displayHistory.length === 0 && !streamBuffer && (
          <div className="text-center py-12 text-dark-500">
            <MessageSquare className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm">Start a conversation with {agentName}</p>
          </div>
        )}

        {displayHistory.map((msg, i) => (
          <ChatMessage key={i} message={msg} index={i} isLast={i === displayHistory.length - 1} onTruncate={onTruncate} />
        ))}

        {/* Thinking indicator (shown during reasoning before/alongside text) */}
        {thinking && !streamBuffer && (
          <div className="flex gap-3 animate-fadeIn">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
              AI
            </div>
            <div className="flex-1 bg-dark-800/50 rounded-xl p-3 border border-amber-500/20">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                <span className="text-xs text-amber-400 font-medium">Thinking...</span>
              </div>
              <div className="text-xs text-dark-400 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto">
                {thinking.slice(-500)}
              </div>
            </div>
          </div>
        )}

        {/* Streaming response */}
        {streamBuffer && (
          <div className="flex gap-3 animate-fadeIn">
            <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center flex-shrink-0 text-xs text-white font-bold">
              AI
            </div>
            <div className="flex-1 bg-dark-800/50 rounded-xl p-3 border border-dark-700/50">
              {thinking && (
                <details className="mb-2">
                  <summary className="text-xs text-amber-400 cursor-pointer hover:text-amber-300 flex items-center gap-1">
                    <div className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                    Thinking...
                  </summary>
                  <div className="mt-1 text-xs text-dark-400 font-mono whitespace-pre-wrap break-words max-h-40 overflow-auto border-l-2 border-amber-500/30 pl-2">
                    {thinking.slice(-500)}
                  </div>
                </details>
              )}
              <div className="markdown-content text-sm text-dark-200">
                <RichAssistantContent text={streamBuffer} />
              </div>
              <div className="flex items-center gap-1 mt-2">
                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" />
                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" style={{ animationDelay: '0.2s' }} />
                <div className="w-1 h-1 rounded-full bg-indigo-500 animate-pulse" style={{ animationDelay: '0.4s' }} />
              </div>
            </div>
          </div>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-dark-700 p-3">
        {/* Voice status row — only visible while STT/TTS is active or errored */}
        {(sttState !== 'idle' || partial || ttsSpeaking || voiceError) && (
          <div className="mb-2 flex items-center gap-2 text-xs">
            {sttState === 'listening' && (
              <span className="flex items-center gap-1.5 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                Listening… {partial && <span className="italic text-dark-300">"{partial}"</span>}
              </span>
            )}
            {sttState === 'finalizing' && (
              <span className="flex items-center gap-1.5 text-amber-400">
                <Loader2 className="w-3 h-3 animate-spin" />
                Transcribing…
              </span>
            )}
            {ttsSpeaking && (
              <span className="flex items-center gap-1.5 text-indigo-400">
                <Volume2 className="w-3 h-3" />
                Speaking…
              </span>
            )}
            {voiceError && (
              <span className="text-red-400">{voiceError}</span>
            )}
          </div>
        )}
        {/* Image previews */}
        {pendingImages && pendingImages.length > 0 && (
          <div className="flex gap-2 mb-2 flex-wrap">
            {pendingImages.map((img, i) => (
              <div key={i} className="relative group">
                <img
                  src={img.preview}
                  alt={`Upload ${i + 1}`}
                  className="w-16 h-16 object-cover rounded-lg border border-dark-600"
                />
                <button
                  onClick={() => onRemoveImage?.(i)}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-dark-700 border border-dark-500 rounded-full flex items-center justify-center text-dark-300 hover:text-red-400 hover:border-red-500/50 transition-colors"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-2">
          <button
            onClick={onClear}
            className="p-2 text-dark-500 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors flex-shrink-0"
            title="Clear history"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
          {onReload && (
            <button
              onClick={handleReload}
              disabled={reloading}
              className="p-2 text-dark-500 hover:text-indigo-400 hover:bg-dark-700 rounded-lg transition-colors flex-shrink-0 disabled:opacity-40"
              title="Reload conversation from database"
            >
              <RefreshCw className={`w-4 h-4 ${reloading ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={onToggleAutoScroll}
            className={`p-2 rounded-lg transition-colors flex-shrink-0 ${autoScroll ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20' : 'text-dark-500 hover:text-dark-300 hover:bg-dark-700'}`}
            title={autoScroll ? 'Auto-scroll on' : 'Auto-scroll off'}
          >
            <ArrowDownToLine className="w-4 h-4" />
          </button>
          {supportsImages && (
            <>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/gif,image/webp"
                multiple
                onChange={handleFileSelect}
                className="hidden"
              />
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={sending}
                className="p-2 text-dark-500 hover:text-emerald-400 hover:bg-dark-700 rounded-lg transition-colors flex-shrink-0 disabled:opacity-40"
                title="Upload image"
              >
                <ImagePlus className="w-4 h-4" />
              </button>
            </>
          )}
          {/* Microphone (STT) — only shown when the global STT service is configured. */}
          {sttAvailable && (
            <button
              onClick={handleMicClick}
              disabled={sending && sttState === 'idle'}
              className={`p-2 rounded-lg transition-colors flex-shrink-0 disabled:opacity-40 ${
                sttState === 'listening'
                  ? 'text-red-300 bg-red-500/20 hover:bg-red-500/30 animate-pulse'
                  : sttState === 'finalizing'
                    ? 'text-amber-400 bg-amber-500/10'
                    : 'text-dark-500 hover:text-emerald-400 hover:bg-dark-700'
              }`}
              title={
                sttState === 'listening' ? 'Stop recording (auto-stops on silence)' :
                sttState === 'finalizing' ? 'Transcribing…' :
                'Speak to send (Speech-to-Text)'
              }
            >
              {sttState === 'finalizing'
                ? <Loader2 className="w-4 h-4 animate-spin" />
                : sttState === 'listening'
                  ? <MicOff className="w-4 h-4" />
                  : <Mic className="w-4 h-4" />}
            </button>
          )}
          {/* Speaker mute — only shown when TTS is enabled on this agent. Lets
              the user temporarily silence playback without touching settings. */}
          {ttsEnabled && (
            <button
              onClick={() => {
                if (speakerMuted) {
                  setSpeakerMuted(false);
                } else {
                  setSpeakerMuted(true);
                  stopTts();
                }
              }}
              className={`p-2 rounded-lg transition-colors flex-shrink-0 ${
                speakerMuted
                  ? 'text-red-400 bg-red-500/10 hover:bg-red-500/20'
                  : ttsSpeaking
                    ? 'text-indigo-400 bg-indigo-500/10 hover:bg-indigo-500/20'
                    : 'text-dark-500 hover:text-indigo-400 hover:bg-dark-700'
              }`}
              title={speakerMuted ? 'Speaker muted — click to enable' : ttsSpeaking ? 'Stop speaking' : 'TTS on — click to mute'}
            >
              {speakerMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
            </button>
          )}
          <div className="flex-1 relative">
            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !sending) {
                  e.preventDefault();
                  // Track baseline so the upcoming reply is eligible for TTS.
                  if (ttsEnabled) turnBaselineRef.current = (history ? history.length : 0) + 1;
                  onSend();
                }
              }}
              onPaste={(e) => {
                if (!supportsImages) return;
                const items = Array.from(e.clipboardData?.items || []);
                const imageItems = items.filter(item => item.type.match(/^image\/(png|jpeg|gif|webp)$/));
                if (imageItems.length === 0) return;
                e.preventDefault();
                for (const item of imageItems) {
                  const file = item.getAsFile();
                  if (!file || file.size > 10 * 1024 * 1024) continue;
                  const reader = new FileReader();
                  reader.onload = (ev) => {
                    const dataUrl = ev.target.result;
                    const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
                    if (match) {
                      onAddImages?.([{ mediaType: match[1], data: match[2], preview: dataUrl }]);
                    }
                  };
                  reader.readAsDataURL(file);
                }
              }}
              className="w-full px-4 py-2.5 bg-dark-800 border border-dark-600 rounded-xl text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 resize-none"
              placeholder={
                sttAvailable
                  ? (supportsImages
                      ? "Type, paste an image, or click the mic to speak…"
                      : "Type a message or click the mic to speak…")
                  : (supportsImages
                      ? "Type a message or paste an image... (Shift+Enter for new line)"
                      : "Type a message... (Shift+Enter for new line)")
              }
              rows={1}
              disabled={sending}
            />
          </div>
          {isBusy ? (
            <button
              onClick={onStop}
              className="p-2.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-xl transition-colors flex-shrink-0"
              title="Stop agent"
            >
              <StopCircle className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => {
                if (ttsEnabled) turnBaselineRef.current = (history ? history.length : 0) + 1;
                onSend();
              }}
              disabled={sending || (!message.trim() && (!pendingImages || pendingImages.length === 0))}
              className="p-2.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-xl disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex-shrink-0"
            >
              <Send className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
