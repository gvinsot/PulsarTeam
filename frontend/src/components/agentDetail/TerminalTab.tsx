/**
 * Interactive terminal for CLI runners (claudecode, codex, opencode, openclaw).
 *
 * The chat UI is intentionally bypassed for these agents — they're driven by
 * a real TUI that's hard to fake. We open a WebSocket to the team-api
 * `/ws/agents/:id/terminal` endpoint, which proxies onto the runner's
 * shared-PTY session. Every client attached to the same agent sees the same
 * screen and can type (multi-admin friendly).
 *
 * Behaviour:
 *   • Reconnects automatically with exponential backoff after a network
 *     drop. Each reconnect re-attaches to the existing PTY (the runner
 *     replays the scrollback) so the user just sees a brief blank moment.
 *   • Resizes the PTY whenever the visible area changes, so the TUI
 *     re-lays out to fill the viewport without scrollbars.
 *   • The xterm scrollback survives reconnects because xterm.js holds it
 *     locally on top of whatever the server replays.
 */
import { useEffect, useRef } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Terminal as TerminalIcon } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

interface TerminalTabProps {
  agent: { id: string; name?: string; runner?: string };
  token: string;
}

// Backoff schedule for reconnects: 0.5s → 1s → 2s → … capped at 15s.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;

const getTerminalTheme = (theme: string) => (
  theme === 'light'
    ? {
        background: '#ffffff',
        foreground: '#374151',
        cursor: '#4f46e5',
        cursorAccent: '#ffffff',
        selectionBackground: '#c7d2fe',
        black: '#111827',
        red: '#dc2626',
        green: '#059669',
        yellow: '#d97706',
        blue: '#2563eb',
        magenta: '#7c3aed',
        cyan: '#0891b2',
        white: '#f9fafb',
        brightBlack: '#6b7280',
        brightRed: '#ef4444',
        brightGreen: '#10b981',
        brightYellow: '#f59e0b',
        brightBlue: '#3b82f6',
        brightMagenta: '#8b5cf6',
        brightCyan: '#06b6d4',
        brightWhite: '#ffffff',
      }
    : {
        background: '#020617',
        foreground: '#e2e8f0',
        cursor: '#818cf8',
        cursorAccent: '#020617',
        selectionBackground: '#334155',
        black: '#020617',
        red: '#ef4444',
        green: '#10b981',
        yellow: '#f59e0b',
        blue: '#60a5fa',
        magenta: '#a78bfa',
        cyan: '#06b6d4',
        white: '#e2e8f0',
        brightBlack: '#64748b',
        brightRed: '#f87171',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#93c5fd',
        brightMagenta: '#c4b5fd',
        brightCyan: '#22d3ee',
        brightWhite: '#f8fafc',
      }
);

export default function TerminalTab({ agent, token }: TerminalTabProps) {
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const encoderRef = useRef(new TextEncoder());
  // Tracks whether the component is still mounted. Used to suppress retries
  // that would otherwise fire after unmount (e.g. quick tab switches).
  const aliveRef = useRef(true);

  // ── xterm.js setup ────────────────────────────────────────────────────
  useEffect(() => {
    aliveRef.current = true;
    if (!containerRef.current) return;

    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", "Segoe UI Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: getTerminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    term.focus();

    termRef.current = term;
    fitRef.current = fit;

    // Resize handling. Two triggers:
    //   • the container resizes (window/sidebar/devtools)
    //   • the user changes tabs and comes back (the parent unmounts/remounts
    //     but the xterm instance is kept alive within THIS effect).
    const resizeObserver = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* xterm not mounted yet */ }
    });
    resizeObserver.observe(containerRef.current);

    // Push resize events to the server so the PTY re-flows to match.
    term.onResize(({ cols, rows }) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols, rows }));
      }
    });

    // Keystrokes from the user → bytes to the server.
    term.onData((data) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(encoderRef.current.encode(data));
      }
    });

    return () => {
      aliveRef.current = false;
      resizeObserver.disconnect();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
      try { term.dispose(); } catch { /* noop */ }
      termRef.current = null;
      fitRef.current = null;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = getTerminalTheme(theme);
  }, [theme]);

  // ── WebSocket lifecycle ───────────────────────────────────────────────
  // Connect once on mount, reconnect on close. Kept in its own effect so
  // changing `agent.id` or `token` reopens cleanly.
  useEffect(() => {
    if (!agent.id || !token) return;

    const connect = () => {
      if (!aliveRef.current) return;
      const term = termRef.current;
      if (!term) return;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = new URL(`${proto}//${window.location.host}/ws/agents/${encodeURIComponent(agent.id)}/terminal`);
      url.searchParams.set('token', token);
      url.searchParams.set('cols', String(term.cols));
      url.searchParams.set('rows', String(term.rows));

      const ws = new WebSocket(url.toString());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        reconnectAttemptRef.current = 0;
        term.focus();
        // Send the current geometry once explicitly so the runner-side PTY
        // is sized correctly before the first rendering happens. The
        // server already received cols/rows on the handshake URL, but
        // resending here covers the reconnect case where the user's
        // window changed between attempts.
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      };

      ws.onmessage = (ev) => {
        const t = termRef.current;
        if (!t) return;
        if (typeof ev.data === 'string') {
          // Control frames from the server (currently just {"type":"exit"})
          // — render a discrete notice in the terminal and let the close
          // handler trigger the reconnect.
          try {
            const ctrl = JSON.parse(ev.data);
            if (ctrl?.type === 'exit') {
              t.writeln('\r\n\x1b[2m[runner subprocess exited — reconnecting…]\x1b[0m');
            } else if (ctrl?.type === 'error') {
              t.writeln(`\r\n\x1b[31m[error: ${ctrl.message || 'unknown'}]\x1b[0m`);
            }
          } catch {
            t.write(ev.data);
          }
          return;
        }
        // Binary frame = raw PTY bytes.
        const buf = ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data as any);
        t.write(buf);
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (!aliveRef.current) return;
        scheduleReconnect();
      };
      ws.onerror = () => {
        // Don't write the error directly — the close handler will reconnect.
        // We could surface the diagnostic in the terminal but that flashes
        // false alerts during transient network blips.
      };
    };

    const scheduleReconnect = () => {
      if (!aliveRef.current) return;
      const attempt = reconnectAttemptRef.current++;
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** attempt);
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    };

    connect();
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
    };
  }, [agent.id, token]);

  return (
    <div className="flex flex-col h-full bg-dark-900 text-dark-200">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-dark-700/50 text-xs text-dark-400 bg-dark-900">
        <TerminalIcon className="w-3.5 h-3.5 text-indigo-400" />
        <span>Terminal</span>
        <span className="opacity-60">— {agent.runner || 'cli'}</span>
        <span className="ml-auto opacity-60">multi-client · scrollback persistent</span>
      </div>
      <div
        ref={containerRef}
        className="flex-1 p-2 overflow-hidden bg-dark-900"
        onClick={() => termRef.current?.focus()}
        onMouseDown={() => termRef.current?.focus()}
      />
    </div>
  );
}
