/**
 * Loopback OAuth callback hand-off for CLI sign-ins (codex "Sign in with
 * ChatGPT").
 *
 * The CLI's authorize URL redirects to `http://127.0.0.1:1455/auth/callback`
 * — its login server inside the runner container, which the user's browser
 * can't reach, so the browser ends on a dead page. The user pastes that page's
 * URL into the terminal; instead of typing it into the TUI (which ignores it),
 * TerminalTab sends it on the WebSocket as a `{type: "oauth_callback"}` control
 * frame and the runner replays it against the CLI (runner-service
 * oauth_callback_relay.py, which re-validates everything below).
 */

// codex binds 1455 and falls back to 1457 when 1455 stays busy.
const LOOPBACK_CALLBACK_RE =
  /^https?:\/\/(?:127\.0\.0\.1|localhost):(?:1455|1457)\/auth\/callback\?\S+$/i;
const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';

/**
 * The callback URL when `data` (one xterm onData chunk) is exactly a pasted
 * loopback sign-in callback, else null — anything else stays a keystroke.
 */
export function extractLoopbackOAuthCallback(data: string): string | null {
  if (typeof data !== 'string' || data.length > 8192) return null;
  let text = data;
  if (text.startsWith(BRACKETED_PASTE_START) && text.endsWith(BRACKETED_PASTE_END)) {
    text = text.slice(BRACKETED_PASTE_START.length, -BRACKETED_PASTE_END.length);
  }
  text = text.trim();
  if (!LOOPBACK_CALLBACK_RE.test(text)) return null;
  // Same gate as the runner: an authorization outcome (code or error) bound
  // to a state. Without it the CLI has nothing to act on.
  let params: URLSearchParams;
  try {
    params = new URL(text).searchParams;
  } catch {
    return null;
  }
  if (!params.get('state') || !(params.get('code') || params.get('error'))) return null;
  return text;
}
