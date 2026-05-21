import { io } from 'socket.io-client';
import { WsEvents } from './socketEvents';

let socket = null;

export function connectSocket(token) {
  // Return existing socket if it's connected or still connecting
  if (socket && (socket.connected || socket.active)) return socket;

  // Disconnect any stale socket before creating a new one
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  // In production (behind reverse proxy), connect to same origin
  // In dev, Vite proxies /socket.io to the backend
  socket = io({
    auth: { token },
    transports: ['websocket', 'polling']
  });

  socket.on('connect', () => {
    console.log('🔌 WebSocket connected');
    // Ask the server which agents are currently streaming so the UI can
    // pick up an in-flight response instead of looking frozen until the
    // user refreshes. Fires on initial connect AND on every reconnect.
    socket.emit(WsEvents.REQ_STREAM_STATE);
  });

  socket.on('connect_error', (err) => {
    console.error('WebSocket error:', err.message);
  });

  return socket;
}

export function getSocket() {
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}
