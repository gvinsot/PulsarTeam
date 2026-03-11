import { Mic, MicOff, PhoneOff, RefreshCw, Loader2, Volume2, VolumeX } from 'lucide-react';
import { STATUS, STATUS_LABELS, useVoiceSession } from '../contexts/VoiceSessionContext';

export default function VoiceChatTab({ agent }) {
  const voice = useVoiceSession();

  const isThisAgent = voice.isSessionForAgent(agent.id);
  const isOtherAgentActive = voice.isActive && !isThisAgent;

  const status = isThisAgent ? voice.status : STATUS.DISCONNECTED;
  const isActive = isThisAgent && voice.isActive;
  const error = isThisAgent ? voice.error : null;
  const delegationTarget = isThisAgent ? voice.delegationTarget : null;
  const events = isThisAgent ? voice.events : [];

  const handleConnect = () => {
    voice.connect(agent.id).catch((err) => {
      console.error('Voice connect failed:', err);
    });
  };

  const handleSwitchSession = () => {
    voice.disconnect();
    setTimeout(() => {
      voice.connect(agent.id).catch((err) => {
        console.error('Voice reconnect after switch failed:', err);
      });
    }, 150);
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8">
        <div className="relative">
          <div className={`
            flex h-32 w-32 items-center justify-center rounded-full transition-all duration-300
            ${status === STATUS.LISTENING ? 'bg-emerald-500/20 ring-4 ring-emerald-500/40 animate-pulse' : ''}
            ${status === STATUS.SPEAKING ? 'bg-indigo-500/20 ring-4 ring-indigo-500/40' : ''}
            ${status === STATUS.DELEGATING ? 'bg-amber-500/20 ring-4 ring-amber-500/40 animate-pulse' : ''}
            ${status === STATUS.CONNECTING ? 'bg-dark-700 ring-2 ring-dark-500 animate-pulse' : ''}
            ${status === STATUS.CONNECTED ? 'bg-dark-700 ring-2 ring-dark-500' : ''}
            ${status === STATUS.DISCONNECTED ? 'bg-dark-800 ring-2 ring-dark-600' : ''}
            ${status === STATUS.ERROR ? 'bg-red-500/20 ring-2 ring-red-500/40' : ''}
          `}>
            {status === STATUS.SPEAKING && (
              <>
                <div className="absolute inset-0 rounded-full border-2 border-indigo-500/30 animate-ping" />
                <div
                  className="absolute -inset-3 rounded-full border border-indigo-500/20 animate-ping"
                  style={{ animationDelay: '0.3s' }}
                />
                <div
                  className="absolute -inset-6 rounded-full border border-indigo-500/10 animate-ping"
                  style={{ animationDelay: '0.6s' }}
                />
              </>
            )}

            {status === STATUS.LISTENING && (
              <>
                <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30 animate-ping" />
                <div
                  className="absolute -inset-3 rounded-full border border-emerald-500/20 animate-ping"
                  style={{ animationDelay: '0.3s' }}
                />
              </>
            )}

            {status === STATUS.CONNECTING && <Loader2 className="h-10 w-10 animate-spin text-dark-300" />}
            {status === STATUS.DISCONNECTED && <Mic className="h-10 w-10 text-dark-500" />}
            {status === STATUS.CONNECTED && <Mic className="h-10 w-10 text-dark-300" />}
            {status === STATUS.LISTENING && <Mic className="h-10 w-10 text-emerald-400" />}

            {status === STATUS.SPEAKING && (
              <div className="flex items-center gap-1">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1.5 animate-bounce rounded-full bg-indigo-400"
                    style={{
                      height: `${12 + Math.random() * 20}px`,
                      animationDelay: `${i * 0.1}s`,
                      animationDuration: '0.6s',
                    }}
                  />
                ))}
              </div>
            )}

            {status === STATUS.DELEGATING && <Loader2 className="h-10 w-10 animate-spin text-amber-400" />}
            {status === STATUS.ERROR && <MicOff className="h-10 w-10 text-red-400" />}
          </div>
        </div>

        <div className="text-center">
          <p className={`text-lg font-medium ${
            status === STATUS.LISTENING ? 'text-emerald-400' :
            status === STATUS.SPEAKING ? 'text-indigo-400' :
            status === STATUS.DELEGATING ? 'text-amber-400' :
            status === STATUS.ERROR ? 'text-red-400' :
            'text-dark-300'
          }`}>
            {status === STATUS.DELEGATING
              ? `Delegating to ${delegationTarget}...`
              : STATUS_LABELS[status]}
          </p>
          {error && (
            <p className="mt-1 text-sm text-red-400/70">{error}</p>
          )}
        </div>

        <div className="flex items-center gap-3">
          {!isActive ? (
            <div className="flex flex-col items-center gap-3">
              {isOtherAgentActive ? (
                <>
                  <p className="text-center text-sm text-dark-400">
                    A voice session is active on another agent.
                  </p>
                  <button
                    onClick={handleSwitchSession}
                    className="flex items-center gap-2 rounded-full bg-amber-600 px-6 py-3 font-medium text-white transition-colors hover:bg-amber-500"
                  >
                    <RefreshCw className="h-5 w-5" />
                    Switch Voice Session Here
                  </button>
                </>
              ) : (
                <button
                  onClick={handleConnect}
                  className="flex items-center gap-2 rounded-full bg-indigo-600 px-6 py-3 font-medium text-white transition-colors hover:bg-indigo-500"
                >
                  <Mic className="h-5 w-5" />
                  Start Voice Session
                </button>
              )}
            </div>
          ) : (
            <>
              <button
                onClick={voice.toggleMute}
                className={`rounded-full p-3 transition-colors ${
                  voice.muted
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                }`}
                title={voice.muted ? 'Unmute' : 'Mute'}
              >
                {voice.muted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>

              <button
                onClick={voice.toggleSpeaker}
                className={`rounded-full p-3 transition-colors ${
                  voice.speakerOff
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                }`}
                title={voice.speakerOff ? 'Activer le haut-parleur' : 'Couper le haut-parleur'}
              >
                {voice.speakerOff ? <VolumeX className="h-5 w-5" /> : <Volume2 className="h-5 w-5" />}
              </button>

              <button
                onClick={voice.reconnect}
                className="rounded-full bg-dark-700 p-3 text-dark-300 transition-colors hover:bg-dark-600"
                title="Reconnect"
              >
                <RefreshCw className="h-5 w-5" />
              </button>

              <button
                onClick={voice.disconnect}
                className="rounded-full bg-red-500/20 p-3 text-red-400 transition-colors hover:bg-red-500/30"
                title="End session"
              >
                <PhoneOff className="h-5 w-5" />
              </button>
            </>
          )}
        </div>
      </div>

      {events.length > 0 && (
        <div className="max-h-48 overflow-y-auto border-t border-dark-700 px-4 py-2">
          {events.map((evt, i) => (
            <div key={i} className="flex items-start gap-2 py-1 text-xs">
              <span className="whitespace-nowrap text-dark-500">
                {evt.time.toLocaleTimeString()}
              </span>
              <span className={`
                ${evt.type === 'error' ? 'text-red-400' : ''}
                ${evt.type === 'delegation' ? 'text-amber-400' : ''}
                ${evt.type === 'delegation-result' ? 'text-emerald-400' : ''}
                ${evt.type === 'system' ? 'text-dark-400' : ''}
              `}>
                {evt.text}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}