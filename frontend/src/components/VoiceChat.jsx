import { Mic, MicOff, Loader2, PhoneOff, Volume2 } from 'lucide-react';
import { useMemo } from 'react';
import { STATUS, useVoiceSession } from '../contexts/VoiceSessionContext';

function statusColor(status) {
  switch (status) {
    case STATUS.CONNECTED:
    case STATUS.LISTENING:
    case STATUS.SPEAKING:
    case STATUS.DELEGATING:
      return 'bg-green-500';
    case STATUS.CONNECTING:
      return 'bg-yellow-500 animate-pulse';
    case STATUS.ERROR:
      return 'bg-red-500';
    default:
      return 'bg-gray-500';
  }
}

export default function VoiceChat({ agent, showToast }) {
  const {
    status,
    isActive,
    isMuted,
    currentTranscript,
    currentResponse,
    currentFunction,
    connect,
    disconnect,
    toggleMute,
  } = useVoiceSession();

  const isVoiceAgent = agent?.isVoice;

  const statusLabel = useMemo(() => {
    if (!isVoiceAgent) return 'Not a voice agent';
    if (status === STATUS.CONNECTED) return 'Connected';
    if (status === STATUS.CONNECTING) return 'Connecting...';
    if (status === STATUS.LISTENING) return 'Listening...';
    if (status === STATUS.SPEAKING) return 'Speaking...';
    if (status === STATUS.DELEGATING) return 'Delegating...';
    if (status === STATUS.ERROR) return 'Connection failed';
    return 'Ready';
  }, [isVoiceAgent, status]);

  const handleConnect = async () => {
    if (!agent?.id) return;
    try {
      await connect(agent.id);
    } catch (err) {
      console.error('Voice connect failed:', err);
      showToast?.(err.message || 'Failed to connect voice', 'error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-dark-700 bg-dark-800/60 p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 rounded-full ${statusColor(status)}`} />
              <span className="text-sm font-medium text-dark-100">{statusLabel}</span>
            </div>
            <p className="mt-1 text-xs text-dark-400">
              {isVoiceAgent
                ? 'Live Realtime speech-to-speech connection'
                : 'Enable a voice template to use realtime speech'}
            </p>
          </div>

          <div className="flex gap-2">
            {!isActive ? (
              <button
                onClick={handleConnect}
                disabled={!isVoiceAgent || status === STATUS.CONNECTING}
                className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {status === STATUS.CONNECTING ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting
                  </>
                ) : (
                  <>
                    <Mic className="h-4 w-4" />
                    Start Voice
                  </>
                )}
              </button>
            ) : (
              <>
                <button
                  onClick={toggleMute}
                  className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-white ${
                    isMuted ? 'bg-yellow-600 hover:bg-yellow-500' : 'bg-slate-600 hover:bg-slate-500'
                  }`}
                >
                  {isMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  {isMuted ? 'Unmute' : 'Mute'}
                </button>
                <button
                  onClick={disconnect}
                  className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-white hover:bg-red-500"
                >
                  <PhoneOff className="h-4 w-4" />
                  End
                </button>
              </>
            )}
          </div>
        </div>

        {isActive && (
          <div className="mt-4 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
            <div className="rounded-lg border border-dark-700 bg-dark-900/60 p-3">
              <div className="flex items-center gap-2 text-dark-300">
                <Mic className="h-4 w-4" />
                <span>You</span>
              </div>
              <p className="mt-2 min-h-[2rem] text-dark-100">
                {currentTranscript || 'Waiting for speech...'}
              </p>
            </div>

            <div className="rounded-lg border border-dark-700 bg-dark-900/60 p-3">
              <div className="flex items-center gap-2 text-dark-300">
                <Volume2 className="h-4 w-4" />
                <span>Agent</span>
              </div>
              <p className="mt-2 min-h-[2rem] text-dark-100">
                {currentResponse || 'No response yet...'}
              </p>
            </div>

            <div className="rounded-lg border border-dark-700 bg-dark-900/60 p-3">
              <div className="flex items-center gap-2 text-dark-300">
                <Loader2 className="h-4 w-4" />
                <span>Voice Status</span>
              </div>
              <p className="mt-2 min-h-[2rem] text-dark-100">
                {currentFunction || 'No activity yet...'}
              </p>
            </div>
          </div>
        )}

        <p className="mt-4 text-xs text-dark-500">
          Tip: start voice from a button click, allow microphone access, and make sure the browser tab is not muted.
        </p>
      </div>
    </div>
  );
}