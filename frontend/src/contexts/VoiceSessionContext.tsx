import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { api } from '../api';
import type { Agent } from '../types';
import { WsEvents } from '../socketEvents';
import { errorMessage, errorName } from '../utils/errors';

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

// Delegate/ask run a full agent task server-side, which can legitimately take
// minutes — keep this generous so we don't drop a genuine late result.
const DELEGATE_RESULT_TIMEOUT_MS = 10 * 60 * 1000;
const MANAGEMENT_RESULT_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * One line of the session log rendered by VoiceChatTab. UI-LOCAL: assembled by
 * pushEvent below, never sent by the API. `time` is a live Date object, not an
 * ISO string — VoiceChatTab calls `evt.time.toLocaleTimeString()` on it.
 */
interface VoiceSessionEvent {
  /** 'system' | 'error' | 'delegation' | 'delegation-result' at the call sites;
   *  the renderer keys four class names off it and ignores anything else, so it
   *  stays a plain string. */
  type: string;
  text: string;
  time: Date;
}

/** Options of resetSessionState — every field falls back to the value the
 *  disconnect path uses, so `{}` is a full reset. */
interface ResetSessionOptions {
  status?: string;
  error?: string | null;
  message?: string;
  clearEvents?: boolean;
  keepAgent?: boolean;
  keepMuted?: boolean;
}

/**
 * Fields shared by the three voice result frames the API emits
 * (api/src/ws/socketHandler.ts:443, :508, :583). `error` and `result` are always
 * both present, one of them null.
 */
interface VoiceResultBase {
  /** The VOICE agent's id, not the target's — what the handler filters on. */
  agentId: string;
  error: string | null;
}

/** voice:delegate:result and voice:ask:result — `result` is the target agent's
 *  reply text (agentManager.sendMessage), null whenever `error` is set. */
interface VoiceAgentResult extends VoiceResultBase {
  targetAgentName?: string;
  result: string | null;
}

/** voice:management:result — `result` is whatever the management tool returned,
 *  so it is only ever stringified, never read as text. */
interface VoiceManagementResult extends VoiceResultBase {
  functionName?: string;
  result: unknown;
}

/** Options of awaitVoiceResult, generic over which of the two result frames the
 *  caller subscribed to. */
interface AwaitVoiceResultOptions<T extends VoiceResultBase> {
  /** See RealtimeEvent.call_id — absent on a frame that carried none. */
  callId: string | undefined;
  resEvent: string;
  reqEvent: string;
  /** Merged into the emitted request next to `agentId`. */
  payload: Record<string, unknown>;
  timeoutMs: number;
  /** Extra filter on top of the agentId match; accept-all by default. */
  matches?: (data: T) => boolean;
  onResult: (data: T) => void;
  onTimeout: () => void;
}

/**
 * One OpenAI Realtime server event, as it arrives JSON-parsed off the data
 * channel. Every field is optional because the wire carries a dozen event
 * shapes under one `type` discriminant and this handler reads across them; the
 * switch below is what decides which fields a given frame actually has.
 */
interface RealtimeEvent {
  type?: string;
  /** transcription.completed / audio_transcript.done */
  transcript?: string;
  /** audio_transcript.delta */
  delta?: string;
  /** 'error' frames put the text here or under `error`. */
  message?: string;
  error?: { message?: string };
  /** response.function_call_arguments.done only. */
  name?: string;
  call_id?: string;
  /** JSON text — parsed at the call site. */
  arguments?: string;
}

/** What useVoiceSession() hands to VoiceChatTab and ActiveVoiceIndicator. */
interface VoiceSessionValue {
  /** One of the STATUS values above; that object is a plain string map. */
  status: string;
  activeAgentId: string | null;
  muted: boolean;
  speakerOff: boolean;
  error: string | null;
  /** Name of the agent a delegate/ask is waiting on. */
  delegationTarget: string | null;
  events: VoiceSessionEvent[];
  currentTranscript: string;
  currentResponse: string;
  currentFunction: string;
  connect: (agentId: string) => Promise<void>;
  disconnect: () => void;
  reconnect: () => void;
  toggleMute: () => void;
  toggleSpeaker: () => void;
  isActive: boolean;
  isSessionForAgent: (agentId: string) => boolean;
}

// null outside a provider — useVoiceSession() throws on that case rather than
// letting a consumer read through it.
const VoiceSessionContext = createContext<VoiceSessionValue | null>(null);

function pushEvent(list: VoiceSessionEvent[], type: string, text: string): VoiceSessionEvent[] {
  return [...list.slice(-99), { type, text, time: new Date() }];
}

function buildSessionUpdate(
  voice: string,
  transcriptionModel: string = DEFAULT_TRANSCRIPTION_MODEL
) {
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

// The Realtime function_call_output is a string, but the value we get handed is
// whatever the server put in `result` — a tool payload, an error text, or null.
function normalizeFunctionOutput(output: unknown) {
  if (typeof output === 'string') {
    return output.slice(0, 4000);
  }

  try {
    return JSON.stringify(output).slice(0, 4000);
  } catch {
    return String(output ?? '').slice(0, 4000);
  }
}

// `error` is whatever audio.play() rejected with — a DOMException in practice,
// but a rejection carries no type. Both fields are read through `in`, which
// keeps the exact `error?.field` semantics for a non-object.
function isAutoplayBlocked(error: unknown): boolean {
  const name =
    typeof error === 'object' && error !== null && 'name' in error ? error.name : undefined;
  const rawMessage =
    typeof error === 'object' && error !== null && 'message' in error ? error.message : undefined;
  const message = String(rawMessage || '').toLowerCase();
  return (
    name === 'NotAllowedError' || message.includes('autoplay') || message.includes('user gesture')
  );
}

interface VoiceSessionProviderProps {
  /** The live socket.io client, or null before login / after logout — App
   *  passes getSocket() straight through. */
  socket: Socket | null;
  /** The agents list App owns; only id and isVoice are read here. */
  agents: Agent[];
  children: ReactNode;
}

export function VoiceSessionProvider({ socket, agents, children }: VoiceSessionProviderProps) {
  const [status, setStatus] = useState(STATUS.DISCONNECTED);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [speakerOff, setSpeakerOff] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [delegationTarget, setDelegationTarget] = useState<string | null>(null);
  const [events, setEvents] = useState<VoiceSessionEvent[]>([]);
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [currentResponse, setCurrentResponse] = useState('');
  const [currentFunction, setCurrentFunction] = useState('');

  // WebRTC / DOM / timer handles — nothing here is a domain shape.
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const audioElRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const socketRef = useRef<Socket | null>(socket);
  const activeAgentIdRef = useRef<string | null>(activeAgentId);
  const responseBufferRef = useRef('');
  const transcriptBufferRef = useRef('');
  // Typed so the cleanup pass below survives strictFunctionTypes: an
  // untyped `new Set()` is a Set<unknown>, and its forEach callback cannot
  // destructure these fields.
  type PendingResult = {
    sock: Socket;
    event: string;
    handler: ((data: any) => void) | null;
    timer: ReturnType<typeof setTimeout> | null;
  };
  const pendingResultsRef = useRef(new Set<PendingResult>());
  const connectSeqRef = useRef(0);

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

  const addEvent = useCallback((type: string, text: string) => {
    setEvents(prev => pushEvent(prev, type, text));
  }, []);

  const cleanupConnection = useCallback(() => {
    connectSeqRef.current += 1;

    pendingResultsRef.current.forEach(({ sock, event, handler, timer }) => {
      // `?? undefined` only satisfies the DOM/socket.io signatures: both calls
      // are no-ops for null and for undefined alike, and in practice neither
      // field is ever null on a record that reached this Set.
      clearTimeout(timer ?? undefined);
      sock.off(event, handler ?? undefined);
    });
    pendingResultsRef.current.clear();

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
        pc.getSenders().forEach(sender => sender.track?.stop?.());
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
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach(track => track.stop?.());
      remoteStreamRef.current = null;
    }

    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.srcObject = null;
    }

    responseBufferRef.current = '';
    transcriptBufferRef.current = '';
  }, []);

  // Resets the per-session UI state. The deliberate differences between the
  // four call sites are explicit options instead of omissions:
  // - keepAgent: reconnect keeps activeAgentId for its delayed re-connect
  // - keepMuted: a failed connect must not undo a mute toggled mid-setup
  // - clearEvents: only reconnect wipes the event log
  const resetSessionState = useCallback(
    ({
      status = STATUS.DISCONNECTED,
      error = null,
      message = '',
      clearEvents = false,
      keepAgent = false,
      keepMuted = false,
    }: ResetSessionOptions = {}) => {
      setStatus(status);
      setError(error);
      setDelegationTarget(null);
      setCurrentTranscript('');
      setCurrentResponse('');
      setCurrentFunction(message);
      if (!keepMuted) setMuted(false);
      if (!keepAgent) {
        setActiveAgentId(null);
        activeAgentIdRef.current = null;
      }
      if (clearEvents) setEvents([]);
    },
    []
  );

  const requestMicPermission = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone access requires a secure connection (HTTPS).');
    }

    if (navigator.permissions?.query) {
      try {
        const permission = await navigator.permissions.query({ name: 'microphone' });
        if (permission.state === 'denied') {
          throw new Error(
            'Microphone access is blocked. Please allow microphone access for this site, then try again.'
          );
        }
      } catch (err) {
        const message = errorMessage(err);
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
        setCurrentFunction(
          'Audio received, but the browser blocked playback. Check that the tab is not muted.'
        );
        addEvent('error', 'Browser autoplay blocked remote voice playback');
      }
    }
  }, [addEvent, speakerOff]);

  // `callId` mirrors RealtimeEvent.call_id: an absent one drops the key from the
  // item, which is what JSON.stringify already did with the untyped value.
  const sendFunctionOutput = useCallback((callId: string | undefined, output: unknown) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') {
      return;
    }

    dc.send(
      JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: normalizeFunctionOutput(output),
        },
      })
    );
    dc.send(JSON.stringify({ type: 'response.create' }));
  }, []);

  // Shared machinery for the delegate/ask/management flows: registers a
  // result handler filtered by agentId (+ an optional extra `matches`
  // predicate), arms a timeout that ignores stale agents, and tracks the
  // pending record so cleanupConnection can settle it. The pending record
  // must keep the { sock, event, handler, timer } shape — cleanupConnection
  // destructures exactly those fields. onResult/onTimeout carry the
  // flow-specific status updates and messages.
  const awaitVoiceResult = useCallback(
    <T extends VoiceResultBase>({
      callId,
      resEvent,
      reqEvent,
      payload,
      timeoutMs,
      matches = (_data): boolean => true,
      onResult,
      onTimeout,
    }: AwaitVoiceResultOptions<T>) => {
      const sock = socketRef.current;
      const agentId = activeAgentIdRef.current;
      if (!sock || !agentId) {
        sendFunctionOutput(callId, 'Voice session socket is not connected.');
        return;
      }

      const pending: PendingResult = { sock, event: resEvent, handler: null, timer: null };
      const settle = () => {
        // Same `?? undefined` note as cleanupConnection: both are no-ops either
        // way, and settle only ever runs after both fields are assigned.
        clearTimeout(pending.timer ?? undefined);
        sock.off(pending.event, pending.handler ?? undefined);
        pendingResultsRef.current.delete(pending);
      };

      pending.handler = (data: T) => {
        if (data.agentId !== agentId || !matches(data)) {
          return;
        }

        settle();
        onResult(data);
      };

      pending.timer = setTimeout(() => {
        settle();
        if (activeAgentIdRef.current !== agentId) {
          return;
        }

        onTimeout();
      }, timeoutMs);
      pendingResultsRef.current.add(pending);

      sock.on(resEvent, pending.handler);
      sock.emit(reqEvent, { agentId, ...payload });
    },
    [sendFunctionOutput]
  );

  const handleDelegation = useCallback(
    (callId: string | undefined, agentName: string, task: string) => {
      if (!agentName || !task) {
        // The server silently ignores requests with missing fields — answer the
        // model directly instead of waiting on a result that will never come.
        sendFunctionOutput(callId, 'Missing agent_name or task for delegate.');
        return;
      }

      setStatus(STATUS.DELEGATING);
      setDelegationTarget(agentName);
      setCurrentFunction(`Delegating to ${agentName}...`);
      addEvent('delegation', `Delegating to ${agentName}: ${task}`);

      awaitVoiceResult<VoiceAgentResult>({
        callId,
        resEvent: WsEvents.VOICE_DELEGATE_RESULT,
        reqEvent: WsEvents.REQ_VOICE_DELEGATE,
        payload: { targetAgentName: agentName, task },
        timeoutMs: DELEGATE_RESULT_TIMEOUT_MS,
        onResult: data => {
          setDelegationTarget(null);
          setStatus(STATUS.CONNECTED);

          const resultText = data.error
            ? `Error from ${agentName}: ${data.error}`
            : data.result || 'Task completed.';
          setCurrentFunction(
            data.error ? `delegate failed: ${data.error}` : `delegated to ${agentName}`
          );
          addEvent(
            data.error ? 'error' : 'delegation-result',
            `${agentName}: ${resultText.slice(0, 200)}`
          );
          sendFunctionOutput(callId, resultText);
        },
        onTimeout: () => {
          setDelegationTarget(null);
          setStatus(prev => (prev === STATUS.DELEGATING ? STATUS.CONNECTED : prev));
          setCurrentFunction(`delegate to ${agentName} timed out`);
          addEvent('error', `Timed out waiting for delegate result from ${agentName}`);
          sendFunctionOutput(callId, `Timed out waiting for ${agentName} to report a result.`);
        },
      });
    },
    [addEvent, awaitVoiceResult, sendFunctionOutput]
  );

  const handleAsk = useCallback(
    (callId: string | undefined, agentName: string, question: string) => {
      if (!agentName || !question) {
        // The server silently ignores requests with missing fields — answer the
        // model directly instead of waiting on a result that will never come.
        sendFunctionOutput(callId, 'Missing agent_name or question for ask.');
        return;
      }

      setStatus(STATUS.DELEGATING);
      setDelegationTarget(agentName);
      setCurrentFunction(`Asking ${agentName}...`);
      addEvent('delegation', `Asking ${agentName}: ${question}`);

      awaitVoiceResult<VoiceAgentResult>({
        callId,
        resEvent: WsEvents.VOICE_ASK_RESULT,
        reqEvent: WsEvents.REQ_VOICE_ASK,
        payload: { targetAgentName: agentName, question },
        timeoutMs: DELEGATE_RESULT_TIMEOUT_MS,
        onResult: data => {
          setDelegationTarget(null);
          setStatus(STATUS.CONNECTED);

          const resultText = data.error
            ? `Error from ${agentName}: ${data.error}`
            : data.result || 'No answer.';
          setCurrentFunction(data.error ? `ask failed: ${data.error}` : `asked ${agentName}`);
          addEvent(
            data.error ? 'error' : 'delegation-result',
            `${agentName}: ${resultText.slice(0, 200)}`
          );
          sendFunctionOutput(callId, resultText);
        },
        onTimeout: () => {
          setDelegationTarget(null);
          setStatus(prev => (prev === STATUS.DELEGATING ? STATUS.CONNECTED : prev));
          setCurrentFunction(`ask ${agentName} timed out`);
          addEvent('error', `Timed out waiting for answer from ${agentName}`);
          sendFunctionOutput(callId, `Timed out waiting for ${agentName} to answer.`);
        },
      });
    },
    [addEvent, awaitVoiceResult, sendFunctionOutput]
  );

  const handleManagement = useCallback(
    (callId: string | undefined, functionName: string, args: Record<string, unknown>) => {
      setCurrentFunction(`${functionName}...`);
      addEvent('system', `${functionName}(${JSON.stringify(args)})`);

      awaitVoiceResult<VoiceManagementResult>({
        callId,
        resEvent: WsEvents.VOICE_MANAGEMENT_RESULT,
        reqEvent: WsEvents.REQ_VOICE_MANAGEMENT,
        payload: { functionName, args },
        timeoutMs: MANAGEMENT_RESULT_TIMEOUT_MS,
        matches: data => data.functionName === functionName,
        onResult: data => {
          const resultText = data.error ? `Error: ${data.error}` : data.result || 'Done.';
          setCurrentFunction(
            data.error ? `${functionName} failed: ${data.error}` : `${functionName} complete`
          );
          addEvent(
            data.error ? 'error' : 'system',
            `${functionName}: ${String(resultText).slice(0, 200)}`
          );
          sendFunctionOutput(callId, resultText);
        },
        onTimeout: () => {
          setCurrentFunction(`${functionName} timed out`);
          addEvent('error', `Timed out waiting for ${functionName} result`);
          sendFunctionOutput(callId, `Timed out waiting for ${functionName} result.`);
        },
      });
    },
    [addEvent, awaitVoiceResult, sendFunctionOutput]
  );

  const handleToolCall = useCallback(
    (event: RealtimeEvent) => {
      let args: Record<string, any> = {};
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

      // The `!== undefined` guard is a no-op at runtime — a Set of strings never
      // holds undefined — and is what lets `name` narrow to string below.
      if (event.name !== undefined && MANAGEMENT_FUNCTIONS.has(event.name)) {
        handleManagement(event.call_id, event.name, args);
        return;
      }

      console.warn('Unknown function call:', event.name);
      addEvent('error', `Unknown tool call: ${event.name}`);
      sendFunctionOutput(event.call_id, `Unknown tool call: ${event.name}`);
    },
    [addEvent, handleAsk, handleDelegation, handleManagement, sendFunctionOutput]
  );

  const handleRealtimeEvent = useCallback(
    (event: RealtimeEvent) => {
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
    },
    [addEvent, handleToolCall]
  );

  const connect = useCallback(
    async (agentId: string) => {
      if (!agentId) {
        return;
      }

      if (activeAgentIdRef.current === agentId && pcRef.current) {
        return;
      }

      cleanupConnection();
      // Invalidated by any later connect()/cleanupConnection() — a stale
      // in-flight connect must not assign refs or mutate session state.
      const seq = ++connectSeqRef.current;
      const isStale = () => connectSeqRef.current !== seq;

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
            errorName(micErr) === 'NotAllowedError' || errorName(micErr) === 'PermissionDeniedError'
              ? 'Microphone access denied. Please allow microphone permission in your browser settings and try again.'
              : errorMessage(micErr);
          throw new Error(message);
        }

        if (isStale()) {
          stream.getTracks().forEach(track => track.stop());
          return;
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
          model: _model,
          voice = 'alloy',
          transcriptionModel = DEFAULT_TRANSCRIPTION_MODEL,
          session: sessionConfig,
        } = await api.getRealtimeToken(agentId);

        if (isStale()) {
          return;
        }

        if (!token) {
          throw new Error('Realtime token was not returned by the server.');
        }

        const pc = new RTCPeerConnection();
        const remoteStream = new MediaStream();

        pcRef.current = pc;
        remoteStreamRef.current = remoteStream;

        pc.ontrack = event => {
          if (pcRef.current !== pc) {
            return;
          }

          const incomingStream = event.streams?.[0];
          if (incomingStream) {
            incomingStream.getTracks().forEach(track => {
              if (!remoteStream.getTracks().some(existingTrack => existingTrack.id === track.id)) {
                remoteStream.addTrack(track);
              }
            });
          } else if (
            event.track &&
            !remoteStream.getTracks().some(track => track.id === event.track.id)
          ) {
            remoteStream.addTrack(event.track);
          }

          if (event.track) {
            event.track.onunmute = () => {
              playRemoteAudio().catch(err => {
                console.error('Failed to play remote audio after unmute:', err);
              });
            };
          }

          playRemoteAudio().catch(err => {
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

        stream.getTracks().forEach(track => pc.addTrack(track, stream));

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

        dc.onmessage = messageEvent => {
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

        dc.onerror = channelError => {
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

        if (isStale()) {
          return;
        }

        const realtimeBaseUrl =
          import.meta.env.VITE_OPENAI_REALTIME_URL || 'https://api.openai.com/v1/realtime/calls';
        const fd = new FormData();
        // RTCSessionDescriptionInit.sdp is optional in the DOM types (createOffer
        // always fills it in practice). String() keeps the exact current
        // behaviour — FormData already stringifies its value, so an absent sdp
        // was, and still is, sent as the literal 'undefined'.
        fd.set('sdp', String(offer.sdp));
        fd.set('session', JSON.stringify(sessionConfig));
        const sdpResponse = await fetch(realtimeBaseUrl, {
          method: 'POST',
          body: fd,
          headers: {
            Authorization: `Bearer ${token}`,
          },
          signal: AbortSignal.timeout(30000),
        });

        if (isStale()) {
          return;
        }

        if (!sdpResponse.ok) {
          const errorBody = await sdpResponse.text().catch(() => '');
          console.error('Realtime SDP error body:', errorBody);
          throw new Error(`Realtime SDP exchange failed (${sdpResponse.status}): ${errorBody}`);
        }

        const answerSdp = await sdpResponse.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });

        if (isStale()) {
          return;
        }

        if (dc.readyState === 'open') {
          applySessionUpdate();
        }
      } catch (err) {
        console.error('Voice connection error:', err);
        if (isStale()) {
          return;
        }

        cleanupConnection();
        const message = errorMessage(err) || 'Voice connection failed.';
        resetSessionState({ status: STATUS.ERROR, error: message, message, keepMuted: true });
        addEvent('error', message);
        throw err;
      }
    },
    [
      addEvent,
      cleanupConnection,
      handleRealtimeEvent,
      muted,
      playRemoteAudio,
      requestMicPermission,
      resetSessionState,
    ]
  );

  const disconnect = useCallback(() => {
    cleanupConnection();
    resetSessionState();
    addEvent('system', 'Session ended');
  }, [addEvent, cleanupConnection, resetSessionState]);

  const reconnect = useCallback(() => {
    const agentId = activeAgentIdRef.current;
    if (!agentId) {
      return;
    }

    cleanupConnection();
    resetSessionState({ keepAgent: true, clearEvents: true });

    setTimeout(() => {
      connect(agentId).catch(err => {
        console.error('Voice reconnect failed:', err);
      });
    }, 100);
  }, [cleanupConnection, connect, resetSessionState]);

  const toggleMute = useCallback(() => {
    if (!localStreamRef.current) {
      return;
    }

    setMuted(prev => {
      const nextMuted = !prev;
      localStreamRef.current?.getAudioTracks().forEach(track => {
        track.enabled = !nextMuted;
      });
      setCurrentFunction(nextMuted ? 'Microphone muted.' : 'Listening...');
      return nextMuted;
    });
  }, []);

  const toggleSpeaker = useCallback(() => {
    setSpeakerOff(prev => {
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

    const activeAgent = agents.find(agent => agent.id === activeAgentId);
    if (!activeAgent || activeAgent.isVoice !== true) {
      disconnect();
    }
  }, [activeAgentId, agents, disconnect]);

  useEffect(() => {
    if (socket || !activeAgentId) {
      return;
    }

    cleanupConnection();
    resetSessionState();
  }, [activeAgentId, cleanupConnection, resetSessionState, socket]);

  useEffect(() => {
    return () => {
      cleanupConnection();
    };
  }, [cleanupConnection]);

  const isActive = status !== STATUS.DISCONNECTED && status !== STATUS.ERROR;

  const isSessionForAgent = useCallback(
    (agentId: string) => activeAgentId === agentId,
    [activeAgentId]
  );

  const value = useMemo(
    () => ({
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
    }),
    [
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
    ]
  );

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
