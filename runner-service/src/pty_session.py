"""
Shared-PTY broker for interactive terminal sessions.

One subprocess per agent_id, regardless of how many WebSocket clients are
attached. All clients see the same output (scrollback replayed on attach,
live bytes broadcast as they arrive); any client can type and the keystrokes
go to the same PTY. Lifecycle:

    1. First WS attach for an agent_id → spawn the backend's CLI in a fresh
       PTY (cmd/cwd/env/preexec_fn come from `backend.prepare_interactive`).
    2. Subsequent WS attaches for the same agent_id → join the existing
       session and receive the scrollback ring buffer immediately.
    3. Last WS detaches → the session stays alive (so re-opening the page
       doesn't lose context). A background timer kills the subprocess if
       it sits idle without any client for `IDLE_TIMEOUT_SEC`.
    4. Subprocess exits on its own → session is reaped, future attaches
       trigger a fresh spawn.

This module is intentionally agnostic about WHICH CLI is running — the
backend's `prepare_interactive()` returns the launch recipe and we just
drive the PTY. Resize, scrollback bound, and broadcast are generic.
"""
from __future__ import annotations

import os
import pty
import json
import fcntl
import struct
import termios
import signal
import asyncio
import subprocess
import re
import time
from collections import deque
from typing import Awaitable, Callable, Optional
from dataclasses import dataclass, field

from config import logger


# How often the PTY session polls `<HOME>/.claude/.credentials.json` for a
# fresh token written by the CLI's `/login` flow. 5 s is responsive enough
# that closing the browser right after pasting the verification code still
# captures the new token before the WS detaches, and the stat cost is
# negligible.
CREDS_SYNC_INTERVAL_SEC = float(os.getenv("TERMINAL_CREDS_SYNC_INTERVAL_SEC", "5.0"))

try:
    import pyte  # type: ignore
except Exception:
    pyte = None


# Tunables — picked to be safe defaults, not necessarily optimal. Operators
# can override via env if a deployment ever needs to.
SCROLLBACK_BYTES = int(os.getenv("TERMINAL_SCROLLBACK_BYTES", str(256 * 1024)))  # 256 KB
IDLE_TIMEOUT_SEC = int(os.getenv("TERMINAL_IDLE_TIMEOUT_SEC", str(60 * 60)))     # 1 h
DEFAULT_COLS = 120
DEFAULT_ROWS = 40
READ_CHUNK = 4096
SNAPSHOT_INTERVAL_SEC = max(
    0.03,
    int(os.getenv("TERMINAL_SNAPSHOT_INTERVAL_MS", "100")) / 1000,
)

_ANSI_RE = re.compile(
    r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))"
)
_TRUST_RE = re.compile(
    r"(do\s*you\s*trust\s*this\s*folder"
    r"|is\s*this\s*a\s*project\s*you\s*(created|trust)"
    r"|trust\s*this\s*folder\s*\?"
    r"|yes,?\s*i\s*trust\s*this\s*folder)",
    re.IGNORECASE,
)
_BYPASS_PERMS_RE = re.compile(
    r"(bypass\s*permissions\s*mode|yes,?\s*i\s*accept)",
    re.IGNORECASE,
)
_AUTO_ANSWER_COOLDOWN_S = 1.0


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


# A "client" callback type: an async function the session calls to push
# bytes (raw PTY output) to one connected WebSocket. Each WS handler
# registers one such callback at attach time.
ClientCallback = Callable[[bytes], Awaitable[None]]


@dataclass
class _Client:
    """One attached observer. We hold callbacks (not WebSocket objects
    directly) so this module stays framework-agnostic."""
    on_output: ClientCallback
    # Tracked just for logging / status — never the source of truth.
    label: str = "?"


@dataclass
class PtySession:
    """One shared PTY + subprocess + scrollback + N attached observers."""

    agent_id: str
    cmd: list[str]
    cwd: str
    env: dict
    preexec_fn: Optional[Callable] = None
    cols: int = DEFAULT_COLS
    rows: int = DEFAULT_ROWS
    config_fingerprint: Optional[str] = None
    render_mode: str = "raw"
    # Reverse-sync of in-TUI `/login` results back to the backend store. The
    # backend's `prepare_interactive` recipe supplies both fields; when
    # either is None the polling loop is a no-op.
    creds_watch_path: Optional[str] = None
    creds_on_change: Optional[Callable[[dict], None]] = None

    # Internals — filled in by start() and the background reader.
    master_fd: int = -1
    proc: Optional[subprocess.Popen] = None
    scrollback: deque = field(default_factory=lambda: deque(maxlen=1))  # placeholder
    _scrollback_size: int = 0
    _clients: dict[int, _Client] = field(default_factory=dict)
    _next_client_id: int = 0
    _reader_task: Optional[asyncio.Task] = None
    _idle_timer: Optional[asyncio.Task] = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _closed: bool = False
    exit_code: Optional[int] = None
    _auto_answer_buf: bytearray = field(default_factory=bytearray)
    _auto_answered: set[str] = field(default_factory=set)
    _last_auto_answer_at: float = 0.0
    _screen: Optional[object] = None
    _screen_stream: Optional[object] = None
    _snapshot_task: Optional[asyncio.Task] = None
    _snapshot_dirty: bool = False
    _creds_sync_task: Optional[asyncio.Task] = None
    _last_synced_access_token: Optional[str] = None
    _last_creds_mtime: float = 0.0

    def _snapshot_enabled(self) -> bool:
        return self.render_mode == "snapshot" and self._screen is not None and self._screen_stream is not None

    async def start(self) -> None:
        """Spawn the subprocess in a fresh PTY and start the reader loop."""
        if self.proc is not None:
            return
        self.scrollback = deque()  # holds raw byte chunks; size bounded manually
        self._scrollback_size = 0
        self._init_screen_renderer()

        master_fd, slave_fd = pty.openpty()
        # Honour the agreed window size before the child execs so the TUI
        # lays out at our chosen geometry on first paint.
        try:
            fcntl.ioctl(
                slave_fd, termios.TIOCSWINSZ,
                struct.pack("HHHH", self.rows, self.cols, 0, 0),
            )
        except OSError as e:
            logger.debug(f"[Terminal] TIOCSWINSZ failed at spawn: {e}")

        env = {
            **self.env,
            "COLUMNS": str(self.cols),
            "LINES": str(self.rows),
            "TERM": self.env.get("TERM", "xterm-256color"),
        }

        try:
            self.proc = subprocess.Popen(
                self.cmd,
                cwd=self.cwd,
                env=env,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                preexec_fn=self.preexec_fn,
                close_fds=True,
            )
        except Exception as e:
            os.close(master_fd)
            os.close(slave_fd)
            logger.error(f"[Terminal] Failed to spawn {self.cmd[0]} for agent {self.agent_id}: {e}")
            raise

        os.close(slave_fd)
        self.master_fd = master_fd
        logger.info(
            f"[Terminal] Spawned PTY session for agent {self.agent_id} "
            f"(pid={self.proc.pid}, cols={self.cols}, rows={self.rows}, cmd={self.cmd!r}, cwd={self.cwd})"
        )

        loop = asyncio.get_running_loop()
        self._reader_task = loop.create_task(self._read_loop())
        # Baseline the credentials.json that `seed_credentials_file` just
        # wrote so the polling loop only fires when the CLI's /login flow
        # produces a NEWER token. Without this baseline, the first poll
        # would always treat the seed as "fresh" and push it back to the
        # store unnecessarily.
        if self.creds_watch_path and self.creds_on_change:
            self._capture_creds_baseline()
            self._creds_sync_task = loop.create_task(self._creds_sync_loop())

    def _capture_creds_baseline(self) -> None:
        try:
            self._last_creds_mtime = os.path.getmtime(self.creds_watch_path)
            with open(self.creds_watch_path) as f:
                data = json.load(f)
            self._last_synced_access_token = (data.get("claudeAiOauth") or {}).get("accessToken")
        except (OSError, json.JSONDecodeError):
            # Missing or unreadable seed is fine — any write the CLI makes
            # afterward will appear "newer" and trigger the first sync.
            self._last_creds_mtime = 0.0
            self._last_synced_access_token = None

    async def _creds_sync_loop(self) -> None:
        """Poll `creds_watch_path` until the session closes.

        Any change to the file's mtime triggers a re-read; if the parsed
        accessToken differs from the last one we pushed, we call
        `creds_on_change` (which persists to team-api / local store). The
        callable is sync and may do blocking HTTP, so we run it in a
        thread executor to avoid stalling the event loop.
        """
        try:
            while not self._closed:
                try:
                    await asyncio.sleep(CREDS_SYNC_INTERVAL_SEC)
                except asyncio.CancelledError:
                    return
                if self._closed:
                    return
                await self._maybe_sync_creds()
        except Exception as e:
            logger.warning(f"[Terminal] creds sync loop crashed for {self.agent_id}: {e}")

    async def _maybe_sync_creds(self) -> None:
        if not self.creds_watch_path or not self.creds_on_change:
            return
        try:
            mtime = os.path.getmtime(self.creds_watch_path)
        except OSError:
            return
        if mtime <= self._last_creds_mtime:
            return
        try:
            with open(self.creds_watch_path) as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            logger.debug(f"[Terminal] creds read failed for {self.agent_id}: {e}")
            return
        access = (data.get("claudeAiOauth") or {}).get("accessToken")
        if not access:
            self._last_creds_mtime = mtime
            return
        if access == self._last_synced_access_token:
            self._last_creds_mtime = mtime
            return
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, self.creds_on_change, data)
        except Exception as e:
            logger.warning(f"[Terminal] creds_on_change failed for {self.agent_id}: {e}")
            return
        self._last_synced_access_token = access
        self._last_creds_mtime = mtime
        logger.info(
            f"[Terminal] Persisted fresh OAuth token to backend store for agent {self.agent_id} "
            f"(triggered by in-TUI /login)"
        )

    def _init_screen_renderer(self) -> None:
        if self.render_mode != "snapshot":
            return
        if pyte is None:
            logger.warning(
                f"[Terminal] Snapshot render requested for {self.agent_id}, "
                "but pyte is unavailable; falling back to raw PTY streaming"
            )
            self.render_mode = "raw"
            return
        try:
            self._screen = pyte.Screen(self.cols, self.rows)
            self._screen_stream = pyte.ByteStream(self._screen)
            logger.info(
                f"[Terminal] Snapshot renderer enabled for agent {self.agent_id} "
                f"({self.cols}x{self.rows})"
            )
        except Exception as e:
            logger.warning(f"[Terminal] Snapshot renderer init failed for {self.agent_id}: {e}")
            self.render_mode = "raw"
            self._screen = None
            self._screen_stream = None

    def _record_output(self, data: bytes) -> None:
        self._append_scrollback(data)
        if self._snapshot_enabled():
            try:
                self._screen_stream.feed(data)
                self._snapshot_dirty = True
            except Exception as e:
                logger.warning(f"[Terminal] Snapshot feed failed for {self.agent_id}: {e}")
                self.render_mode = "raw"

    async def _handle_output(self, data: bytes) -> None:
        self._record_output(data)
        if self._snapshot_enabled():
            self._schedule_snapshot_broadcast()
        else:
            await self._broadcast(data)

    def _schedule_snapshot_broadcast(self) -> None:
        if self._snapshot_task is not None and not self._snapshot_task.done():
            return

        async def _send_later() -> None:
            await asyncio.sleep(SNAPSHOT_INTERVAL_SEC)
            self._snapshot_task = None
            if self._closed or not self._snapshot_dirty:
                return
            self._snapshot_dirty = False
            await self._broadcast(self._snapshot_bytes())

        self._snapshot_task = asyncio.create_task(_send_later())

    def _snapshot_bytes(self) -> bytes:
        screen = self._screen
        if screen is None:
            return b""
        display = list(getattr(screen, "display", []) or [])
        rows = self.rows
        cols = self.cols
        # Repaint by absolute cursor moves, not by CRLF. Writing a full screen
        # with newlines makes xterm grow scrollback and can trigger autowrap at
        # the right edge. Disable autowrap while painting, clear the viewport
        # and scrollback, then restore the cursor.
        parts = ["\x1b[?25l\x1b[?7l\x1b[H\x1b[2J\x1b[3J"]
        for idx in range(rows):
            line = display[idx] if idx < len(display) else ""
            if len(line) > cols:
                line = line[:cols]
            line = line.rstrip()
            parts.append(f"\x1b[{idx + 1};1H")
            if line:
                parts.append(line)
            parts.append("\x1b[K")
        cursor = getattr(screen, "cursor", None)
        cursor_x = max(0, min(cols - 1, int(getattr(cursor, "x", 0) or 0)))
        cursor_y = max(0, min(rows - 1, int(getattr(cursor, "y", 0) or 0)))
        parts.append(f"\x1b[{cursor_y + 1};{cursor_x + 1}H\x1b[?7h\x1b[?25h")
        return "".join(parts).encode("utf-8", errors="replace")


    async def _read_loop(self) -> None:
        """Read from master_fd and append to scrollback + broadcast to clients.

        Uses `loop.add_reader` for non-blocking integration with asyncio so we
        don't tie up a thread.
        """
        loop = asyncio.get_running_loop()
        # `loop.add_reader` calls our callback when the fd is readable; we
        # then do a single os.read and re-arm by virtue of the watcher
        # staying registered.
        chunk_event = asyncio.Event()
        latest_chunk: list[bytes] = []

        def _on_readable() -> None:
            try:
                data = os.read(self.master_fd, READ_CHUNK)
            except OSError:
                data = b""
            if not data:
                # EOF / EIO — child closed the slave side. Mark dead.
                latest_chunk.append(b"")
            else:
                latest_chunk.append(data)
            chunk_event.set()

        try:
            loop.add_reader(self.master_fd, _on_readable)
        except (OSError, ValueError) as e:
            logger.warning(f"[Terminal] add_reader failed for {self.agent_id}: {e}")
            return

        try:
            while not self._closed:
                try:
                    await asyncio.wait_for(chunk_event.wait(), timeout=0.2)
                except asyncio.TimeoutError:
                    self._maybe_auto_answer_startup_prompt()
                    continue
                chunk_event.clear()
                while latest_chunk:
                    data = latest_chunk.pop(0)
                    if not data:
                        # EOF: subprocess closed its end of the PTY.
                        logger.info(f"[Terminal] EOF on master_fd for agent {self.agent_id}")
                        await self._on_subprocess_exit()
                        return
                    await self._handle_output(data)
                    self._maybe_auto_answer_startup_prompt(data)
                self._maybe_auto_answer_startup_prompt()
        finally:
            try:
                loop.remove_reader(self.master_fd)
            except (OSError, ValueError):
                pass

    def _write_keystroke(self, data: bytes) -> None:
        if self.master_fd < 0 or self._closed:
            return
        try:
            os.write(self.master_fd, data)
        except OSError as e:
            logger.debug(f"[Terminal] auto-answer write failed for {self.agent_id}: {e}")

    def _maybe_auto_answer_startup_prompt(self, data: bytes = b"") -> None:
        """Dismiss Claude Code startup confirmations in the shared terminal.

        The one-shot PTY driver already handles these screens, but the shared
        /ws terminal intentionally runs as a transparent PTY broker. Without a
        tiny prompt recognizer here, Claude Code can stop on first-run trust /
        bypass-permissions confirmations before the user can use the terminal.
        """
        if data:
            self._auto_answer_buf.extend(data)
            if len(self._auto_answer_buf) > 8192:
                del self._auto_answer_buf[:-8192]

        if self.master_fd < 0 or self._closed:
            return
        if time.monotonic() - self._last_auto_answer_at < _AUTO_ANSWER_COOLDOWN_S:
            return

        tail = _strip_ansi(self._auto_answer_buf.decode("utf-8", errors="replace"))[-4096:]
        if not tail.strip():
            return

        if "trust" not in self._auto_answered and _TRUST_RE.search(tail):
            # Option 1 ("Yes, I trust this folder") is highlighted by default
            # in Claude Code's TUI; Enter confirms it without leaking a typed
            # "1" into the following screen.
            logger.info(f"[Terminal] Auto-answer trust-folder prompt for agent {self.agent_id}: Enter")
            self._write_keystroke(b"\r")
            self._auto_answered.add("trust")
            self._last_auto_answer_at = time.monotonic()
            return

        if "bypass" not in self._auto_answered and _BYPASS_PERMS_RE.search(tail):
            # On the bypass-permissions warning, option 1 is "No, exit" and
            # option 2 is "Yes, I accept". Move down once, then confirm.
            logger.info(f"[Terminal] Auto-answer bypass-permissions prompt for agent {self.agent_id}: Down+Enter")
            self._write_keystroke(b"\x1b[B")
            self._last_auto_answer_at = time.monotonic()

            async def confirm_after_render_tick() -> None:
                await asyncio.sleep(0.12)
                self._write_keystroke(b"\r")

            asyncio.create_task(confirm_after_render_tick())
            self._auto_answered.add("bypass")

    def _append_scrollback(self, data: bytes) -> None:
        """Append to the ring buffer, evicting oldest chunks once the byte
        budget is exceeded. Keeping chunks instead of a flat bytearray
        means an attaching client receives near-line-aligned bytes (the CLI
        already emits in roughly visual units), which xterm.js renders
        cleanly without partial ANSI sequences mid-frame."""
        self.scrollback.append(data)
        self._scrollback_size += len(data)
        while self._scrollback_size > SCROLLBACK_BYTES and len(self.scrollback) > 1:
            evicted = self.scrollback.popleft()
            self._scrollback_size -= len(evicted)

    async def _broadcast(self, data: bytes) -> None:
        # Snapshot the clients dict — a client may detach mid-broadcast
        # (their on_output raises) and we don't want to mutate during
        # iteration.
        snapshot = list(self._clients.items())
        for client_id, client in snapshot:
            try:
                await client.on_output(data)
            except Exception as e:
                logger.debug(f"[Terminal] Client {client_id} broadcast failed: {e}")
                # Drop the dead client — the WS handler's finally block
                # will also try to detach, but doing it eagerly here keeps
                # the snapshot list short on bursty output.
                self._clients.pop(client_id, None)

    async def attach(self, on_output: ClientCallback, label: str = "?") -> int:
        """Register a new client. Replays the current scrollback synchronously
        so the client renders the existing screen state before live bytes
        start arriving. Returns the opaque client id used for detach()."""
        async with self._lock:
            self._cancel_idle_timer()
            replay_chunks = [] if self._snapshot_enabled() else list(self.scrollback)
            snapshot = self._snapshot_bytes() if self._snapshot_enabled() else b""

        # Replay before registering the live observer. Otherwise fresh PTY
        # output can interleave with old scrollback and make the browser end
        # up behind the real process.
        for chunk in replay_chunks:
            await on_output(chunk)
        if snapshot:
            await on_output(snapshot)

        async with self._lock:
            client_id = self._next_client_id
            self._next_client_id += 1
            self._clients[client_id] = _Client(on_output=on_output, label=label)
            logger.info(
                f"[Terminal] Client {client_id} ({label}) attached to agent "
                f"{self.agent_id} (now {len(self._clients)} clients)"
            )

        return client_id

    async def detach(self, client_id: int) -> None:
        """Unregister a client. Idempotent. Schedules an idle-timeout that
        will reap the subprocess if no client reconnects in time."""
        async with self._lock:
            removed = self._clients.pop(client_id, None)
            if removed is None:
                return
            logger.info(
                f"[Terminal] Client {client_id} ({removed.label}) detached from agent "
                f"{self.agent_id} (now {len(self._clients)} clients)"
            )
            if not self._clients:
                self._schedule_idle_timer()

    async def write(self, data: bytes) -> None:
        """Send keystrokes from a client into the PTY. Any client may call
        this — the multi-writer setup is fine for a few connected admins,
        though we make no effort to serialize interleaved typing."""
        if self.master_fd < 0 or self._closed:
            return
        try:
            os.write(self.master_fd, data)
        except OSError as e:
            logger.warning(f"[Terminal] write to {self.agent_id} failed: {e}")

    async def resize(self, cols: int, rows: int) -> None:
        """Apply a new geometry. When multiple clients have different
        viewport sizes we take the smaller of each axis to avoid overflow
        on the narrower client; passing the new size through TIOCSWINSZ
        also delivers SIGWINCH to the subprocess which TUIs use to re-layout."""
        cols = max(20, min(500, int(cols)))
        rows = max(5, min(200, int(rows)))
        self.cols = cols
        self.rows = rows
        if self.master_fd < 0:
            return
        if self._snapshot_enabled():
            try:
                self._screen.resize(lines=rows, columns=cols)
            except TypeError:
                try:
                    self._screen.resize(cols, rows)
                except Exception:
                    pass
            except Exception:
                pass
            self._snapshot_dirty = True
            self._schedule_snapshot_broadcast()
        try:
            fcntl.ioctl(
                self.master_fd, termios.TIOCSWINSZ,
                struct.pack("HHHH", rows, cols, 0, 0),
            )
        except OSError as e:
            logger.debug(f"[Terminal] TIOCSWINSZ on resize failed: {e}")

    def is_alive(self) -> bool:
        return (
            self.proc is not None
            and self.proc.poll() is None
            and not self._closed
        )

    def status(self) -> dict:
        return {
            "agent_id": self.agent_id,
            "alive": self.is_alive(),
            "clients": len(self._clients),
            "pid": self.proc.pid if self.proc else None,
            "exit_code": self.exit_code,
            "scrollback_bytes": self._scrollback_size,
            "cols": self.cols,
            "rows": self.rows,
            "render_mode": self.render_mode,
        }

    def tail_text(self, max_bytes: int = 4096) -> str:
        """Return a short decoded tail of recent PTY output for diagnostics."""
        chunks: list[bytes] = []
        total = 0
        for chunk in reversed(self.scrollback):
            chunks.append(chunk)
            total += len(chunk)
            if total >= max_bytes:
                break
        data = b"".join(reversed(chunks))
        if len(data) > max_bytes:
            data = data[-max_bytes:]
        return data.decode("utf-8", errors="replace")

    async def _on_subprocess_exit(self) -> None:
        """Called when EOF on the master fd indicates the child has exited.
        Drop all clients (their WS handlers see the close and clean up) and
        mark the session for removal by the registry."""
        rc = self.proc.poll() if self.proc else None
        if rc is None and self.proc is not None:
            try:
                rc = self.proc.wait(timeout=0.05)
            except subprocess.TimeoutExpired:
                rc = None
        self.exit_code = rc
        tail = self.tail_text(2048).replace("\r", "\\r").replace("\n", "\\n")
        logger.info(
            f"[Terminal] Subprocess for agent {self.agent_id} exited "
            f"(rc={rc}, cmd={self.cmd!r}, cwd={self.cwd}, tail={tail[-1000:]!r})"
        )
        # Notify clients by closing their stream. We send a sentinel '' that
        # the WS handler interprets as "the PTY is dead, close the socket
        # politely". Without this they'd just hang reading nothing.
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            try:
                await client.on_output(b"")
            except Exception:
                pass
        await self.close()

    def _cancel_idle_timer(self) -> None:
        if self._idle_timer and not self._idle_timer.done():
            self._idle_timer.cancel()
            self._idle_timer = None

    def _schedule_idle_timer(self) -> None:
        self._cancel_idle_timer()

        async def _reap_after_idle() -> None:
            try:
                await asyncio.sleep(IDLE_TIMEOUT_SEC)
            except asyncio.CancelledError:
                return
            if not self._clients and self.is_alive():
                logger.info(
                    f"[Terminal] Idle timeout reached for agent {self.agent_id} "
                    f"after {IDLE_TIMEOUT_SEC}s with no clients — reaping"
                )
                await self.close()

        self._idle_timer = asyncio.create_task(_reap_after_idle())

    async def close(self) -> None:
        """Best-effort shutdown: send SIGTERM, wait briefly, then SIGKILL."""
        if self._closed:
            return
        # Final creds sync BEFORE we mark closed and tear the proc down — the
        # user may have done /login at the last moment and the polling
        # interval may not have fired yet. Safe even if no token is fresh:
        # _maybe_sync_creds is a no-op when nothing has changed.
        try:
            await self._maybe_sync_creds()
        except Exception as e:
            logger.warning(f"[Terminal] final creds sync failed for {self.agent_id}: {e}")
        self._closed = True
        self._cancel_idle_timer()
        if self._creds_sync_task and not self._creds_sync_task.done():
            self._creds_sync_task.cancel()
            self._creds_sync_task = None
        if self._snapshot_task and not self._snapshot_task.done():
            self._snapshot_task.cancel()
            self._snapshot_task = None

        # Try to terminate the subprocess. The runner container has
        # restricted capabilities so direct signals can EPERM when the
        # child runs as a different UID; in that case writing Ctrl-C into
        # the PTY is more reliable (the kernel delivers SIGINT to the
        # foreground process group, no CAP_KILL needed).
        if self.proc is not None and self.proc.poll() is None:
            try:
                os.write(self.master_fd, b"\x03")  # Ctrl-C via PTY
            except OSError:
                pass
            try:
                self.proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                pass
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if self.proc.poll() is not None:
                    break
                try:
                    self.proc.send_signal(sig)
                    self.proc.wait(timeout=2)
                except (subprocess.TimeoutExpired, PermissionError, ProcessLookupError, OSError):
                    pass

        if self.master_fd >= 0:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = -1

        # Drop any clients still attached (their WS handlers will detect
        # the closed stream and exit on the next poll).
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            try:
                await client.on_output(b"")
            except Exception:
                pass

        _SESSIONS.pop(self.agent_id, None)
        logger.info(f"[Terminal] Closed PTY session for agent {self.agent_id}")


# ─── Registry ──────────────────────────────────────────────────────────────
#
# Single in-process map agent_id → PtySession. The runner-service runs as a
# single asyncio process (uvicorn worker count = 1 for this kind of stateful
# work), so a plain dict + asyncio.Lock around create-or-attach is enough.

_SESSIONS: dict[str, PtySession] = {}
_REGISTRY_LOCK = asyncio.Lock()
_TRANSCRIPTS: dict[str, deque] = {}
_TRANSCRIPT_SIZES: dict[str, int] = {}


def _normalize_transcript_bytes(raw: bytes) -> bytes:
    """Make pipe output render like terminal output in xterm.js.

    PTY streams usually emit CRLF. Plain stdout/stderr pipes usually emit LF
    only, which leaves xterm at the previous column and creates the visible
    staircase effect. Keep carriage-return progress updates intact while
    converting lone LF into CRLF.
    """
    return re.sub(b"(?<!\r)\n", b"\r\n", raw)


async def append_terminal_transcript(agent_id: Optional[str], data: bytes | str) -> None:
    """Append externally-produced output to the terminal transcript and any
    live terminal clients for this agent.

    Headless workflow execution uses /v1/chat/completions and /exec-shell,
    not the shared interactive PTY. These bytes are kept in a separate
    transcript so reconnects can replay them without duplicating the PTY's
    own scrollback.
    """
    if not agent_id:
        return
    raw = data.encode("utf-8", errors="replace") if isinstance(data, str) else data
    raw = _normalize_transcript_bytes(raw)
    if not raw:
        return

    session = _SESSIONS.get(agent_id)
    if session and session.is_alive():
        await session._handle_output(raw)
        return

    transcript = _TRANSCRIPTS.setdefault(agent_id, deque())
    transcript.append(raw)
    _TRANSCRIPT_SIZES[agent_id] = _TRANSCRIPT_SIZES.get(agent_id, 0) + len(raw)
    while _TRANSCRIPT_SIZES[agent_id] > SCROLLBACK_BYTES and len(transcript) > 1:
        evicted = transcript.popleft()
        _TRANSCRIPT_SIZES[agent_id] -= len(evicted)


async def replay_terminal_transcript(agent_id: str, on_output: ClientCallback) -> None:
    for chunk in list(_TRANSCRIPTS.get(agent_id) or []):
        await on_output(chunk)


async def get_or_create_session(
    agent_id: str,
    factory: Callable[[], Awaitable[dict]],
    cols: int = DEFAULT_COLS,
    rows: int = DEFAULT_ROWS,
    config_fingerprint: Optional[str] = None,
) -> PtySession:
    """Return the existing session for `agent_id` or spawn a new one.

    `factory` is awaited only when we need to spawn — it must return a dict
    with keys cmd/cwd/env/preexec_fn (the shape returned by a backend's
    `prepare_interactive`). Wrapping the per-spawn setup (HOME provisioning,
    token hydration, etc.) in a callback avoids doing that work needlessly
    when the session already exists.
    """
    async with _REGISTRY_LOCK:
        existing = _SESSIONS.get(agent_id)
        if (
            existing is not None
            and existing.is_alive()
            and (
                config_fingerprint is None
                or existing.config_fingerprint == config_fingerprint
            )
        ):
            return existing
        # Either no session yet, or the previous one died — replace it.
        if existing is not None:
            await existing.close()
        recipe = await factory()
        session = PtySession(
            agent_id=agent_id,
            cmd=recipe["cmd"],
            cwd=recipe["cwd"],
            env=recipe["env"],
            preexec_fn=recipe.get("preexec_fn"),
            cols=cols,
            rows=rows,
            config_fingerprint=config_fingerprint,
            render_mode=recipe.get("render_mode", "raw"),
            creds_watch_path=recipe.get("creds_watch_path"),
            creds_on_change=recipe.get("creds_on_change"),
        )
        await session.start()
        _SESSIONS[agent_id] = session
        return session


def get_session(agent_id: str) -> Optional[PtySession]:
    return _SESSIONS.get(agent_id)


def list_sessions() -> list[dict]:
    return [s.status() for s in _SESSIONS.values()]


async def close_session(agent_id: str) -> bool:
    session = _SESSIONS.get(agent_id)
    if session is None:
        return False
    await session.close()
    return True


async def close_all_sessions() -> None:
    """Shutdown hook — terminate every live session on service stop."""
    sessions = list(_SESSIONS.values())
    for s in sessions:
        try:
            await s.close()
        except Exception as e:
            logger.warning(f"[Terminal] close_all_sessions error on {s.agent_id}: {e}")
