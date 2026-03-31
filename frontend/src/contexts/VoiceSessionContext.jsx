import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';

export const STATUS = {
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  LISTENING: 'listening',
  SPEAKING: 'speaking',
  DELEGATING: 'delegating',
  ERROR: 'error',
};

export const STATUS_LABELS = {
  [STATUS.DISCONNECTED]: 'Disconnected',
  [STATUS.CONNECTING]: 'Connecting...',
  [STATUS.CONNECTED]: 'Connected — ready',
  [STATUS.LISTENING]: 'Listening...',
  [STATUS.SPEAKING]: 'Speaking...',
  [STATUS.DELEGATING]: 'Delegating...',
  [STATUS.ERROR]: 'Error',
};

const MANAGEMENT_FUNCTIONS = new Set([
  'assign_project',
  'get_project',
  'list_agents',
  'agent_status',
  'get_available_agent',
  'list_projects',
  'clear_context',
  'rollback',
  'stop_agent',
  'clear_all_chats',
  'clear_all_action_logs',
]);

const DEFAULT_TRANSCRIPTION_MODEL =
  import.meta.env.VITE_OPENAI_REALTIME_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe';

const DEFAULT_TURN_DETECTION = Object.freeze({
  type: 'semantic_vad',
  create_response: true,
  interrupt_response: true,
});

const VoiceSessionContext = createContext(null);

function pushEvent(list, type, text) {
  return [...list.slice(-99), { type, text, time: new Date() }];
}

function buildSessionUpdate(voice, transcriptionModel = DEFAULT_TRANSCRIPTION_MODEL) {
  return {
    type: 'session.update',
    session: {
      modalities: ['audio', 'text'],
      voice,
      input_audio_transcription: {
        model: transcriptionModel,
      },
      turn_detection: {
        ...DEFAULT_TURN_DETECTION,
      },
    },
  };
}

function normalizeFunctionOutput(output) {
  if (typeof output === 'string') {
    return output.slice(0, 4000);
  }

  try {
    return JSON.stringify(output).slice(0, 4000);
  } catch {
    return String(output ?? '').slice(0, 4000);
  }
}

function isAutoplayBlocked(error) {
  const message = String(error?.message || '').toLowerCase();
  return (
    error?.name === 'NotAllowedError'
    || message.includes('autoplay')
    || message.includes('user gesture')
  );
}

export function VoiceSessionProvider({ socket, agents, children }) {
  const [status, setStatus] = useState(STATUS.DISCONNECTED);
  const [activeAgentId, setActiveAgentId] = useState(null);
  const [muted, setMuted] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [error, setError] = useState(null);
  const [delegationTarget, setDelegationTarget] = useState(null);
  const [events, setEvents] = useState([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [currentResponse, setCurrentResponse] = useState('');
  const [currentFunction, setCurrentFunction] = useState('');

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const audioElRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);
  const socketRef = useRef(socket);
  const activeAgentIdRef = useRef(activeAgentId);
  const responseBufferRef = useRef('');
  const transcriptBufferRef = useRef('');

  useEffect(() => {
    socketRef.current = socket;
  }, [socket]);

  useEffect(() => {
    activeAgentIdRef.current = activeAgentId;
  }, [activeAgentId]);

  useEffect(() => {
    if (audioElRef.current) {
      audioElRef.current.muted = speakerOff;
    }
  }, [speakerOff]);

  const addEvent = useCallback((type, text) => {
    setEvents((prev) => pushEvent(prev, type, text));
  }, []);

  const cleanupConnection = useCallback(() => {
    const dc = dcRef.current;
    dcRef.current = null;
    if (dc) {
      dc.onopen = null;
      dc.onclose = null;
      dc.onmessage = null;
      dc.onerror = null;
      try {
        dc.close();
      } catch (err) {
        console.warn('Failed to close data channel cleanly:', err);
      }
    }

    const pc = pcRef.current;
    pcRef.current = null;
    if (pc) {
      pc.ontrack = null;
      pc.onconnectionstatechange = null;
      pc.oniceconnectionstatechange = null;
      try {
        pc.getSenders().forEach((sender) => sender.track?.stop?.());
      } catch (err) {
        console.warn('Failed to stop peer senders cleanly:', err);
      }
      try {
        pc.close();
      } catch (err) {
        console.warn('Failed to close peer connection cleanly:', err);
      }
    }

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop?.());
      remoteStreamRef.current = null;
    }

    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
    }

    responseBufferRef.current = '';
    transcriptBufferRef.current = '';
  }, []);

  const requestMicPermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires a secure connection (HTTPS).');
    }

    if (navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'microphone' });
        if (permission.state === 'denied') {
          throw new Error(
            'Microphone access is blocked. Please allow microphone access for this site, then try again.',
          );
        }
      } catch (err) {
        const message = String(err?.message || '');
        if (message.includes('blocked') || message.includes('allow microphone')) {
          throw err;
        }
      }
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }, []);

  const playRemoteAudio = useCallback(async () => {
    const audio = audioElRef.current;
    const remoteStream = remoteStreamRef.current;
    if (!audio || !remoteStream) {
      return;
    }

    if (audio.srcObject !== remoteStream) {
      audio.srcObject = remoteStream;
    }
    audio.muted = speakerOff;

    try {
      await audio.play();
    } catch (err) {
      console.error('Failed to autoplay remote voice audio:', err);
      if (isAutoplayBlocked(err)) {
        setCurrentFunction('Audio received, but the browser blocked playback. Check that the tab is not muted.');
        addEvent('error', 'Browser autoplay blocked remote voice playback');
      }
    }
  }, [addEvent, speakerOff]);

  const sendFunctionOutput = useCallback((callId, output) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') {
      return;
    }

    dc.send(JSON.stringify({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: normalizeFunctionOutput(output),
      },
    }));
    dc.send(JSON.stringify({ type: 'response.create' }));
  }, []);

  const handleDelegation = useCallback((callId, agentName, task) => {
    setStatus(STATUS.DELEGATING);
    setDelegationTarget(agentName);
    setCurrentFunction(`Delegating to ${agentName}...`);
    addEvent('delegation', `Delegating to ${agentName}: ${task}`);

    const sock = socketRef.current;
    const agentId = activeAgentIdRef.current;
    if (!sock || !agentId) {
      sendFunctionOutput(callId, 'Voice session socket is not connected.');
      return;
    }

    const handler = (data) => {
      if (data.agentId !== agentId) {
        return;
      }

      sock.off('voice:delegate:result', handler);
      setDelegationTarget(null);
      setStatus(STATUS.CONNECTED);

      const resultText = data.error
        ? `Error from ${agentName}: ${data.error}`
        : data.result || 'Task completed.';
      setCurrentFunction(data.error ? `delegate failed: ${data.error}` : `delegated to ${agentName}`);
      addEvent(data.error ? 'error' : 'delegation-result', `${agentName}: ${resultText.slice(0, 200)}`);
      sendFunctionOutput(callId, resultText);
    };

    sock.on('voice:delegate:result', handler);
    sock.emit('voice:delegate', { agentId, targetAgentName: agentName, task });
  }, [addEvent, sendFunctionOutput]);

  const handleAsk = useCallback((callId, agentName, question) => {
    setStatus(STATUS.DELEGATING);
    setDelegationTarget(agentName);
    setCurrentFunction(`Asking ${agentName}...`);
    addEvent('delegation', `Asking ${agentName}: ${question}`);

    const sock = socketRef.current;
    const agentId = activeAgentIdRef.current;
    if (!sock || !agentId) {
      sendFunctionOutput(callId, 'Voice session socket is not connected.');
      return;
    }

    const handler = (data) => {
      if (data.agentId !== agentId) {
        return;
      }

      sock.off('voice:ask:result', handler);
      setDelegationTarget(null);
      setStatus(STATUS.CONNECTED);

      const resultText = data.error
        ? `Error from ${agentName}: ${data.error}`
        : data.result || 'No answer.';
      setCurrentFunction(data.error ? `ask failed: ${data.error}` : `asked ${agentName}`);
      addEvent(data.error ? 'error' : 'delegation-result', `${agentName}: ${resultText.slice(0, 200)}`);
      sendFunctionOutput(callId, resultText);
    };

    sock.on('voice:ask:result', handler);
    sock.emit('voice:ask', { agentId, targetAgentName: agentName, question });
  }, [addEvent, sendFunctionOutput]);

  const handleManagement = useCallback((callId, functionName, args) => {
    setCurrentFunction(`${functionName}...`);
    addEvent('system', `${functionName}(${JSON.stringify(args)})`);

    const sock = socketRef.current;
    const agentId = activeAgentIdRef.current;
    if (!sock || !agentId) {
      sendFunctionOutput(callId, 'Voice session socket is not connected.');
      return;
    }

    const handler = (data) => {
      if (data.agentId !== agentId || data.functionName !== functionName) {
        return;
      }

      sock.off('voice:management:result', handler);

      const resultText = data.error
        ? `Error: ${data.error}`
        : data.result || 'Done.';
      setCurrentFunction(data.error ? `${functionName} failed: ${data.error}` : `${functionName} complete`);
      addEvent(data.error ? 'error' : 'system', `${functionName}: ${String(resultText).slice(0, 200)}`);
      sendFunctionOutput(callId, resultText);
    };

    sock.on('voice:management:result', handler);
    sock.emit('voice:management', { agentId, functionName, args });
  }, [addEvent, sendFunctionOutput]);

  const handleToolCall = useCallback((event) => {
    let args = {};
    try {
      args = JSON.parse(event.arguments || '{}');
    } catch (err) {
      console.error('Failed to parse tool arguments:', err);
      setCurrentFunction('Failed to parse tool arguments.');
      addEvent('error', 'Failed to parse tool arguments from Realtime event');
      sendFunctionOutput(event.call_id, 'Failed to parse tool arguments.');
      return;
    }

    if (event.name === 'delegate') {
      handleDelegation(event.call_id, args.agent_name, args.task);
      return;
    }

    if (event.name === 'ask') {
      handleAsk(event.call_id, args.agent_name, args.question);
      return;
    }

    if (MANAGEMENT_FUNCTIONS.has(event.name)) {
      handleManagement(event.call_id, event.name, args);
      return;
    }

    console.warn('Unknown function call:', event.name);
    addEvent('error', `Unknown tool call: ${event.name}`);
    sendFunctionOutput(event.call_id, `Unknown tool call: ${event.name}`);
  }, [addEvent, handleAsk, handleDelegation, handleManagement, sendFunctionOutput]);

  const handleRealtimeEvent = useCallback((event) => {
    switch (event.type) {
      case 'input_audio_buffer.speech_started':
        setStatus(STATUS.LISTENING);
        setCurrentFunction('Listening...');
        break;

      case 'input_audio_buffer.speech_stopped':
        setStatus(STATUS.CONNECTED);
        setCurrentFunction('Processing speech...');
        break;

      case 'conversation.item.input_audio_transcription.completed':
        transcriptBufferRef.current = event.transcript || '';
        setCurrentTranscript(transcriptBufferRef.current);
        break;

      case 'conversation.item.input_audio_transcription.failed':
        setCurrentFunction(event.error?.message || 'Speech transcription failed.');
        addEvent('error', event.error?.message || 'Speech transcription failed.');
        break;

      case 'response.created':
        responseBufferRef.current = '';
        setCurrentResponse('');
        break;

      case 'response.audio_transcript.delta':
        responseBufferRef.current += event.delta || '';
        setCurrentResponse(responseBufferRef.current);
        break;

      case 'response.audio_transcript.done':
        setCurrentResponse(event.transcript || responseBufferRef.current);
        break;

      case 'response.audio.delta':
      case 'output_audio_buffer.audio_started':
        setStatus(STATUS.SPEAKING);
        setCurrentFunction('Agent speaking...');
        break;

      case 'response.audio.done':
      case 'output_audio_buffer.audio_stopped':
        setStatus(STATUS.CONNECTED);
        setCurrentFunction('Response complete.');
        break;

      case 'response.function_call_arguments.done':
        handleToolCall(event);
        break;

      case 'response.done':
        setDelegationTarget(null);
        break;

      case 'error':
        console.error('Realtime error:', event);
        setError(event.error?.message || event.message || 'Unknown realtime error');
        setStatus(STATUS.ERROR);
        setCurrentFunction(event.error?.message || event.message || 'Unknown realtime error');
        addEvent('error', event.error?.message || event.message || 'Unknown realtime error');
        break;

      default:
        break;
    }
  }, [addEvent, handleToolCall]);

  const connect = useCallback(async (agentId) => {
    if (!agentId) {
      return;
    }

    if (activeAgentIdRef.current === agentId && pcRef.current) {
      return;
    }

    cleanupConnection();
    setEvents([]);
    setError(null);
    setDelegationTarget(null);
    setCurrentTranscript('');
    setCurrentResponse('');
    setCurrentFunction('Requesting microphone access...');
    setMuted(false);
    setStatus(STATUS.CONNECTING);
    setActiveAgentId(agentId);
    activeAgentIdRef.current = agentId;

    try {
      let stream;
      try {
        stream = await requestMicPermission();
      } catch (micErr) {
        const message =
          micErr?.name === 'NotAllowedError' || micErr?.name === 'PermissionDeniedError'
            ? 'Microphone access denied. Please allow microphone permission in your browser settings and try again.'
            : micErr.message;
        throw new Error(message);
      }

      localStreamRef.current = stream;

      const microphoneTrack = stream.getAudioTracks()[0];
      if (!microphoneTrack) {
        throw new Error('No microphone track is available.');
      }
      if (microphoneTrack.readyState !== 'live') {
        throw new Error('Microphone is not active.');
      }

      microphoneTrack.onended = () => {
        setStatus(STATUS.ERROR);
        setError('Microphone disconnected.');
        setCurrentFunction('Microphone disconnected.');
        addEvent('error', 'Microphone disconnected');
      };

      const {
        token,
        model,
        voice = 'alloy',
        transcriptionModel = DEFAULT_TRANSCRIPTION_MODEL,
      } = await api.getRealtimeToken(agentId);

      if (!token) {
        throw new Error('Realtime token was not returned by the server.');
      }

      const pc = new RTCPeerConnection();
      const remoteStream = new MediaStream();

      pcRef.current = pc;
      remoteStreamRef.current = remoteStream;

      pc.ontrack = (event) => {
        if (pcRef.current !== pc) {
          return;
        }

        const incomingStream = event.streams?.[0];
        if (incomingStream) {
          incomingStream.getTracks().forEach((track) => {
            if (!remoteStream.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
              remoteStream.addTrack(track);
            }
          });
        } else if (event.track && !remoteStream.getTracks().some((track) => track.id === event.track.id)) {
          remoteStream.addTrack(event.track);
        }

        if (event.track) {
          event.track.onunmute = () => {
            playRemoteAudio().catch((err) => {
              console.error('Failed to play remote audio after unmute:', err);
            });
          };
        }

        playRemoteAudio().catch((err) => {
          console.error('Failed to attach remote audio stream:', err);
        });
      };

      pc.onconnectionstatechange = () => {
        if (pcRef.current !== pc) {
          return;
        }

        if (pc.connectionState === 'failed') {
          setStatus(STATUS.ERROR);
          setError('Peer connection failed.');
          setCurrentFunction('Peer connection failed.');
          addEvent('error', 'Peer connection failed');
        } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
          setStatus(STATUS.DISCONNECTED);
          setCurrentFunction('Disconnected.');
          setActiveAgentId(null);
          activeAgentIdRef.current = null;
          addEvent('system', 'Voice session disconnected');
        }
      };

      pc.oniceconnectionstatechange = () => {
        if (pcRef.current !== pc) {
          return;
        }

        if (pc.iceConnectionState === 'failed') {
          setStatus(STATUS.ERROR);
          setError('ICE connection failed.');
          setCurrentFunction('ICE connection failed.');
          addEvent('error', 'ICE connection failed');
        }
      };

      stream.getTracks().forEach((track) => pc.addTrack(track, stream));

      const dc = pc.createDataChannel('oai-events');
      dcRef.current = dc;

      const applySessionUpdate = () => {
        if (dcRef.current !== dc || dc.readyState !== 'open') {
          return;
        }

        dc.send(JSON.stringify(buildSessionUpdate(voice, transcriptionModel)));
        setStatus(STATUS.CONNECTED);
        setError(null);
        setCurrentFunction(muted ? 'Microphone muted.' : 'Listening...');
      };

      dc.onopen = () => {
        if (dcRef.current !== dc) {
          return;
        }

        addEvent('system', 'Connected to voice agent');
        applySessionUpdate();
      };

      dc.onmessage = (messageEvent) => {
        if (dcRef.current !== dc) {
          return;
        }

        try {
          handleRealtimeEvent(JSON.parse(messageEvent.data));
        } catch (err) {
          console.warn('Failed to parse realtime event:', err);
        }
      };

      dc.onclose = () => {
        if (dcRef.current !== dc) {
          return;
        }

        setStatus(STATUS.DISCONNECTED);
        setCurrentFunction('Disconnected.');
        setActiveAgentId(null);
        activeAgentIdRef.current = null;
        addEvent('system', 'Voice session disconnected');
      };

      dc.onerror = (channelError) => {
        console.error('Realtime data channel error:', channelError);
        if (dcRef.current !== dc) {
          return;
        }

        setStatus(STATUS.ERROR);
        setError('Realtime data channel error.');
        setCurrentFunction('Realtime data channel error.');
        addEvent('error', 'Realtime data channel error');
      };

      setCurrentFunction('Microphone connected. Finishing realtime setup...');

      const offer = await pc.createOffer({ offerToReceiveAudio: true });
      await pc.setLocalDescription(offer);

      const realtimeBaseUrl =
        import.meta.env.VITE_OPENAI_REALTIME_URL || 'https://api.openai.com/v1/realtime/calls';
      const sdpResponse = await fetch(
        `${realtimeBaseUrl}?model=${encodeURIComponent(model || 'gpt-realtime-1.5')}`,
        {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/sdp',
          },
        },
      );

      if (!sdpResponse.ok) {
        const errorBody = await sdpResponse.text().catch(() => '');
        console.error('Realtime SDP error body:', errorBody);
        throw new Error(`Realtime SDP exchange failed (${sdpResponse.status}): ${errorBody}`);
      }

      const answerSdp = await sdpResponse.text();
      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

      if (dc.readyState === 'open') {
        applySessionUpdate();
      }
    } catch (err) {
      console.error('Voice connection error:', err);
      cleanupConnection();
      setStatus(STATUS.ERROR);
      setError(err.message || 'Voice connection failed.');
      setCurrentFunction(err.message || 'Voice connection failed.');
      setCurrentTranscript('');
      setCurrentResponse('');
      setActiveAgentId(null);
      activeAgentIdRef.current = null;
      addEvent('error', err.message || 'Voice connection failed.');
      throw err;
    }
  }, [addEvent, cleanupConnection, handleRealtimeEvent, muted, playRemoteAudio, requestMicPermission]);

  const disconnect = useCallback(() => {
    cleanupConnection();
    setStatus(STATUS.DISCONNECTED);
    setActiveAgentId(null);
    activeAgentIdRef.current = null;
    setMuted(false);
    setError(null);
    setDelegationTarget(null);
    setCurrentTranscript('');
    setCurrentResponse('');
    setCurrentFunction('');
    addEvent('system', 'Session ended');
  }, [addEvent, cleanupConnection]);

  const reconnect = useCallback(() => {
    const agentId = activeAgentIdRef.current;
    if (!agentId) {
      return;
    }

    cleanupConnection();
    setStatus(STATUS.DISCONNECTED);
    setError(null);
    setDelegationTarget(null);
    setCurrentTranscript('');
    setCurrentResponse('');
    setCurrentFunction('');
    setEvents([]);
    setMuted(false);

    setTimeout(() => {
      connect(agentId).catch((err) => {
        console.error('Voice reconnect failed:', err);
      });
    }, 100);
  }, [cleanupConnection, connect]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) {
      return;
    }

    setMuted((prev) => {
      const nextMuted = !prev;
      localStreamRef.current?.getAudioTracks().forEach((track) => {
        track.enabled = !nextMuted;
      });
      setCurrentFunction(nextMuted ? 'Microphone muted.' : 'Listening...');
      return nextMuted;
    });
  }, []);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOff((prev) => {
      const nextSpeakerOff = !prev;
      if (audioElRef.current) {
        audioElRef.current.muted = nextSpeakerOff;
      }
      return nextSpeakerOff;
    });
  }, []);

  useEffect(() => {
    if (!activeAgentId || !agents) {
      return;
    }

    const activeAgent = agents.find((agent) => agent.id === activeAgentId);
    if (!activeAgent || activeAgent.isVoice !== true) {
      disconnect();
    }
  }, [activeAgentId, agents, disconnect]);

  useEffect(() => {
    if (socket || !activeAgentId) {
      return;
    }

    cleanupConnection();
    setStatus(STATUS.DISCONNECTED);
    setActiveAgentId(null);
    activeAgentIdRef.current = null;
    setMuted(false);
    setError(null);
    setDelegationTarget(null);
    setCurrentTranscript('');
    setCurrentResponse('');
    setCurrentFunction('');
  }, [activeAgentId, cleanupConnection, socket]);

  useEffect(() => {
    return () => {
      cleanupConnection();
    };
  }, [cleanupConnection]);

  const isActive = status !== STATUS.DISCONNECTED && status !== STATUS.ERROR;

  const isSessionForAgent = useCallback(
    (agentId) => activeAgentId === agentId,
    [activeAgentId],
  );

  const value = useMemo(() => ({
    status,
    activeAgentId,
    agentId: activeAgentId,
    muted,
    isMuted: muted,
    speakerOff,
    error,
    delegationTarget,
    events,
    currentTranscript,
    currentResponse,
    currentFunction,
    connect,
    disconnect,
    reconnect,
    toggleMute,
    toggleSpeaker,
    isActive,
    isConnected: status !== STATUS.DISCONNECTED && status !== STATUS.ERROR && status !== STATUS.CONNECTING,
    isSessionForAgent,
  }), [
    status,
    activeAgentId,
    muted,
    speakerOff,
    error,
    delegationTarget,
    events,
    currentTranscript,
    currentResponse,
    currentFunction,
    connect,
    disconnect,
    reconnect,
    toggleMute,
    toggleSpeaker,
    isActive,
    isSessionForAgent,
  ]);

  return (
    <VoiceSessionContext.Provider value={value}>
      <audio ref={audioElRef} autoPlay playsInline muted={speakerOff} style={{ display: 'none' }} />
      {children}
    </VoiceSessionContext.Provider>
  );
}

export function useVoiceSession() {
  const context = useContext(VoiceSessionContext);
  if (!context) {
    throw new Error('useVoiceSession must be used within VoiceSessionProvider');
  }
  return context;
}