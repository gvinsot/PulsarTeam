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
 *     drop. Each reconnect re-attaches to the existing PTY; the runner asks
 *     xterm to clear before replaying its authoritative scrollback.
 *   • Resizes the PTY whenever the visible area changes, so the TUI
 *     re-lays out to fill the viewport without scrollbars.
 *   • Scrollback is server-authoritative on reconnect, avoiding duplicated
 *     local replay after transient WebSocket drops.
 */
import { useEffect, useRef, useState } from 'react';
import { Terminal as XTerminal, type ILink, type ILinkProvider } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { Terminal as TerminalIcon, ArrowUp, ArrowDown, CornerDownLeft } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';

interface TerminalTabProps {
  agent: { id: string; name?: string; runner?: string };
  token: string;
}

// Backoff schedule for reconnects: 0.5s → 1s → 2s → … capped at 15s.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
// Minimum readable grid. When the visible area is smaller than this, we keep
// the terminal at the minimum and let the container scroll (overflow-auto)
// instead of shrinking the TUI into an unreadable sliver. Tuned so a TUI like
// Claude Code's stays legible in a narrow agent-detail panel or on mobile.
const MIN_COLS = 80;
const MIN_ROWS = 10;
const CLAUDE_OAUTH_PREFIX = 'https://claude.com/cai/oauth/authorize?code=';
const CLAUDE_OAUTH_MAX_CONTINUATION_LINES = 32;
const CLAUDE_OAUTH_FALLBACK_SEARCH_LINES = 500;

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

function openExternalLink(uri: string) {
  const opened = window.open('');
  if (opened) {
    try { opened.opener = null; } catch { /* noop */ }
    opened.location.href = uri;
  } else {
    console.warn('Opening link blocked as opener could not be cleared');
  }
}

function getTerminalLine(term: XTerminal, y: number) {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? '';
}

function firstNonWhitespaceIndex(line: string) {
  return line.search(/\S/);
}

function buildClaudeOAuthLink(term: XTerminal, startLine: number, firstLine = getTerminalLine(term, startLine)): ILink | undefined {
  const markerIndex = firstLine.indexOf(CLAUDE_OAUTH_PREFIX);
  if (markerIndex < 0) return undefined;

  const initialMatch = firstLine.slice(markerIndex).match(/^https?:\/\/claude\.com\/cai\/oauth\/authorize\?code=\S*/);
  if (!initialMatch) return undefined;

  let url = initialMatch[0];
  let endLine = startLine;
  let endColumn = markerIndex + initialMatch[0].length;

  for (
    let y = startLine + 1, consumed = 0;
    y < term.buffer.active.length && consumed < CLAUDE_OAUTH_MAX_CONTINUATION_LINES;
    y += 1, consumed += 1
  ) {
    const line = getTerminalLine(term, y);
    const trimmed = line.trim();
    if (!trimmed) break;
    const textStart = firstNonWhitespaceIndex(line);
    url += trimmed;
    endLine = y;
    endColumn = textStart + trimmed.length;
  }

  return {
    range: {
      start: { x: markerIndex + 1, y: startLine + 1 },
      end: { x: Math.max(1, endColumn + 1), y: endLine + 1 },
    },
    text: url,
    activate: (event, text) => {
      event.preventDefault();
      openExternalLink(text);
    },
  };
}

function createClaudeOAuthLinkProvider(term: XTerminal): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const startLine = bufferLineNumber - 1;
      const line = getTerminalLine(term, startLine);
      const link = line.includes(CLAUDE_OAUTH_PREFIX)
        ? buildClaudeOAuthLink(term, startLine, line)
        : undefined;
      callback(link ? [link] : undefined);
    },
  };
}

function reconstructClaudeOAuthUrlFromBuffer(term: XTerminal, uri: string) {
  if (!uri.startsWith(CLAUDE_OAUTH_PREFIX)) return uri;
  const buffer = term.buffer.active;
  const earliestLine = Math.max(0, buffer.length - CLAUDE_OAUTH_FALLBACK_SEARCH_LINES);
  for (let y = buffer.length - 1; y >= earliestLine; y -= 1) {
    const line = getTerminalLine(term, y);
    if (!line.includes(CLAUDE_OAUTH_PREFIX)) continue;
    const link = buildClaudeOAuthLink(term, y, line);
    if (link?.text.startsWith(uri)) return link.text;
  }
  return uri;
}

export default function TerminalTab({ agent, token }: TerminalTabProps) {
  const { theme } = useTheme();
  const [connected, setConnected] = useState(false);
  const [exited, setExited] = useState(false);
  const [terminalActive, setTerminalActive] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const activityTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const fitFrameRef = useRef<number | null>(null);
  const resizeSendTimerRef = useRef<number | null>(null);
  const pendingResizeRef = useRef<{ cols: number; rows: number } | null>(null);
  const encoderRef = useRef(new TextEncoder());
  const suppressReconnectRef = useRef(false);
  // Tracks whether the component is still mounted. Used to suppress retries
  // that would otherwise fire after unmount (e.g. quick tab switches).
  const aliveRef = useRef(true);

  const sendToRunner = (data: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(encoderRef.current.encode(data));
    return true;
  };

  const markTerminalActivity = () => {
    setTerminalActive(true);
    if (activityTimerRef.current !== null) {
      window.clearTimeout(activityTimerRef.current);
    }
    activityTimerRef.current = window.setTimeout(() => {
      activityTimerRef.current = null;
      setTerminalActive(false);
    }, 1800);
  };

  // Send a literal control sequence to the PTY and refocus xterm so the next
  // keystroke from a physical keyboard still lands in the terminal. Used by
  // the on-screen arrow / enter buttons in the header — they're the only way
  // to drive a TUI from a touch device, and they're handy on desktop too when
  // the focus has wandered to a button.
  const sendKey = (seq: string) => {
    if (!sendToRunner(seq)) return;
    termRef.current?.focus();
  };

  const fitTerminalNow = () => {
    // Skip fit when the container is collapsed (typically mid-animation while
    // the mobile virtual keyboard opens/closes). FitAddon would otherwise
    // compute a pathological geometry, push it to the runner, and the snapshot
    // renderer would repaint a near-empty screen — making the whole TUI vanish
    // after a couple of keyboard cycles.
    const el = containerRef.current;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!el || !term || !fit) return;
    if (el.clientWidth < 8 || el.clientHeight < 8) return;

    // Use proposeDimensions() (what fit() would apply) and clamp UP to a
    // readable minimum. Plain fit() always shrinks the grid to the container,
    // so the terminal could never overflow and the container's overflow-auto
    // never produced scrollbars. By clamping to MIN_COLS/MIN_ROWS, a small
    // viewport keeps a legible grid and the container scrolls instead.
    let dims: { cols: number; rows: number } | undefined;
    try {
      dims = fit.proposeDimensions();
    } catch {
      return; /* xterm not mounted yet */
    }
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return;

    const cols = Math.max(MIN_COLS, dims.cols);
    const rows = Math.max(MIN_ROWS, dims.rows);
    if (cols !== term.cols || rows !== term.rows) {
      try {
        term.resize(cols, rows);
      } catch {
        /* xterm not mounted yet */
      }
    }
  };

  const fitTerminal = () => {
    if (fitFrameRef.current !== null) return;
    fitFrameRef.current = window.requestAnimationFrame(() => {
      fitFrameRef.current = null;
      fitTerminalNow();
    });
  };

  // Constrain the container to the visible viewport so the FitAddon sees the
  // actual user-visible area instead of the full CSS box (which on mobile
  // doesn't shrink when the soft keyboard opens). Without this, fit() would
  // resize the PTY to a size that's partly hidden behind the keyboard.
  const adjustForViewport = () => {
    const el = containerRef.current;
    if (!el) return;
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (!vv || vv.height >= window.innerHeight - 1) {
      el.style.maxHeight = '';
      el.style.maxWidth = '';
      return;
    }
    const rect = el.getBoundingClientRect();
    const topOffset = rect.top - vv.offsetTop;
    const leftOffset = rect.left - vv.offsetLeft;
    const availableH = Math.max(0, Math.floor(vv.height - topOffset));
    const availableW = Math.max(0, Math.floor(vv.width - leftOffset));
    el.style.maxHeight = `${availableH}px`;
    el.style.maxWidth = `${availableW}px`;
  };

  // ── xterm.js setup ────────────────────────────────────────────────────
  useEffect(() => {
    aliveRef.current = true;
    if (!containerRef.current) return;

    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", "Segoe UI Mono", Menlo, Consolas, monospace',
      fontSize: 14,
      lineHeight: 1.35,
      letterSpacing: 0,
      scrollback: agent.runner === 'claudecode' ? 0 : 5000,
      altClickMovesCursor: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      theme: getTerminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const claudeOAuthLinkProvider = term.registerLinkProvider(createClaudeOAuthLinkProvider(term));
    term.loadAddon(new WebLinksAddon((event, uri) => {
      if (uri.startsWith(CLAUDE_OAUTH_PREFIX)) {
        event.preventDefault();
        openExternalLink(reconstructClaudeOAuthUrlFromBuffer(term, uri));
        return;
      }
      openExternalLink(uri);
    }));
    term.open(containerRef.current);
    fitTerminal();

    termRef.current = term;
    fitRef.current = fit;

    window.requestAnimationFrame(() => {
      fitTerminal();
      term.focus();
    });

    // Resize handling. Triggers:
    //   • the container resizes (window/sidebar/devtools)
    //   • the user changes tabs and comes back (the parent unmounts/remounts
    //     but the xterm instance is kept alive within THIS effect).
    //   • on mobile, the soft keyboard opens/closes — visualViewport reports
    //     this even when the container's CSS box doesn't change, which is the
    //     case here (the keyboard overlays the page without reflowing it).
    //     Without this, the PTY stays sized to the pre-keyboard viewport and
    //     output overlaps with the keyboard area.
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal();
    });
    resizeObserver.observe(containerRef.current);

    // Mobile soft keyboard / page zoom / browser UI changes don't shrink the
    // container's CSS box, so they wouldn't trigger ResizeObserver on their
    // own. We listen to visualViewport, constrain the container to the
    // user-visible area, then re-fit so the PTY's cols/rows match what the
    // user actually sees (and the runner redraws to fit, instead of the
    // bottom of its output disappearing behind the keyboard).
    const onViewportChange = () => {
      adjustForViewport();
      fitTerminal();
    };
    const onOrientationChange = onViewportChange;
    const vv = (window as any).visualViewport as VisualViewport | undefined;
    if (vv) {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    window.addEventListener('orientationchange', onOrientationChange);

    // Push resize events to the server so the PTY re-flows to match.
    // Debounced so a burst of resizes (typical when the mobile virtual
    // keyboard animates open/close) collapses into a single resize at the
    // final geometry, instead of triggering several PTY resizes + snapshot
    // repaints that race the subprocess's SIGWINCH redraw.
    term.onResize(({ cols, rows }) => {
      pendingResizeRef.current = { cols, rows };
      if (resizeSendTimerRef.current !== null) {
        window.clearTimeout(resizeSendTimerRef.current);
      }
      resizeSendTimerRef.current = window.setTimeout(() => {
        resizeSendTimerRef.current = null;
        const pending = pendingResizeRef.current;
        pendingResizeRef.current = null;
        if (!pending) return;
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'resize', cols: pending.cols, rows: pending.rows }));
        }
      }, 150);
    });

    // Keystrokes from the user → bytes to the server.
    term.onData((data) => {
      sendToRunner(data);
    });

    return () => {
      aliveRef.current = false;
      resizeObserver.disconnect();
      if (vv) {
        vv.removeEventListener('resize', onViewportChange);
        vv.removeEventListener('scroll', onViewportChange);
      }
      window.removeEventListener('orientationchange', onOrientationChange);
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (activityTimerRef.current !== null) {
        window.clearTimeout(activityTimerRef.current);
        activityTimerRef.current = null;
      }
      if (fitFrameRef.current !== null) {
        window.cancelAnimationFrame(fitFrameRef.current);
        fitFrameRef.current = null;
      }
      if (resizeSendTimerRef.current !== null) {
        window.clearTimeout(resizeSendTimerRef.current);
        resizeSendTimerRef.current = null;
      }
      pendingResizeRef.current = null;
      try { wsRef.current?.close(); } catch { /* noop */ }
      wsRef.current = null;
      claudeOAuthLinkProvider.dispose();
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
      fitTerminalNow();

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = new URL(`${proto}//${window.location.host}/ws/agents/${encodeURIComponent(agent.id)}/terminal`);
      url.searchParams.set('token', token);
      url.searchParams.set('cols', String(term.cols));
      url.searchParams.set('rows', String(term.rows));

      const ws = new WebSocket(url.toString());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      suppressReconnectRef.current = false;
      setExited(false);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        reconnectAttemptRef.current = 0;
        setConnected(true);
        fitTerminalNow();
        term.focus();
        // Send the current geometry once explicitly so the runner-side PTY
        // is sized correctly before the first rendering happens. The
        // server already received cols/rows on the handshake URL, but
        // resending here covers the reconnect case where the user's
        // window changed between attempts.
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
        // Ask the runner to repaint the current screen right now. Messages are
        // processed in order, so this paints at the geometry we just sent —
        // the terminal shows its live state the instant the tab opens, instead
        // of staying blank/stale until the next subprocess output (snapshot
        // mode only re-emits on output or the delayed post-resize tick).
        ws.send(JSON.stringify({ type: 'refresh' }));
      };

      ws.onmessage = (ev) => {
        if (wsRef.current !== ws) return;
        const t = termRef.current;
        if (!t) return;
        if (typeof ev.data === 'string') {
          // Control frames from the server (currently just {"type":"exit"})
          // — render a discrete notice in the terminal and let the close
          // handler trigger the reconnect.
          try {
            const ctrl = JSON.parse(ev.data);
            if (ctrl?.type === 'reset') {
              t.reset();
              t.clear();
              setTerminalActive(false);
            } else if (ctrl?.type === 'exit') {
              suppressReconnectRef.current = true;
              setExited(true);
              setConnected(false);
              const code = ctrl.code === null || ctrl.code === undefined ? 'unknown' : String(ctrl.code);
              const tail = typeof ctrl.tail === 'string' ? ctrl.tail.trim() : '';
              t.writeln(`\r\n\x1b[2m[runner subprocess exited, code=${code}]\x1b[0m`);
              if (tail) {
                const lines = tail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-6);
                for (const line of lines) {
                  t.writeln(`\x1b[2m${line}\x1b[0m`);
                }
              }
              t.writeln('\x1b[2m[close and reopen the terminal tab to start a new session]\x1b[0m');
            } else if (ctrl?.type === 'error') {
              t.writeln(`\r\n\x1b[31m[error: ${ctrl.message || 'unknown'}]\x1b[0m`);
            }
          } catch {
            markTerminalActivity();
            t.write(ev.data);
          }
          return;
        }
        // Binary frame = raw PTY bytes.
        const buf = ev.data instanceof ArrayBuffer
          ? new Uint8Array(ev.data)
          : new Uint8Array(ev.data as any);
        if (buf.byteLength > 0) markTerminalActivity();
        t.write(buf);
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setConnected(false);
        if (suppressReconnectRef.current) return;
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
      setConnected(false);
      setExited(false);
    };
  }, [agent.id, token]);

  const shellClass = theme === 'light'
    ? 'bg-white text-gray-700'
    : 'bg-dark-900 text-dark-200';
  const headerClass = theme === 'light'
    ? 'border-gray-200 text-gray-500 bg-gray-50'
    : 'border-dark-700/50 text-dark-400 bg-dark-900';
  const bodyClass = theme === 'light' ? 'bg-white' : 'bg-dark-900';

  return (
    <div className={`flex flex-col h-full ${shellClass}`}>
      <div className={`flex items-center gap-2 px-3 py-2 border-b text-xs ${headerClass}`}>
        <TerminalIcon className="w-3.5 h-3.5 text-indigo-400" />
        <span>Terminal</span>
        <span className="opacity-60">— {agent.runner || 'cli'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => sendKey('\x1b[A')}
            disabled={!connected}
            title="Up arrow — select previous option"
            aria-label="Send up arrow"
            className="flex items-center justify-center w-7 h-7 rounded border border-dark-700/60 bg-dark-800/60 hover:bg-dark-700/60 hover:text-dark-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => sendKey('\x1b[B')}
            disabled={!connected}
            title="Down arrow — select next option"
            aria-label="Send down arrow"
            className="flex items-center justify-center w-7 h-7 rounded border border-dark-700/60 bg-dark-800/60 hover:bg-dark-700/60 hover:text-dark-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => sendKey('\r')}
            disabled={!connected}
            title="Enter — confirm selection"
            aria-label="Send enter"
            className="flex items-center justify-center w-7 h-7 rounded border border-dark-700/60 bg-dark-800/60 hover:bg-dark-700/60 hover:text-dark-100 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <CornerDownLeft className="w-3.5 h-3.5" />
          </button>
          <span className="opacity-60 ml-1">
            {connected ? (terminalActive ? 'active' : 'connected') : exited ? 'exited' : 'reconnecting'} · multi-client
          </span>
        </div>
      </div>
      <div
        ref={containerRef}
        // overflow-auto lets the container show scrollbars whenever the
        // rendered terminal grid is larger than the visible viewport — which
        // happens on mobile when the soft keyboard reduces visualViewport but
        // we deliberately keep the PTY at its full cols×rows.
        className={`min-h-0 flex-1 overflow-auto ${bodyClass}`}
        style={{ touchAction: 'manipulation' }}
        onClick={() => termRef.current?.focus()}
      />
    </div>
  );
}
