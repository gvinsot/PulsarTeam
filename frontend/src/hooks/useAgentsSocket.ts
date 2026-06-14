import { useState, useEffect, useCallback, useRef } from 'react';
import { connectSocket, getSocket } from '../socket';
import { WsEvents } from '../socketEvents';

const SOCKET_EVENTS = [
  WsEvents.AGENTS_LIST, WsEvents.AGENT_CREATED, WsEvents.AGENT_UPDATED, WsEvents.AGENT_DELETED,
  WsEvents.AGENT_STATUS, WsEvents.AGENT_THINKING, WsEvents.STREAM_START, WsEvents.STREAM_CHUNK,
  WsEvents.STREAM_END, WsEvents.STREAM_ERROR, WsEvents.STREAM_RESUME,
  WsEvents.AGENT_ERROR_REPORT, WsEvents.AGENT_HANDOFF
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
export function useAgentsSocket(showToastRef) {
  const [agents, setAgents] = useState([]);
  const [thinkingMap, setThinkingMap] = useState({});
  const [streamBuffers, setStreamBuffers] = useState({});
  const streamEndedAgents = useRef(new Set()); // Track agents whose stream just ended
  // Agents currently streaming on the server (from STREAM_START/STREAM_RESUME).
  // Used as the source of truth for whether to keep a streamBuffer alive,
  // so we don't race against agent.status updates arriving out of order.
  const activeStreamAgents = useRef(new Set());
  const lastAgentJson = useRef(new Map());    // Dedup: last JSON per agentId

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

  const initSocket = useCallback((token) => {
    const sock = connectSocket(token);

    const clearThinking = (agentId) => setThinkingMap(prev => withoutKey(prev, agentId));
    const clearStreamBuffer = (agentId) => setStreamBuffers(prev => withoutKey(prev, agentId));

    // Remove any previously registered listeners to prevent duplicates
    SOCKET_EVENTS.forEach(ev => sock.off(ev));

    sock.on(WsEvents.AGENTS_LIST, (list) => setAgents(list));
    sock.on(WsEvents.AGENT_CREATED, (agent) => setAgents(prev =>
      prev.some(a => a.id === agent.id) ? prev.map(a => a.id === agent.id ? agent : a) : [...prev, agent]
    ));
    sock.on(WsEvents.AGENT_UPDATED, (agent) => {
      // Dedup: skip if the payload is identical to the last one for this agent
      const json = JSON.stringify(agent);
      if (lastAgentJson.current.get(agent.id) === json) return;
      lastAgentJson.current.set(agent.id, json);

      setAgents(prev => prev.map(a => a.id === agent.id ? agent : a));
      // Safety net: clear thinking when agent data shows it's no longer busy.
      // This handles cases where agent:stream:end was missed (other clients,
      // workflow-triggered executions, socket reconnections).
      if (agent.status !== 'busy') clearThinking(agent.id);
      // When an agent's stream just ended, clear its buffer atomically
      // with the history update so the message never disappears.
      if (streamEndedAgents.current.has(agent.id)) {
        streamEndedAgents.current.delete(agent.id);
        clearStreamBuffer(agent.id);
      }
    });
    sock.on(WsEvents.AGENT_DELETED, ({ id }) => setAgents(prev => prev.filter(a => a.id !== id)));
    sock.on(WsEvents.AGENT_STATUS, ({ id, status }) => {
      setAgents(prev => prev.map(a => a.id === id ? { ...a, status } : a));
      // When agent goes idle or error, clear stale thinking state so the
      // card doesn't keep showing "busy" after the agent has finished.
      if (status !== 'busy') clearThinking(id);
    });

    sock.on(WsEvents.AGENT_THINKING, ({ agentId, thinking }) => {
      if (!thinking) {
        clearThinking(agentId);
      } else {
        setThinkingMap(prev => ({ ...prev, [agentId]: thinking }));
      }
    });

    sock.on(WsEvents.STREAM_START, ({ agentId }) => {
      activeStreamAgents.current.add(agentId);
      setStreamBuffers(prev => ({ ...prev, [agentId]: '' }));
    });

    sock.on(WsEvents.STREAM_CHUNK, ({ agentId, chunk }) => {
      activeStreamAgents.current.add(agentId);
      setStreamBuffers(prev => ({
        ...prev,
        [agentId]: (prev[agentId] || '') + chunk
      }));
    });

    // STREAM_RESUME is the server's response to REQ_STREAM_STATE on
    // (re)connect. It carries the FULL list of active streams (possibly
    // empty). We seed buffers for the active ones AND evict any local
    // buffers whose agent isn't streaming anymore — that covers the case
    // where the server crashed before sending STREAM_END.
    sock.on(WsEvents.STREAM_RESUME, ({ streams }) => {
      const list = Array.isArray(streams) ? streams : [];
      const activeIds = new Set(list.map((s: any) => s.agentId));
      activeStreamAgents.current = activeIds;
      setStreamBuffers(() => {
        const next: Record<string, string> = {};
        for (const s of list) next[s.agentId] = s.buffer || '';
        // Rebuilt from the server list — any buffer for an agent no longer
        // streaming server-side is implicitly dropped.
        return next;
      });
    });

    sock.on(WsEvents.STREAM_END, ({ agentId }) => {
      activeStreamAgents.current.delete(agentId);
      clearThinking(agentId);
      // Don't clear streamBuffer here — mark the agent so that the next
      // agent:updated event clears it atomically with the history update.
      // This prevents the flash where the message disappears then reappears.
      streamEndedAgents.current.add(agentId);
      // Safety net: if agent:updated doesn't arrive within 3s, clear anyway
      setTimeout(() => {
        if (streamEndedAgents.current.has(agentId)) {
          streamEndedAgents.current.delete(agentId);
          clearStreamBuffer(agentId);
        }
      }, 3000);
    });

    sock.on(WsEvents.STREAM_ERROR, ({ agentId, error }) => {
      console.error(`Stream error for ${agentId}:`, error);
      activeStreamAgents.current.delete(agentId);
      const errorLower = (error || '').toLowerCase();
      const isModelError = [
        'context length', 'context_length', 'num_ctx', 'context window',
        'too long', 'maximum context', 'exceeds', 'out of memory', 'oom',
        'kv cache', 'model error', 'ollama error'
      ].some(kw => errorLower.includes(kw));
      showToastRef.current(
        error || 'An error occurred while streaming response',
        'error',
        isModelError ? 0 : 8000
      );
      clearThinking(agentId);
      clearStreamBuffer(agentId);
    });

    // REQ_STREAM_STATE on (re)connect is wired in socket.ts so it runs once
    // per socket instance — see connectSocket().

    sock.on(WsEvents.AGENT_ERROR_REPORT, ({ agentName, description, isSystemError }) => {
      const prefix = isSystemError ? '⚙️' : '🚨';
      showToastRef.current(`${prefix} ${agentName}: ${description.slice(0, 200)}`, 'error', 12000);
    });

    sock.on(WsEvents.AGENT_HANDOFF, (data) => {
      console.log('Handoff:', data);
    });

    return sock;
  }, []); // No deps — uses refs for callbacks, setState is stable

  // Remove this hook's listeners from the live socket (App calls this from
  // its verify-effect cleanup when the effect re-runs).
  const teardown = useCallback(() => {
    const sock = getSocket();
    if (sock) SOCKET_EVENTS.forEach(ev => sock.off(ev));
  }, []);

  return { agents, setAgents, thinkingMap, streamBuffers, initSocket, teardown };
}
