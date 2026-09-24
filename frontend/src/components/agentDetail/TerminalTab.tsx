/**
 * Interactive terminal for CLI runners (claudecode, codex, opencode, openclaw).
 *
 * The chat UI is intentionally bypassed for these agents — they're driven by
 * a real TUI that's hard to fake. We open a WebSocket to the team-api
 * `/ws/agents/:id/terminal` endpoint, which proxies onto the runner's
 * shared-PTY session. Every client attached to the same agent sees the same
 * screen and can type (multi-admin friendly).
 *
 * Geometry model — the reason this renders correctly everywhere:
 *   • There is ONE PTY, hence ONE grid. The runner announces it with
 *     {type:"size"} frames (on attach and after every resize) and this xterm
 *     ALWAYS adopts exactly that cols×rows. A viewer that kept its own grid
 *     re-wrapped bytes drawn for another width into garbage (a phone next to
 *     a desktop).
 *   • The grid is then fitted to the visible area by FONT SIZE (largest size
 *     ≤ the user's preferred one that fits). Only when even the minimum font
 *     overflows does the panel scroll.
 *   • Which viewer decides the grid: the latest one the user interacts with
 *     (attach, focus, keystroke, own viewport change) sends a `resize` claim
 *     computed from ITS viewport at ITS preferred font — like tmux
 *     `window-size latest`. Passive viewers never claim on a size frame, so
 *     two open viewers cannot ping-pong.
 *
 * History: the runner keeps xterm off the alternate screen (which has no
 * scrollback) and seeds a fresh viewer's scrollback with the tmux pane
 * history, so the whole session is scrollable from the first paint.
 *
 * Reconnects automatically with exponential backoff; each reconnect gets a
 * `reset` then the authoritative size, history and screen from the runner.
 *
 * Auth: none is passed here. The session is an HttpOnly cookie the browser
 * attaches to the same-origin upgrade itself — the JWT used to be appended as
 * `?token=…` because `new WebSocket()` cannot set headers, which parked a live
 * credential in URLs and proxy logs.
 */
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Terminal as XTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  Terminal as TerminalIcon,
  ArrowUp,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  CornerDownLeft,
  RotateCcw,
  ZoomIn,
  ZoomOut,
  Maximize2,
  ChevronsDown,
} from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import {
  CLAUDE_OAUTH_PREFIXES,
  openExternalLink,
  createClaudeOAuthLinkProvider,
  reconstructClaudeOAuthUrlFromBuffer,
} from './claudeOAuthLinks';
import type { Agent } from '../../types';

/**
 * A JSON control frame sent on the terminal WebSocket's TEXT channel (binary
 * frames are raw PTY output). Every field is optional: the frame is parsed
 * before its `type` is known, and each variant only fills its own keys —
 * 'reset' carries none, 'size' carries cols/rows, 'exit' carries code/tail,
 * 'error' carries message.
 */
interface TerminalControlFrame {
  type?: string;
  /** 'size' only: the authoritative shared PTY grid. */
  cols?: number;
  rows?: number;
  /** 'exit' only. Explicitly null when the session was killed by a signal. */
  code?: number | null;
  /** 'exit' only: the last lines the runner printed before dying. */
  tail?: string;
  /** 'error' only. */
  message?: string;
}

interface TerminalTabProps {
  agent: Agent;
}

interface Grid {
  cols: number;
  rows: number;
}

// Backoff schedule for reconnects: 0.5s → 1s → 2s → … capped at 15s.
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 15_000;
// Floors for the grid a viewer CLAIMS. Below ~80 cols the Claude Code TUI
// renders broken and wraps long output (e.g. the /login URL) into lossy
// pieces, so a narrow desktop panel still claims 80 and shrinks its font to
// fit. A phone cannot show 80 legible columns, so there (coarse pointer) the
// floor is lower and the user trades size for columns with the zoom buttons.
const DESKTOP_MIN_COLS = 80;
const TOUCH_MIN_COLS = 40;
const MIN_ROWS = 10;
// Runner-side clamps (pty_session.resize) — mirror them so a claim is never
// silently altered.
const MAX_COLS = 500;
const MAX_ROWS = 200;
// Font range. The preferred size (zoom) is the ceiling used both to compute
// this viewer's claim and to render; fitting another viewer's grid only ever
// shrinks down to FONT_MIN, after which the panel scrolls.
const FONT_MIN = 7;
const FONT_MAX = 22;
const FONT_STEP = 0.5;
const DEFAULT_FONT_DESKTOP = 13;
const DEFAULT_FONT_TOUCH = 11;
const FONT_STORAGE_KEY = 'pulsar.terminal.fontSize';
const CLAIM_DEBOUNCE_MS = 150;
const SCROLLBACK_LINES = 10_000;

const isCoarsePointer = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;

const readStoredFont = (): number | null => {
  try {
    const raw = window.localStorage.getItem(FONT_STORAGE_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : null;
  } catch {
    return null;
  }
};

const storeFont = (size: number) => {
  try {
    window.localStorage.setItem(FONT_STORAGE_KEY, String(size));
  } catch {
    /* private mode / blocked storage: the zoom just isn't remembered */
  }
};

const sameGrid = (a: Grid | null, b: Grid | null) =>
  !!a && !!b && a.cols === b.cols && a.rows === b.rows;

// Keys for the touch key bar: what a phone keyboard cannot send to a TUI.
const TOUCH_KEYS: { label: string; seq: string; title: string }[] = [
  { label: 'Esc', seq: '\x1b', title: 'Escape' },
  { label: 'Tab', seq: '\t', title: 'Tab' },
  { label: '⇧Tab', seq: '\x1b[Z', title: 'Shift+Tab' },
  { label: '^C', seq: '\x03', title: 'Ctrl+C' },
];

const getTerminalTheme = (theme: string) =>
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
      };

export default function TerminalTab({ agent }: TerminalTabProps) {
  const { theme } = useTheme();
  const [coarse, setCoarse] = useState(isCoarsePointer);
  const [connected, setConnected] = useState(false);
  const [exited, setExited] = useState(false);
  const [terminalActive, setTerminalActive] = useState(false);
  // True when the shared grid was claimed by another viewer and differs from
  // what this one would pick — surfaces the "fit to this screen" button.
  const [foreignGrid, setForeignGrid] = useState(false);
  const [scrolledUp, setScrolledUp] = useState(false);
  const [fontPref, setFontPref] = useState<number>(
    () => readStoredFont() ?? (isCoarsePointer() ? DEFAULT_FONT_TOUCH : DEFAULT_FONT_DESKTOP)
  );
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const activityTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const claimTimerRef = useRef<number | null>(null);
  const encoderRef = useRef(new TextEncoder());
  const suppressReconnectRef = useRef(false);
  // The authoritative PTY grid from the runner's last {type:"size"}; null
  // until the first one arrives (the xterm then shows this viewer's own
  // preferred grid, which is also what the handshake claims).
  const ptySizeRef = useRef<Grid | null>(null);
  // Last grid this viewer claimed, so an unchanged viewport sends nothing.
  const lastClaimRef = useRef<Grid | null>(null);
  // Last computed preferred grid, so a keystroke can compare without
  // re-measuring fonts (each probe forces an xterm re-render).
  const preferredRef = useRef<Grid | null>(null);
  const fontPrefRef = useRef(fontPref);
  const coarseRef = useRef(coarse);
  // Tracks whether the component is still mounted. Used to suppress retries
  // that would otherwise fire after unmount (e.g. quick tab switches).
  const aliveRef = useRef(true);
  // Latest connect() impl, published by the WS effect so relaunch() (defined at
  // component scope) can re-open the socket on demand.
  const connectRef = useRef<(() => void) | null>(null);
  // Mirror of `exited` readable from xterm's onData closure without re-running
  // its (mount-only) effect.
  const exitedRef = useRef(false);

  const setExitedState = (v: boolean) => {
    exitedRef.current = v;
    setExited(v);
  };

  const wsOpen = () => {
    const ws = wsRef.current;
    return ws && ws.readyState === WebSocket.OPEN ? ws : null;
  };

  const sendToRunner = (data: string) => {
    const ws = wsOpen();
    if (!ws) return false;
    ws.send(encoderRef.current.encode(data));
    return true;
  };

  // ── Geometry ──────────────────────────────────────────────────────────
  // What fits the container at `fontSize`, measured by xterm itself (the
  // option change re-measures synchronously and nothing paints before the
  // next frame, so probing several sizes in one tick is invisible).
  const fitsAt = (fontSize: number): Grid | null => {
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return null;
    if (term.options.fontSize !== fontSize) term.options.fontSize = fontSize;
    let dims: Grid | undefined;
    try {
      dims = fit.proposeDimensions();
    } catch {
      return null; /* xterm not mounted yet */
    }
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows)) return null;
    return dims;
  };

  const containerUsable = () => {
    const el = containerRef.current;
    // Collapsed mid-animation (mobile keyboard) or hidden: any measure would
    // be pathological — pushing it to the runner made the TUI vanish.
    return !!el && el.clientWidth >= 8 && el.clientHeight >= 8;
  };

  // The grid this viewer would claim: what fits its visible area at its
  // preferred font, floored to stay legible.
  const preferredGrid = (): Grid | null => {
    if (!containerUsable()) return null;
    const dims = fitsAt(fontPrefRef.current);
    if (!dims) return null;
    const minCols = coarseRef.current ? TOUCH_MIN_COLS : DESKTOP_MIN_COLS;
    const grid = {
      cols: Math.min(MAX_COLS, Math.max(minCols, dims.cols)),
      rows: Math.min(MAX_ROWS, Math.max(MIN_ROWS, dims.rows)),
    };
    preferredRef.current = grid;
    return grid;
  };

  // Render the grid in force (the runner's, else our own preferred one) at
  // the largest font ≤ the preferred size that fits the container.
  const layoutNow = () => {
    const term = termRef.current;
    if (!term || !containerUsable()) return;
    const preferred = preferredGrid();
    const grid = ptySizeRef.current ?? preferred;
    if (!grid) return;
    setForeignGrid(!!ptySizeRef.current && !!preferred && !sameGrid(ptySizeRef.current, preferred));

    const fits = (size: number) => {
      const d = fitsAt(size);
      return !!d && d.cols >= grid.cols && d.rows >= grid.rows;
    };
    // Fitting is monotonic in font size: binary search over FONT_STEP steps.
    const top = fontPrefRef.current;
    let chosen = FONT_MIN;
    if (fits(top)) {
      chosen = top;
    } else {
      let lo = 0; // index of FONT_MIN
      let hi = Math.round((top - FONT_MIN) / FONT_STEP) - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const size = FONT_MIN + mid * FONT_STEP;
        if (fits(size)) {
          chosen = size;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
    }
    if (term.options.fontSize !== chosen) term.options.fontSize = chosen;
    if (term.cols !== grid.cols || term.rows !== grid.rows) {
      try {
        term.resize(grid.cols, grid.rows);
      } catch {
        /* xterm not mounted yet */
      }
    }
  };

  // Make this viewer the one driving the shared grid. `force` re-sends even
  // an unchanged claim (another viewer may have taken the grid since).
  const claimNow = (force = false) => {
    const ws = wsOpen();
    const grid = preferredGrid();
    if (!ws || !grid) {
      layoutNow();
      return;
    }
    const alreadyInForce = sameGrid(ptySizeRef.current, grid);
    if (!alreadyInForce && (force || !sameGrid(lastClaimRef.current, grid))) {
      lastClaimRef.current = grid;
      ws.send(JSON.stringify({ type: 'resize', cols: grid.cols, rows: grid.rows }));
    } else if (alreadyInForce) {
      lastClaimRef.current = grid;
    }
    // Render now at the current grid; the runner's size frame re-lays out.
    layoutNow();
  };

  // Debounced: a burst (mobile keyboard animating, window drag) collapses
  // into one PTY resize at the final geometry instead of several SIGWINCH
  // redraws racing each other.
  // Latest geometry helpers for the WebSocket effect, which only re-runs on
  // agent change (same pattern as connectRef).
  const geometryRef = useRef({ preferredGrid, layoutNow });
  geometryRef.current = { preferredGrid, layoutNow };

  const scheduleClaim = (force = false) => {
    if (claimTimerRef.current !== null) window.clearTimeout(claimTimerRef.current);
    claimTimerRef.current = window.setTimeout(() => {
      claimTimerRef.current = null;
      claimNow(force);
    }, CLAIM_DEBOUNCE_MS);
  };

  // Constrain the container to the visible viewport so fitting sees the
  // actual user-visible area instead of the full CSS box (which on iOS
  // doesn't shrink when the soft keyboard opens). Without this the claimed
  // rows would sit partly behind the keyboard.
  const adjustForViewport = () => {
    const el = containerRef.current;
    if (!el) return;
    const vv = window.visualViewport ?? undefined;
    if (!vv || vv.height >= window.innerHeight - 1) {
      el.style.maxHeight = '';
      return;
    }
    const rect = el.getBoundingClientRect();
    const topOffset = rect.top - vv.offsetTop;
    el.style.maxHeight = `${Math.max(0, Math.floor(vv.height - topOffset))}px`;
  };

  // The runner reports the tmux session ended (CLI quit/killed). Reconnecting
  // makes the runner spawn a fresh session, so offer an explicit relaunch.
  const relaunch = () => {
    setExitedState(false);
    suppressReconnectRef.current = false;
    reconnectAttemptRef.current = 0;
    const term = termRef.current;
    if (term) {
      term.reset();
      term.clear();
    }
    setTerminalActive(false);
    try {
      wsRef.current?.close();
    } catch {
      /* noop */
    }
    wsRef.current = null;
    connectRef.current?.();
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

  // Send a key sequence from an on-screen button. The user is interacting
  // with THIS viewer, so it takes the grid first. `refocus` puts the caret
  // back in xterm (desktop header buttons); the touch bar leaves focus alone
  // so pressing an arrow doesn't pop the soft keyboard open.
  const sendKey = (seq: string, refocus: boolean) => {
    if (!wsOpen()) return;
    claimNow();
    sendToRunner(seq);
    if (refocus) termRef.current?.focus();
  };

  const changeFont = (delta: number) => {
    const next = Math.min(FONT_MAX, Math.max(FONT_MIN, fontPrefRef.current + delta));
    if (next === fontPrefRef.current) return;
    fontPrefRef.current = next;
    setFontPref(next);
    storeFont(next);
    claimNow(true);
  };

  const scrollToBottom = () => {
    termRef.current?.scrollToBottom();
    setScrolledUp(false);
  };

  // ── xterm.js setup ────────────────────────────────────────────────────
  useEffect(() => {
    aliveRef.current = true;
    const container = containerRef.current;
    if (!container) return undefined;

    const term = new XTerminal({
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "SFMono-Regular", "Segoe UI Mono", Menlo, Consolas, monospace',
      fontSize: fontPrefRef.current,
      // 1.2 keeps box-drawing TUIs (Claude Code's frames) joined vertically;
      // taller line heights leave gaps between the │ glyphs.
      lineHeight: 1.2,
      letterSpacing: 0,
      scrollback: SCROLLBACK_LINES,
      altClickMovesCursor: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      scrollOnUserInput: true,
      theme: getTerminalTheme(theme),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const claudeOAuthLinkProvider = term.registerLinkProvider(createClaudeOAuthLinkProvider(term));
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (CLAUDE_OAUTH_PREFIXES.some(p => uri.startsWith(p))) {
          event.preventDefault();
          openExternalLink(reconstructClaudeOAuthUrlFromBuffer(term, uri));
          return;
        }
        openExternalLink(uri);
      })
    );
    term.open(container);
    if (term.element) {
      // When even FONT_MIN cannot fit the grid, `.xterm` grows to the grid's
      // pixel width so the container scrolls instead of clipping the right
      // columns (xterm gives `.xterm` no width of its own).
      term.element.style.minWidth = 'max-content';
      // Breathing room; FitAddon subtracts the element's own padding.
      term.element.style.padding = '4px 6px';
    }
    termRef.current = term;
    fitRef.current = fit;
    layoutNow();

    window.requestAnimationFrame(() => {
      layoutNow();
      if (!coarseRef.current) term.focus();
    });

    // Web/local fonts can finish loading after the first measure, changing
    // the cell size: re-fit once they are ready.
    document.fonts?.ready
      .then(() => {
        if (aliveRef.current) claimNow();
      })
      .catch(() => {});

    // This viewer's own visible area changed (window, sidebar, devtools,
    // browser zoom, soft keyboard via adjustForViewport) → the user is here,
    // so it claims the grid for its new size.
    // Border-box size only: a scrollbar appearing inside the container (grid
    // overflowing at FONT_MIN) is not the user resizing anything and must not
    // make a passive viewer steal the grid.
    let boxW = -1;
    let boxH = -1;
    const resizeObserver = new ResizeObserver(() => {
      if (container.offsetWidth === boxW && container.offsetHeight === boxH) return;
      boxW = container.offsetWidth;
      boxH = container.offsetHeight;
      scheduleClaim();
    });
    resizeObserver.observe(container);

    const onViewportChange = () => {
      adjustForViewport();
      scheduleClaim();
    };
    const vv = window.visualViewport ?? undefined;
    if (vv) {
      vv.addEventListener('resize', onViewportChange);
      vv.addEventListener('scroll', onViewportChange);
    }
    window.addEventListener('orientationchange', onViewportChange);

    // Coming back to this window/tab = interacting with this viewer.
    const onFocus = () => scheduleClaim(true);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleClaim(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibility);

    const pointerMq = window.matchMedia?.('(pointer: coarse)');
    const onPointerMq = () => {
      coarseRef.current = isCoarsePointer();
      setCoarse(coarseRef.current);
      scheduleClaim();
    };
    pointerMq?.addEventListener?.('change', onPointerMq);

    // Track whether the user scrolled up into the history, for the "jump to
    // bottom" button.
    const updateScrolled = () => {
      const buf = term.buffer.active;
      setScrolledUp(buf.viewportY < buf.baseY);
    };
    const scrollSub = term.onScroll(updateScrolled);
    const viewportEl = term.element?.querySelector('.xterm-viewport') ?? null;
    viewportEl?.addEventListener('scroll', updateScrolled, { passive: true });

    // Keystrokes → bytes to the runner. Typing means this viewer is the
    // active one: take the grid first (immediately, not debounced) so the
    // TUI answers at a size this screen can show. When the session has
    // ended, any keypress relaunches it instead of being dropped.
    const dataSub = term.onData(data => {
      if (exitedRef.current) {
        relaunch();
        return;
      }
      const preferred = preferredRef.current;
      if (preferred && !sameGrid(ptySizeRef.current, preferred)) claimNow(true);
      sendToRunner(data);
    });

    return () => {
      aliveRef.current = false;
      resizeObserver.disconnect();
      if (vv) {
        vv.removeEventListener('resize', onViewportChange);
        vv.removeEventListener('scroll', onViewportChange);
      }
      window.removeEventListener('orientationchange', onViewportChange);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
      pointerMq?.removeEventListener?.('change', onPointerMq);
      viewportEl?.removeEventListener('scroll', updateScrolled);
      scrollSub.dispose();
      dataSub.dispose();
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (activityTimerRef.current !== null) {
        window.clearTimeout(activityTimerRef.current);
        activityTimerRef.current = null;
      }
      if (claimTimerRef.current !== null) {
        window.clearTimeout(claimTimerRef.current);
        claimTimerRef.current = null;
      }
      try {
        wsRef.current?.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
      claudeOAuthLinkProvider.dispose();
      try {
        term.dispose();
      } catch {
        /* noop */
      }
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
  // changing `agent.id` reopens cleanly.
  useEffect(() => {
    if (!agent.id) return undefined;

    const connect = () => {
      if (!aliveRef.current) return;
      const term = termRef.current;
      if (!term) return;
      // A new attach claims the grid: the handshake carries this viewer's
      // preferred size, which the runner applies before anything is drawn.
      const grid = geometryRef.current.preferredGrid() ?? { cols: term.cols, rows: term.rows };
      ptySizeRef.current = null;
      lastClaimRef.current = grid;

      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = new URL(
        `${proto}//${window.location.host}/ws/agents/${encodeURIComponent(agent.id)}/terminal`
      );
      url.searchParams.set('cols', String(grid.cols));
      url.searchParams.set('rows', String(grid.rows));

      const ws = new WebSocket(url.toString());
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;
      suppressReconnectRef.current = false;
      setExitedState(false);

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        reconnectAttemptRef.current = 0;
        setConnected(true);
        if (!coarseRef.current) term.focus();
        // Ask the runner to repaint the current screen right now (the attach
        // already does, this covers a geometry that settled meanwhile).
        ws.send(JSON.stringify({ type: 'refresh' }));
      };

      ws.onmessage = ev => {
        if (wsRef.current !== ws) return;
        const t = termRef.current;
        if (!t) return;
        if (typeof ev.data === 'string') {
          let ctrl: TerminalControlFrame;
          try {
            ctrl = JSON.parse(ev.data);
          } catch {
            markTerminalActivity();
            t.write(ev.data);
            return;
          }
          if (ctrl?.type === 'reset') {
            t.reset();
            t.clear();
            setTerminalActive(false);
            setScrolledUp(false);
          } else if (ctrl?.type === 'size') {
            const cols = Number(ctrl.cols);
            const rows = Number(ctrl.rows);
            if (Number.isFinite(cols) && Number.isFinite(rows) && cols > 0 && rows > 0) {
              // Applied synchronously: the bytes that follow on this socket
              // were drawn for this grid.
              ptySizeRef.current = { cols, rows };
              geometryRef.current.layoutNow();
            }
          } else if (ctrl?.type === 'exit') {
            // The CLI/tmux session genuinely ended. Don't auto-loop (a crash
            // on startup would spin) — latch exited and offer an explicit
            // relaunch (Relaunch button or any keypress).
            suppressReconnectRef.current = true;
            setExitedState(true);
            setConnected(false);
            const code =
              ctrl.code === null || ctrl.code === undefined ? 'unknown' : String(ctrl.code);
            const tail = typeof ctrl.tail === 'string' ? ctrl.tail.trim() : '';
            t.writeln(`\r\n\x1b[2m[runner session ended, code=${code}]\x1b[0m`);
            if (tail) {
              const lines = tail
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(Boolean)
                .slice(-6);
              for (const line of lines) {
                t.writeln(`\x1b[2m${line}\x1b[0m`);
              }
            }
            t.writeln('\x1b[2m[press Enter or click Relaunch to start a new session]\x1b[0m');
          } else if (ctrl?.type === 'error') {
            t.writeln(`\r\n\x1b[31m[error: ${ctrl.message || 'unknown'}]\x1b[0m`);
          }
          return;
        }
        // Binary frame = raw PTY bytes.
        const buf = new Uint8Array(ev.data as ArrayBuffer);
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
        // Surfacing it would flash false alerts during transient blips.
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

    // Publish connect() so relaunch() (component scope) can re-open on demand.
    connectRef.current = connect;

    connect();
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      connectRef.current = null;
      try {
        wsRef.current?.close();
      } catch {
        /* noop */
      }
      wsRef.current = null;
      setConnected(false);
      setExitedState(false);
    };
  }, [agent.id]);

  const shellClass = theme === 'light' ? 'bg-white text-gray-700' : 'bg-dark-900 text-dark-200';
  const headerClass =
    theme === 'light'
      ? 'border-gray-200 text-gray-500 bg-gray-50'
      : 'border-dark-700/50 text-dark-400 bg-dark-900';
  const bodyClass = theme === 'light' ? 'bg-white' : 'bg-dark-900';
  const btnClass =
    theme === 'light'
      ? 'border-gray-300 bg-white hover:bg-gray-100 text-gray-600'
      : 'border-dark-700/60 bg-dark-800/60 hover:bg-dark-700/60 hover:text-dark-100';
  const iconBtn = `flex items-center justify-center w-7 h-7 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${btnClass}`;
  const statusLabel = connected
    ? terminalActive
      ? 'active'
      : 'connected'
    : exited
      ? 'ended'
      : 'reconnecting';
  // Buttons must not steal focus from xterm's hidden textarea: on a phone
  // that would close the soft keyboard at every tap.
  const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

  return (
    <div className={`flex flex-col h-full min-h-0 ${shellClass}`}>
      <div className={`flex items-center gap-2 px-3 py-1.5 border-b text-xs ${headerClass}`}>
        <TerminalIcon className="w-3.5 h-3.5 text-indigo-400 shrink-0" />
        <span className="hidden sm:inline">Terminal</span>
        <span className="opacity-60 truncate">{agent.runner || 'cli'}</span>
        <div className="ml-auto flex items-center gap-1.5">
          {foreignGrid && connected && (
            <button
              type="button"
              onMouseDown={keepFocus}
              onClick={() => claimNow(true)}
              title="Another screen set the terminal size — fit it to this screen"
              aria-label="Fit terminal to this screen"
              className={`flex items-center gap-1 px-2 h-7 rounded border text-[11px] ${btnClass}`}
            >
              <Maximize2 className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Fit here</span>
            </button>
          )}
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => changeFont(-FONT_STEP * 2)}
            disabled={fontPref <= FONT_MIN}
            title="Smaller text (more columns)"
            aria-label="Smaller text"
            className={iconBtn}
          >
            <ZoomOut className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => changeFont(FONT_STEP * 2)}
            disabled={fontPref >= FONT_MAX}
            title="Larger text (fewer columns)"
            aria-label="Larger text"
            className={iconBtn}
          >
            <ZoomIn className="w-3.5 h-3.5" />
          </button>
          {!coarse && (
            <>
              <button
                type="button"
                onClick={() => sendKey('\x1b[A', true)}
                disabled={!connected}
                title="Up arrow — select previous option"
                aria-label="Send up arrow"
                className={iconBtn}
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => sendKey('\x1b[B', true)}
                disabled={!connected}
                title="Down arrow — select next option"
                aria-label="Send down arrow"
                className={iconBtn}
              >
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                onClick={() => sendKey('\r', true)}
                disabled={!connected}
                title="Enter — confirm selection"
                aria-label="Send enter"
                className={iconBtn}
              >
                <CornerDownLeft className="w-3.5 h-3.5" />
              </button>
            </>
          )}
          {exited && (
            <button
              type="button"
              onClick={relaunch}
              title="Relaunch the CLI session"
              aria-label="Relaunch session"
              className="flex items-center gap-1 px-2 h-7 rounded border border-indigo-500/50 bg-indigo-600/20 text-indigo-300 hover:bg-indigo-600/30 transition-colors text-[11px] font-medium"
            >
              <RotateCcw className="w-3.5 h-3.5" /> Relaunch
            </button>
          )}
          <span
            className={`ml-1 w-2 h-2 rounded-full shrink-0 ${
              connected
                ? terminalActive
                  ? 'bg-emerald-400'
                  : 'bg-emerald-600'
                : exited
                  ? 'bg-gray-500'
                  : 'bg-amber-500 animate-pulse'
            }`}
            title={`${statusLabel} · multi-client`}
          />
          <span className="opacity-60 hidden md:inline">{statusLabel} · multi-client</span>
        </div>
      </div>
      <div className={`relative min-h-0 flex-1 ${bodyClass}`}>
        <div
          ref={containerRef}
          // Absolutely inset so its box is exactly the free area (what
          // FitAddon measures), never grown by the terminal inside it.
          // overflow-auto only matters when FONT_MIN still can't fit the grid.
          className="absolute inset-0 overflow-auto"
          style={{ touchAction: 'manipulation', overscrollBehavior: 'contain' }}
          onClick={() => termRef.current?.focus()}
        />
        {scrolledUp && (
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={scrollToBottom}
            title="Back to the live screen"
            aria-label="Scroll to bottom"
            className="absolute bottom-3 right-5 z-10 flex items-center gap-1 px-2.5 h-8 rounded-full border border-indigo-500/50 bg-indigo-600/90 text-white shadow-lg text-[11px] font-medium"
          >
            <ChevronsDown className="w-3.5 h-3.5" /> Live
          </button>
        )}
      </div>
      {coarse && (
        // Touch key bar: the keys a phone keyboard cannot send to a TUI.
        <div
          className={`flex items-center gap-1 px-2 py-1.5 border-t overflow-x-auto ${headerClass}`}
          style={{ paddingBottom: 'max(0.375rem, env(safe-area-inset-bottom))' }}
        >
          {TOUCH_KEYS.map(k => (
            <button
              key={k.label}
              type="button"
              onMouseDown={keepFocus}
              onClick={() => sendKey(k.seq, false)}
              disabled={!connected}
              title={k.title}
              aria-label={`Send ${k.title}`}
              className={`shrink-0 h-9 min-w-[2.75rem] px-2 rounded border text-xs font-mono ${btnClass} disabled:opacity-40`}
            >
              {k.label}
            </button>
          ))}
          {(
            [
              ['\x1b[D', ArrowLeft, 'Left arrow'],
              ['\x1b[A', ArrowUp, 'Up arrow'],
              ['\x1b[B', ArrowDown, 'Down arrow'],
              ['\x1b[C', ArrowRight, 'Right arrow'],
              ['\r', CornerDownLeft, 'Enter'],
            ] as const
          ).map(([seq, Icon, title]) => (
            <button
              key={title}
              type="button"
              onMouseDown={keepFocus}
              onClick={() => sendKey(seq, false)}
              disabled={!connected}
              title={title}
              aria-label={`Send ${title}`}
              className={`shrink-0 flex items-center justify-center h-9 w-11 rounded border ${btnClass} disabled:opacity-40`}
            >
              <Icon className="w-4 h-4" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
