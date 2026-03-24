import React, { createContext, useContext, useState, useEffect, useRef } from 'react';
import { getSocket } from '../socket';

const WebSocketContext = createContext({ socket: null, connected: false, lastMessage: null });

export function WebSocketProvider({ children }) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState(null);
  const socketRef = useRef(null);

  useEffect(() => {
    const check = () => {
      const s = getSocket();
      if (s && s !== socketRef.current) {
        socketRef.current = s;
        setConnected(s.connected);

        const onConnect = () => setConnected(true);
        const onDisconnect = () => setConnected(false);
        const onAny = (event, data) => setLastMessage({ event, data, ts: Date.now() });

        s.on('connect', onConnect);
        s.on('disconnect', onDisconnect);
        s.onAny(onAny);

        return () => {
          s.off('connect', onConnect);
          s.off('disconnect', onDisconnect);
          s.offAny(onAny);
        };
      }
    };

    // Socket may not exist yet (created after login), so poll briefly
    const cleanup = check();
    if (cleanup) return cleanup;

    const interval = setInterval(() => {
      const c = check();
      if (c) clearInterval(interval);
    }, 500);

    return () => clearInterval(interval);
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