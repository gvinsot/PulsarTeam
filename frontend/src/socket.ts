import { io } from 'socket.io-client';
import { WsEvents } from './socketEvents';

let socket = null;

/**
 * Open (or reuse) the realtime socket.
 *
 * No token is passed any more: the session is an HttpOnly cookie the browser
 * attaches to the same-origin handshake by itself, so there is nothing for the
 * page to hold or hand over. The server still accepts an explicit
 * `auth.token` — that path is for non-browser clients such as the desktop
 * bridge — and validates the handshake's `Origin` either way, which is the
 * socket's CSRF defence (a WebSocket handshake cannot carry a custom header).
 */
export function connectSocket() {
  // Return the existing socket if it's connected or still connecting. Identity
  // no longer changes under us: a re-login replaces the cookie, and the caller
  // recycles the socket explicitly via disconnectSocket().
  if (socket && (socket.connected || socket.active)) return socket;

  // Disconnect any stale socket before creating a new one
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  // In production (behind reverse proxy), connect to same origin
  // In dev, Vite proxies /socket.io to the backend
  const sock = io({
    // Sends the session cookie on the handshake, including on the polling
    // transport and when the API is served from a sibling origin.
    withCredentials: true,
    transports: ['websocket', 'polling'],
  });
  socket = sock;

  sock.on('connect', () => {
    console.log('🔌 WebSocket connected');
    // Ask the server which agents are currently streaming so the UI can
    // pick up an in-flight response instead of looking frozen until the
    // user refreshes. Fires on initial connect AND on every reconnect.
    sock.emit(WsEvents.REQ_STREAM_STATE);
  });

  sock.on('connect_error', err => {
    console.error('WebSocket error:', err.message);
    // socket.active stays true while socket.io retries on its own; false
    // means the server middleware rejected the handshake and reconnection
    // has stopped permanently.
    if (sock.active) return;

    // Nothing to retry with: the cookie the handshake used is the only
    // credential the page has, so an auth rejection means the session is
    // genuinely gone and App must send the user back to the login screen.
    const isAuthError =
      err.message === 'Invalid token' || err.message === 'Authentication required';

    window.dispatchEvent(
      new CustomEvent(isAuthError ? 'socket:auth-error' : 'socket:connect-error', {
        detail: err.message,
      })
    );
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
}
