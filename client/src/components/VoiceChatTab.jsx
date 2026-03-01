import { useState, useRef, useEffect, useCallback } from 'react';
import { Mic, MicOff, PhoneOff, RefreshCw, Loader2 } from 'lucide-react';
import { api } from '../api';

const STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  LISTENING: 'listening',
  SPEAKING: 'speaking',
  DELEGATING: 'delegating',
  ERROR: 'error',
};

const STATUS_LABELS = {
  [STATUS.DISCONNECTED]: 'Disconnected',
  [STATUS.CONNECTING]: 'Connecting...',
  [STATUS.CONNECTED]: 'Connected — ready',
  [STATUS.LISTENING]: 'Listening...',
  [STATUS.SPEAKING]: 'Speaking...',
  [STATUS.DELEGATING]: 'Delegating...',
  [STATUS.ERROR]: 'Error',
};

export default function VoiceChatTab({ agent, socket }) {
  const [status, setStatus] = useState(STATUS.DISCONNECTED);
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState(null);
  const [delegationTarget, setDelegationTarget] = useState(null);
  const [events, setEvents] = useState([]); // timeline of voice events

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const audioRef = useRef(null);
  const localStreamRef = useRef(null);

  const addEvent = useCallback((type, text) => {
    setEvents(prev => [...prev, { type, text, time: new Date() }]);
  }, []);

  // ── Request microphone permission ────────────────────────────────
  const requestMicPermission = useCallback(async () => {
    // Check if mediaDevices is available (requires HTTPS)
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('Microphone access requires a secure connection (HTTPS).');
    }

    // Check current permission state if Permissions API is available
    if (navigator.permissions && navigator.permissions.query) {
      try {
        const permStatus = await navigator.permissions.query({ name: 'microphone' });
        if (permStatus.state === 'denied') {
          throw new Error(
            'Microphone access is blocked. Please open your browser settings and allow microphone access for this site, then try again.'
          );
        }
      } catch (permErr) {
        // Permissions API may not support 'microphone' query on some browsers — ignore and try getUserMedia directly
        if (permErr.message.includes('blocked') || permErr.message.includes('settings')) {
          throw permErr;
        }
      }
    }

    // Request microphone — this triggers the browser permission dialog if state is 'prompt'
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  }, []);

  // ── Connect to OpenAI Realtime via WebRTC ─────────────────────────
  const connect = useCallback(async () => {
    setStatus(STATUS.CONNECTING);
    setError(null);

    try {
      // 1. Request microphone permission first
      let stream;
      try {
        stream = await requestMicPermission();
      } catch (micErr) {
        // Provide user-friendly messages for common permission errors
        const msg = micErr.name === 'NotAllowedError' || micErr.name === 'PermissionDeniedError'
          ? 'Microphone access denied. Please allow microphone permission in your browser settings and try again.'
          : micErr.message;
        throw new Error(msg);
      }
      localStreamRef.current = stream;

      // 2. Get ephemeral token from our server
      const tokenData = await api.getRealtimeToken(agent.id);
      const { token, model } = tokenData;

      // 3. Create RTCPeerConnection
      const pc = new RTCPeerConnection();
      pcRef.current = pc;

      // 4. Handle remote audio track (model's voice)
      pc.ontrack = (e) => {
        if (audioRef.current) {
          audioRef.current.srcObject = e.streams[0];
        }
      };

      // 5. Add local microphone track
      stream.getTracks().forEach(track => pc.addTrack(track, stream));

      // 6. Create data channel for events
      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      dc.onopen = () => {
        setStatus(STATUS.CONNECTED);
        addEvent('system', 'Connected to voice agent');
      };

      dc.onmessage = (e) => {
        try {
          const event = JSON.parse(e.data);
          handleRealtimeEvent(event);
        } catch (err) {
          console.warn('Failed to parse realtime event:', err);
        }
      };

      dc.onclose = () => {
        setStatus(STATUS.DISCONNECTED);
        addEvent('system', 'Disconnected');
      };

      // 7. Create offer and set local description
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      // 8. Send SDP offer to OpenAI and get answer
      const sdpResponse = await fetch(`https://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/sdp'
        },
        body: offer.sdp
      });

      if (!sdpResponse.ok) {
        throw new Error(`WebRTC SDP exchange failed: ${sdpResponse.status}`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

    } catch (err) {
      console.error('Voice connect error:', err);
      setError(err.message);
      setStatus(STATUS.ERROR);
      addEvent('error', err.message);
      cleanup();
    }
  }, [agent.id, addEvent, requestMicPermission]);

  // ── Handle events from the Realtime data channel ──────────────────
  const handleRealtimeEvent = useCallback((event) => {
    const type = event.type;

    if (type === 'input_audio_buffer.speech_started') {
      setStatus(STATUS.LISTENING);
    } else if (type === 'input_audio_buffer.speech_stopped') {
      setStatus(STATUS.CONNECTED);
    } else if (type === 'response.audio.delta') {
      setStatus(STATUS.SPEAKING);
    } else if (type === 'response.audio.done') {
      setStatus(STATUS.CONNECTED);
    } else if (type === 'response.function_call_arguments.done') {
      // Function call completed — handle delegation
      if (event.name === 'delegate') {
        try {
          const args = JSON.parse(event.arguments);
          handleDelegation(event.call_id, args.agent_name, args.task);
        } catch (err) {
          console.error('Failed to parse delegate args:', err);
        }
      }
    } else if (type === 'error') {
      setError(event.error?.message || 'Unknown error');
      addEvent('error', event.error?.message || 'Unknown error');
    }
  }, [addEvent]);

  // ── Handle delegation function calls ──────────────────────────────
  const handleDelegation = useCallback(async (callId, agentName, task) => {
    setStatus(STATUS.DELEGATING);
    setDelegationTarget(agentName);
    addEvent('delegation', `Delegating to ${agentName}: ${task}`);

    // Relay delegation to server via Socket.IO
    if (socket) {
      socket.emit('voice:delegate', {
        agentId: agent.id,
        targetAgentName: agentName,
        task
      });

      // Listen for result
      const handler = (data) => {
        if (data.agentId !== agent.id) return;
        socket.off('voice:delegate:result', handler);

        setDelegationTarget(null);
        setStatus(STATUS.CONNECTED);

        const resultText = data.error
          ? `Error from ${agentName}: ${data.error}`
          : data.result || 'Task completed (no details)';

        addEvent('delegation-result', `${agentName}: ${resultText.slice(0, 200)}`);

        // Send function call output back via data channel
        if (dcRef.current?.readyState === 'open') {
          dcRef.current.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: callId,
              output: resultText.slice(0, 4000)
            }
          }));
          // Trigger the model to respond to the function result
          dcRef.current.send(JSON.stringify({ type: 'response.create' }));
        }
      };
      socket.on('voice:delegate:result', handler);
    }
  }, [agent.id, socket, addEvent]);

  // ── Mute/Unmute ───────────────────────────────────────────────────
  const toggleMute = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = muted; // toggle
      });
      setMuted(!muted);
    }
  }, [muted]);

  // ── Cleanup ───────────────────────────────────────────────────────
  const cleanup = useCallback(() => {
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(t => t.stop());
      localStreamRef.current = null;
    }
    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
  }, []);

  const disconnect = useCallback(() => {
    cleanup();
    setStatus(STATUS.DISCONNECTED);
    addEvent('system', 'Session ended');
  }, [cleanup, addEvent]);

  // Cleanup on unmount
  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const isActive = status !== STATUS.DISCONNECTED && status !== STATUS.ERROR;

  return (
    <div className="flex flex-col h-full">
      {/* Audio element for remote playback */}
      <audio ref={audioRef} autoPlay playsInline />

      {/* Main animation zone */}
      <div className="flex-1 flex flex-col items-center justify-center gap-6 p-8">
        {/* Central orb animation */}
        <div className="relative">
          <div className={`
            w-32 h-32 rounded-full flex items-center justify-center transition-all duration-300
            ${status === STATUS.LISTENING ? 'bg-emerald-500/20 ring-4 ring-emerald-500/40 animate-pulse' : ''}
            ${status === STATUS.SPEAKING ? 'bg-indigo-500/20 ring-4 ring-indigo-500/40' : ''}
            ${status === STATUS.DELEGATING ? 'bg-amber-500/20 ring-4 ring-amber-500/40 animate-pulse' : ''}
            ${status === STATUS.CONNECTING ? 'bg-dark-700 ring-2 ring-dark-500 animate-pulse' : ''}
            ${status === STATUS.CONNECTED ? 'bg-dark-700 ring-2 ring-dark-500' : ''}
            ${status === STATUS.DISCONNECTED ? 'bg-dark-800 ring-2 ring-dark-600' : ''}
            ${status === STATUS.ERROR ? 'bg-red-500/20 ring-2 ring-red-500/40' : ''}
          `}>
            {/* Animated rings when speaking/listening */}
            {status === STATUS.SPEAKING && (
              <>
                <div className="absolute inset-0 rounded-full border-2 border-indigo-500/30 animate-ping" />
                <div className="absolute -inset-3 rounded-full border border-indigo-500/20 animate-ping" style={{ animationDelay: '0.3s' }} />
                <div className="absolute -inset-6 rounded-full border border-indigo-500/10 animate-ping" style={{ animationDelay: '0.6s' }} />
              </>
            )}
            {status === STATUS.LISTENING && (
              <>
                <div className="absolute inset-0 rounded-full border-2 border-emerald-500/30 animate-ping" />
                <div className="absolute -inset-3 rounded-full border border-emerald-500/20 animate-ping" style={{ animationDelay: '0.3s' }} />
              </>
            )}

            {/* Center icon */}
            {status === STATUS.CONNECTING && <Loader2 className="w-10 h-10 text-dark-300 animate-spin" />}
            {status === STATUS.DISCONNECTED && <Mic className="w-10 h-10 text-dark-500" />}
            {status === STATUS.CONNECTED && <Mic className="w-10 h-10 text-dark-300" />}
            {status === STATUS.LISTENING && <Mic className="w-10 h-10 text-emerald-400" />}
            {status === STATUS.SPEAKING && (
              <div className="flex items-center gap-1">
                {[...Array(5)].map((_, i) => (
                  <div
                    key={i}
                    className="w-1.5 bg-indigo-400 rounded-full animate-bounce"
                    style={{
                      height: `${12 + Math.random() * 20}px`,
                      animationDelay: `${i * 0.1}s`,
                      animationDuration: '0.6s'
                    }}
                  />
                ))}
              </div>
            )}
            {status === STATUS.DELEGATING && <Loader2 className="w-10 h-10 text-amber-400 animate-spin" />}
            {status === STATUS.ERROR && <MicOff className="w-10 h-10 text-red-400" />}
          </div>
        </div>

        {/* Status label */}
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
            <p className="text-red-400/70 text-sm mt-1">{error}</p>
          )}
        </div>

        {/* Controls */}
        <div className="flex items-center gap-3">
          {!isActive ? (
            <button
              onClick={connect}
              className="flex items-center gap-2 px-6 py-3 bg-indigo-600 hover:bg-indigo-500 text-white rounded-full transition-colors font-medium"
            >
              <Mic className="w-5 h-5" />
              Start Voice Session
            </button>
          ) : (
            <>
              <button
                onClick={toggleMute}
                className={`p-3 rounded-full transition-colors ${
                  muted
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                }`}
                title={muted ? 'Unmute' : 'Mute'}
              >
                {muted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
              </button>

              <button
                onClick={() => { disconnect(); connect(); }}
                className="p-3 rounded-full bg-dark-700 text-dark-300 hover:bg-dark-600 transition-colors"
                title="Reconnect"
              >
                <RefreshCw className="w-5 h-5" />
              </button>

              <button
                onClick={disconnect}
                className="p-3 rounded-full bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors"
                title="End session"
              >
                <PhoneOff className="w-5 h-5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Event timeline (scrollable) */}
      {events.length > 0 && (
        <div className="border-t border-dark-700 max-h-48 overflow-y-auto px-4 py-2">
          {events.map((evt, i) => (
            <div key={i} className="flex items-start gap-2 py-1 text-xs">
              <span className="text-dark-500 whitespace-nowrap">
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
