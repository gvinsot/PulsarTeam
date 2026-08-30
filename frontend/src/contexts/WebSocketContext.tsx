import { createContext, useContext, useState, useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import type { Socket } from 'socket.io-client';
import { getSocket } from '../socket';
import { WsEvents } from '../socketEvents';

/**
 * The last frame seen on the socket, whatever its event name. UI-LOCAL: built
 * here from socket.io's onAny, never sent as such by the API. `data` is the
 * event's first argument and its shape depends entirely on `type`, so it stays
 * `unknown` — a consumer has to narrow on `type` before reading it.
 */
interface WebSocketMessage {
  type: string;
  data: unknown;
  /** Date.now() at reception — also what makes each frame a distinct object. */
  ts: number;
}

interface WebSocketContextValue {
  /** null until connectSocket() has run (i.e. before login). */
  socket: Socket | null;
  connected: boolean;
  lastMessage: WebSocketMessage | null;
}

const WebSocketContext = createContext<WebSocketContextValue>({
  socket: null,
  connected: false,
  lastMessage: null,
});

export function WebSocketProvider({ children }: { children: ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const socketRef = useRef<Socket | null>(null);

  useEffect(() => {
    // Track the attached socket in effect-local state (not just the ref) so
    // a StrictMode remount re-attaches listeners after cleanup removed them.
    let attached: Socket | null = null;
    let detach: (() => void) | null = null;

    const check = () => {
      const s = getSocket();
      if (!s || s === attached) return;

      detach?.();
      attached = s;
      socketRef.current = s;
      setConnected(s.connected);

      const onConnect = () => setConnected(true);
      const onDisconnect = () => setConnected(false);
      // `data` is the frame's first argument; its shape depends on `event`, so
      // it stays `unknown` all the way into WebSocketMessage.
      const onAny = (event: string, data: unknown) => {
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
