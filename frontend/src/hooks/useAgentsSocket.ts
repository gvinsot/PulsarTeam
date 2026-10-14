import { useState, useEffect, useCallback, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { connectSocket, getSocket } from '../socket';
import { WsEvents } from '../socketEvents';
import type { Agent, ShowToastFn } from '../types';
import { createChatStreamLifecycle } from './chatStreamLifecycle';

const SOCKET_EVENTS = [
  WsEvents.AGENTS_LIST,
  WsEvents.AGENT_CREATED,
  WsEvents.AGENT_UPDATED,
  WsEvents.AGENT_DELETED,
  WsEvents.AGENT_STATUS,
  WsEvents.AGENT_THINKING,
  WsEvents.STREAM_START,
  WsEvents.STREAM_CHUNK,
  WsEvents.STREAM_END,
  WsEvents.STREAM_ERROR,
  WsEvents.STREAM_RESUME,
  WsEvents.AGENT_ERROR_REPORT,
  WsEvents.AGENT_HANDOFF,
];

// Returns `obj` unchanged (same reference — lets React bail out of the
// re-render) when the key is absent, otherwise a copy without it.
function withoutKey<T extends Record<string, unknown>>(obj: T, key: string): T {
  if (!(key in obj)) return obj;
  const copy = { ...obj };
  delete copy[key];
  return copy;
}

// Owns the agents/stream socket protocol: the agents list, per-agent
// thinking state and stream buffers, and the STREAM_START/CHUNK/END/RESUME/
// ERROR choreography. App keeps auth/session lifecycle and calls
// initSocket/teardown.
export function useAgentsSocket(showToastRef: MutableRefObject<ShowToastFn>) {
  // Socket snapshots are list projections; the open chat fetches its history.
  const [agents, setAgents] = useState<Agent[]>([]);
  // agentId → the agent's current thinking text (agent:thinking payload).
  const [thinkingMap, setThinkingMap] = useState<Record<string, string>>({});
  // agentId → the streamed response accumulated so far.
  const [streamBuffers, setStreamBuffers] = useState<Record<string, string>>({});
  const streamLifecycle = useRef<ReturnType<typeof createChatStreamLifecycle> | null>(null);
  const lastAgentJson = useRef(new Map<string, string>()); // Dedup: last JSON per agentId

  // Safety: clear stale thinking state for agents that are no longer busy.
  // Handles edge cases where socket events (STREAM_END) were lost due to
  // reconnection.
  //
  // IMPORTANT: streamBuffers is NOT cleared based on agent.status here.
  // STREAM_START arrives BEFORE the agent:status='busy' event in many flows,
  // and any stale `agent:updated` (with status='idle') that fires between
  // them would prematurely wipe the buffer — that's the bug that caused
  // "I need to refresh to see the stream". streamBuffers is now owned
  // exclusively by the STREAM_* handlers below.
  useEffect(() => {
    const busyIds = new Set(agents.filter(a => a.status === 'busy').map(a => a.id));
    setThinkingMap(prev => {
      let next = prev;
      for (const agentId of Object.keys(prev)) {
        if (!busyIds.has(agentId)) next = withoutKey(next, agentId);
      }
      return next;
    });
  }, [agents]);

  // No token argument: the session is an HttpOnly cookie the browser sends on
  // the handshake itself (see socket.ts).
  const initSocket = useCallback(() => {
    const sock = connectSocket();

    const clearThinking = (agentId: string) => setThinkingMap(prev => withoutKey(prev, agentId));
    const clearStreamBuffer = (agentId: string) =>
      setStreamBuffers(prev => withoutKey(prev, agentId));
    streamLifecycle.current?.dispose();
    const lifecycle = createChatStreamLifecycle(() => {
      // Do not queue snapshot requests while disconnected; connectSocket asks
      // again on reconnect. The watchdog covers missed events without reconnects.
      if (sock.connected) sock.emit(WsEvents.REQ_STREAM_STATE);
    }, clearStreamBuffer);
    streamLifecycle.current = lifecycle;
    lastAgentJson.current.clear();

    // Remove any previously registered listeners to prevent duplicates
    SOCKET_EVENTS.forEach(ev => sock.off(ev));

    sock.on(WsEvents.AGENTS_LIST, (list: Agent[]) => {
      setAgents(list);
      for (const agent of list) lifecycle.status(agent.id, agent.status);
    });
    sock.on(WsEvents.AGENT_CREATED, agent =>
      setAgents(prev =>
        prev.some(a => a.id === agent.id)
          ? prev.map(a => (a.id === agent.id ? agent : a))
          : [...prev, agent]
      )
    );
    sock.on(WsEvents.AGENT_UPDATED, agent => {
      // Lifecycle events still matter when a projected payload is a duplicate.
      lifecycle.updated(agent.id);
      lifecycle.status(agent.id, agent.status);
      // Dedup: skip if the payload is identical to the last one for this agent
      const json = JSON.stringify(agent);
      if (lastAgentJson.current.get(agent.id) === json) return;
      lastAgentJson.current.set(agent.id, json);

      setAgents(prev => prev.map(a => (a.id === agent.id ? agent : a)));
      // Safety net: clear thinking when agent data shows it's no longer busy.
      // This handles cases where agent:stream:end was missed (other clients,
      // workflow-triggered executions, socket reconnections).
      if (agent.status !== 'busy') clearThinking(agent.id);
    });
    sock.on(WsEvents.AGENT_DELETED, ({ id }) => {
      lifecycle.remove(id);
      setAgents(prev => prev.filter(a => a.id !== id));
    });
    sock.on(WsEvents.AGENT_STATUS, ({ id, status }) => {
      setAgents(prev => prev.map(a => (a.id === id ? { ...a, status } : a)));
      // When agent goes idle or error, clear stale thinking state so the
      // card doesn't keep showing "busy" after the agent has finished.
      if (status !== 'busy') clearThinking(id);
      lifecycle.status(id, status);
    });

    sock.on(WsEvents.AGENT_THINKING, ({ agentId, thinking }) => {
      if (!thinking) {
        clearThinking(agentId);
      } else {
        setThinkingMap(prev => ({ ...prev, [agentId]: thinking }));
      }
    });

    sock.on(WsEvents.STREAM_START, ({ agentId }) => {
      lifecycle.start(agentId);
      setStreamBuffers(prev => ({ ...prev, [agentId]: '' }));
    });

    sock.on(WsEvents.STREAM_CHUNK, ({ agentId, chunk }) => {
      lifecycle.start(agentId);
      setStreamBuffers(prev => ({
        ...prev,
        [agentId]: (prev[agentId] || '') + chunk,
      }));
    });

    // STREAM_RESUME is the server's response to REQ_STREAM_STATE on
    // (re)connect. It carries the FULL list of active streams (possibly
    // empty). We seed buffers for the active ones AND evict any local
    // buffers whose agent isn't streaming anymore — that covers the case
    // where the server crashed before sending STREAM_END.
    sock.on(WsEvents.STREAM_RESUME, ({ streams }) => {
      // Only the two fields this handler reads are declared — the frame is an
      // untyped socket payload, so the array type is the contract we rely on.
      const list: Array<{ agentId: string; buffer?: string }> = Array.isArray(streams)
        ? streams
        : [];
      const ended = lifecycle.resume(list.map(s => s.agentId));
      for (const id of ended) clearThinking(id);
      // If status was lost along with END, refresh it too (without guessing
      // idle: the agent may already be doing another kind of work).
      if (ended.length && sock.connected) sock.emit(WsEvents.REQ_REFRESH);
      setStreamBuffers(prev => {
        const next: Record<string, string> = {};
        for (const s of list) {
          const buffer = s.buffer || '';
          // The server caps snapshots at 200KB. A periodic check must not
          // truncate an intact local transcript that already contains that tail.
          next[s.agentId] =
            buffer.startsWith('…') && prev[s.agentId]?.endsWith(buffer.slice(1))
              ? prev[s.agentId]
              : buffer;
        }
        // Rebuilt from the server list — any buffer for an agent no longer
        // streaming server-side is implicitly dropped.
        return next;
      });
    });

    sock.on(WsEvents.STREAM_END, ({ agentId }) => {
      lifecycle.end(agentId);
      clearThinking(agentId);
    });

    sock.on(WsEvents.STREAM_ERROR, ({ agentId, error }) => {
      console.error(`Stream error for ${agentId}:`, error);
      lifecycle.remove(agentId);
      const errorLower = (error || '').toLowerCase();
      const isModelError = [
        'context length',
        'context_length',
        'num_ctx',
        'context window',
        'too long',
        'maximum context',
        'exceeds',
        'out of memory',
        'oom',
        'kv cache',
        'model error',
        'ollama error',
      ].some(kw => errorLower.includes(kw));
      showToastRef.current(
        error || 'An error occurred while streaming response',
        'error',
        isModelError ? 0 : 8000
      );
      clearThinking(agentId);
    });

    // Reinstalling listeners on an already-connected socket can miss START/END.
    // Reconcile that case too, after all stream handlers have been registered.
    if (sock.connected) sock.emit(WsEvents.REQ_STREAM_STATE);

    sock.on(WsEvents.AGENT_ERROR_REPORT, ({ agentName, description, isSystemError }) => {
      const prefix = isSystemError ? '⚙️' : '🚨';
      showToastRef.current(`${prefix} ${agentName}: ${description.slice(0, 200)}`, 'error', 12000);
    });

    sock.on(WsEvents.AGENT_HANDOFF, data => {
      console.log('Handoff:', data);
    });

    return sock;
  }, []); // No deps — uses refs for callbacks, setState is stable

  // Remove this hook's listeners from the live socket (App calls this from
  // its verify-effect cleanup when the effect re-runs).
  const teardown = useCallback(() => {
    streamLifecycle.current?.dispose();
    streamLifecycle.current = null;
    const sock = getSocket();
    if (sock) SOCKET_EVENTS.forEach(ev => sock.off(ev));
  }, []);

  return { agents, setAgents, thinkingMap, streamBuffers, initSocket, teardown };
}
