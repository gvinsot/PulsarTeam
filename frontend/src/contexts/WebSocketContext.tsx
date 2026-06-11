import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getSocket } from '../socket';
import { WsEvents } from '../socketEvents';

const WebSocketContext = createContext({ socket: null, connected: false, lastMessage: null });

export function WebSocketProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    // Track the attached socket in effect-local state (not just the ref) so
    // a StrictMode remount re-attaches listeners after cleanup removed them.
    let attached = null;
    let detach = null;

    const check = () => {
      const s = getSocket();
      if (!s || s === attached) return;

      detach?.();
      attached = s;
      socketRef.current = s;
      setConnected(s.connected);

      const onConnect = () => setConnected(true);
      const onDisconnect = () => setConnected(false);
      const onAny = (event, data) => {
        // Skip high-frequency stream chunks — re-rendering the whole tree
        // per chunk for a context with no chunk consumers is wasted work.
        if (event === WsEvents.STREAM_CHUNK) return;
        setLastMessage({ type: event, data, ts: Date.now() });
      };

      s.on('connect', onConnect);
      s.on('disconnect', onDisconnect);
      s.onAny(onAny);

      detach = () => {
        s.off('connect', onConnect);
        s.off('disconnect', onDisconnect);
        s.offAny(onAny);
      };
    };

    // The socket may not exist yet (created after login) and is replaced on
    // re-login/impersonation, so keep polling for a different instance.
    check();
    const interval = setInterval(check, 500);

    return () => {
      clearInterval(interval);
      detach?.();
    };
  }, []);

  return (
    <WebSocketContext.Provider value={{ socket: socketRef.current, connected, lastMessage }}>
      {children}
    </WebSocketContext.Provider>
  );
}

export function useWebSocket() {
  return useContext(WebSocketContext);
}