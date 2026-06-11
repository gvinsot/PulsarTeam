import { io } from 'socket.io-client';
import { WsEvents } from './socketEvents';

let socket = null;
let socketToken = null;

export function connectSocket(token) {
  // Return existing socket if it's connected or still connecting with the
  // same identity. A changed token must fall through to the recreate path —
  // mutating socket.auth on a live socket would not re-authenticate it.
  if (socket && (socket.connected || socket.active) && socketToken === token) return socket;

  // Disconnect any stale socket before creating a new one
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  socketToken = token;

  // In production (behind reverse proxy), connect to same origin
  // In dev, Vite proxies /socket.io to the backend
  const sock = io({
    // Function form so every reconnect handshake reads the freshest token
    // (e.g., refreshed by a re-login) instead of the one captured here.
    auth: (cb) => {
      let stored = null;
      try { stored = localStorage.getItem('token'); } catch { /* storage blocked */ }
      cb({ token: stored || socketToken });
    },
    transports: ['websocket', 'polling']
  });
  socket = sock;

  let retriedAuth = false;

  sock.on('connect', () => {
    retriedAuth = false;
    console.log('🔌 WebSocket connected');
    // Ask the server which agents are currently streaming so the UI can
    // pick up an in-flight response instead of looking frozen until the
    // user refreshes. Fires on initial connect AND on every reconnect.
    sock.emit(WsEvents.REQ_STREAM_STATE);
  });

  sock.on('connect_error', (err) => {
    console.error('WebSocket error:', err.message);
    // socket.active stays true while socket.io retries on its own; false
    // means the server middleware rejected the handshake and reconnection
    // has stopped permanently.
    if (sock.active) return;

    const isAuthError = err.message === 'Invalid token' || err.message === 'Authentication required';
    if (isAuthError && !retriedAuth) {
      // Retry exactly once in case localStorage holds a fresher token than
      // the one used for the failed handshake.
      retriedAuth = true;
      sock.connect();
      return;
    }

    window.dispatchEvent(new CustomEvent(isAuthError ? 'socket:auth-error' : 'socket:connect-error', {
      detail: err.message,
    }));
  });

  return sock;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
  socketToken = null;
}
