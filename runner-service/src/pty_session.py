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

Security note: keystrokes and the processes the CLI spawns do NOT pass through
`command_security.validate_command()`, and adding a screen here would be
security theatre — a PTY carries an interactive byte stream, not commands, and
the CLI forks children we never see. Containment for everything running in this
PTY is the per-agent UID (`agent_user.py`, 0700 HOME), the container's
`cap_drop: ALL` + `no-new-privileges:true` policy, and the sanitised environment
built by `command_security.sanitize_env()` in the backend's launch recipe.
"""
from __future__ import annotations

import os
import errno
import pty
import json
import fcntl
import struct
import termios
import signal
import asyncio
import shutil
import subprocess
import re
import time
from collections import deque
from typing import Awaitable, Callable, Optional
from dataclasses import dataclass, field
from enum import Enum

from config import logger
# Leaf module (re/dataclasses only) — pty_session must not import anything
# from the backends package, whose __init__ instantiates the BACKEND
# singleton at import time.
from startup_prompts import PAUSE, STARTUP_PROMPTS
from secret_filter import redact_secrets


# How often the PTY session polls `<HOME>/.claude/.credentials.json` for a
# fresh token written by the CLI's `/login` flow. 5 s is responsive enough
# that closing the browser right after pasting the verification code still
# captures the new token before the WS detaches, and the stat cost is
# negligible.
CREDS_SYNC_INTERVAL_SEC = float(os.getenv("TERMINAL_CREDS_SYNC_INTERVAL_SEC", "5.0"))

# Same poll, slower, for a session that closed while its tmux session kept
# running (see _maybe_detach_creds_watcher). Nobody is typing in that terminal
# any more; we are only there to catch the CLI's own background token refresh,
# which happens a handful of times per token lifetime.
DETACHED_CREDS_SYNC_INTERVAL_SEC = float(
    os.getenv("TERMINAL_DETACHED_CREDS_SYNC_INTERVAL_SEC", "60.0")
)


# Tunables — picked to be safe defaults, not necessarily optimal. Operators
# can override via env if a deployment ever needs to.
SCROLLBACK_BYTES = int(os.getenv("TERMINAL_SCROLLBACK_BYTES", str(256 * 1024)))  # 256 KB
IDLE_TIMEOUT_SEC = int(os.getenv("TERMINAL_IDLE_TIMEOUT_SEC", str(60 * 60)))     # 1 h
# Per-client send budget: a black-holed TCP connection (phone leaves WiFi, no
# RST) blocks send_bytes on flow-control drain; without a bound, one such
# client stalls PTY fan-out for everyone and back-pressures the CLI.
CLIENT_SEND_TIMEOUT_SEC = float(os.getenv("TERMINAL_CLIENT_SEND_TIMEOUT_SEC", "5"))
INPUT_WRITE_TIMEOUT_SEC = float(os.getenv("TERMINAL_INPUT_WRITE_TIMEOUT_SEC", "5"))
DEFAULT_COLS = 120
DEFAULT_ROWS = 40
# Lines tmux keeps per pane, and how many of them a browser receives as
# scrollback when it attaches (so the whole session is scrollable from the
# first paint, not only what scrolled while that tab happened to be open).
TMUX_HISTORY_LIMIT = int(os.getenv("TERMINAL_TMUX_HISTORY_LIMIT", "20000"))
HISTORY_REPLAY_LINES = int(os.getenv("TERMINAL_HISTORY_REPLAY_LINES", "5000"))
READ_CHUNK = 4096

# ── Execution-scoped history capture ────────────────────────────────────────
#
# A shared TUI can repaint/reflow text from any previous task. Neither a
# successful initial snapshot, line subtraction nor a byte offset proves that
# later text originated in this execution. Do not persist that text in a task.
# Structured completion notes remain the source of execution history in the API.
HISTORY_BASELINE_LINES = 400
HISTORY_UNSCOPED_NOTICE = (
    "[terminal capture omitted: no execution boundary was recorded for this run, "
    "so output from earlier tasks could not be excluded]"
)
HISTORY_BASELINE_FAILED_NOTICE = (
    "[terminal capture omitted: initial pane capture failed; "
    "execution isolation could not be established]"
)
HISTORY_UNVERIFIED_NOTICE = (
    "[terminal capture omitted: a shared terminal can replay earlier tasks; "
    "execution isolation could not be established]"
)


class HistoryCaptureState(Enum):
    NOT_STARTED = "not_started"
    BASELINE_FAILED = "baseline_failed"
    SHARED_PANE_UNVERIFIED = "shared_pane_unverified"


# ── tmux backing ────────────────────────────────────────────────────────────
#
# The CLI runs inside a detached tmux session; the broker's PTY is a
# `tmux attach` client. This gives us three properties the bare-PTY model
# lacked:
#   • the CLI survives broker/WS churn (it lives in the tmux server, not as a
#     child of the broker subprocess), so a reconnect re-attaches to the exact
#     session the user left;
#   • tmux repaints the authoritative current screen on attach / refresh,
#     fixing the garbled raw-scrollback replay for alt-screen TUIs;
#   • a runner-service process restart (without a container restart) can
#     re-attach to the still-running tmux session.
#
# tmux runs as the agent's dropped UID (preexec_fn), so its socket lives under
# /tmp/tmux-<uid>/<socket> — naturally isolated per agent UID. We still key the
# session name on agent_id so the runAsRoot (shared UID) case stays correct.
# tmux is a hard requirement (baked into the runner image): start() raises
# when it is unavailable.
_TMUX_BIN = "tmux"
_TMUX_SOCKET = os.getenv("TERMINAL_TMUX_SOCKET", "pulsar")


def _tmux_available() -> bool:
    return shutil.which(_TMUX_BIN) is not None


def _tmux_session_name(agent_id: str) -> str:
    """tmux session names may not contain '.' or ':' — sanitise the agent id."""
    return "pt-" + re.sub(r"[.:\s]", "_", agent_id)


def _attach_client_preexec(agent_preexec: Optional[Callable]) -> Callable[[], None]:
    """preexec_fn making the PTY slave (already on fds 0-2) the attach client's
    controlling terminal, then dropping to the agent UID.

    The kernel only delivers SIGWINCH to a tty's foreground process group, and
    only a controlling tty has one. Without this, TIOCSWINSZ on the master
    never reaches `tmux attach`: tmux keeps drawing at the spawn size while
    every viewer adopts the claimed grid, so a narrower claim crops the
    rightmost columns (the /login URL lost 2 chars per line)."""
    def _preexec() -> None:
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)
        if agent_preexec is not None:
            agent_preexec()
    return _preexec

_INTERRUPT_RECIPES = {
    # Claude Code documents Ctrl-C as the hardcoded interrupt/cancel shortcut.
    "claude": ("ctrl-c", b"\x03"),
    "claude-code": ("ctrl-c", b"\x03"),
    # Codex and OpenClaw use Escape for aborting the active TUI run; Ctrl-C can
    # exit the whole session when they are already back at the prompt.
    "codex": ("escape", b"\x1b"),
    "openclaw": ("escape", b"\x1b"),
    # OpenCode's documented abort shortcut is Ctrl-G.
    "opencode": ("ctrl-g", b"\x07"),
    # Prompt-toolkit style chat CLIs keep Ctrl-C as their interrupt primitive.
    "hermes": ("ctrl-c", b"\x03"),
    "aider": ("ctrl-c", b"\x03"),
}


def _interrupt_recipe(cmd: list[str]) -> tuple[str, str, bytes]:
    """Return (cli_name, key_label, bytes) for the running CLI command."""
    executable = os.path.basename(cmd[0]) if cmd else ""
    cli_name = executable.lower()
    key_label, payload = _INTERRUPT_RECIPES.get(cli_name, ("ctrl-c", b"\x03"))
    return cli_name or "unknown", key_label, payload

_ANSI_RE = re.compile(
    r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))"
)
_AUTO_ANSWER_COOLDOWN_S = 1.0
# Whitespace squeeze used by screen_is_input_ready (see there).
_WS_RE = re.compile(r"\s+")
# How many times a screen-derived recipe may re-send its keystrokes before we
# stop and leave the dialog to the user. Each retry re-reads the screen, so a
# handful is enough to ride out the CLI not yet listening on stdin.
_AUTO_ANSWER_MAX_ATTEMPTS = 12

# Auth-failure sentinels the Claude Code (and other) CLIs print when their
# token/key is missing, expired, or rejected. The shared PTY broker is a
# transparent pipe, so unlike the one-shot headless driver it has no auth
# handling of its own — without this, an auth failure renders to the terminal
# and the agent simply goes quiet, which the workflow engine misreads as
# "task finished". We latch the first match into `PtySession.auth_error` and
# expose it via the session status endpoint so the API can fail the task.
# Patterns are kept tight (distinctive CLI phrasings) to avoid latching on the
# agent's own output that merely *mentions* authentication. The patterns live
# in the shared `auth_error_detect` module so the headless sync driver
# (claude_code.run_sync) shares the same phrases. Mixed terminal output also
# needs line context to distinguish diagnostics from source code and diffs.
from auth_error_detect import find_auth_error_line

# Banner sentinels that mean the TUI is ready to accept a typed prompt. A
# workflow-injected prompt is only pasted once the input box exists — not while
# a trust/bypass screen is up (would swallow it) and not mid-response (would
# interleave). We deliberately omit a bare "> " here: it appears inside the
# assistant's own streamed markdown (blockquotes) and would falsely read as
# "ready" while the CLI is still working. The caret + the input-box hint text
# only appear when the CLI has returned to an idle prompt.
#
# Matching is case-insensitive, so every hint/busy marker below is stored
# lowercased.
_INPUT_READY_HINTS = (
    "▌",                # ▌ the "type a message" caret (idle input box)
    "type / for commands",
    "try \"",
)


@dataclass(frozen=True)
class _ReadyRecipe:
    """How to recognise "this CLI is back at its input box" on screen.

    `hints` are sentinels that must be present. `busy` are sentinels that veto
    a match even when a hint is present — they mark a screen that renders the
    input box but cannot accept a prompt (mid-response, or a modal on top).

    A recipe WITH busy markers is evaluated one repaint frame at a time (see
    wait_until_input_ready): a hint and its vetoing busy marker share the same
    frame, so accumulating bytes across frames would let a stale idle frame
    out-vote the current busy one.
    """
    hints: tuple[str, ...]
    busy: tuple[str, ...] = ()


_DEFAULT_READY_RECIPE = _ReadyRecipe(hints=_INPUT_READY_HINTS)

# Per-CLI overrides, keyed like _INTERRUPT_RECIPES on the executable name.
#
# opencode renders NONE of the default hints: its caret is ┃ (U+2503, not ▌),
# its placeholder is `Ask anything... "…"` and its command hint is
# `ctrl+p commands`. Verified against opencode 1.17.12 and 1.18.25 — the
# footer's `ctrl+p commands` is the one sentinel present on every screen
# (cold start, idle-after-turn and mid-response), which is why it is paired
# with busy markers instead of used alone:
#   • `esc interrupt` — only rendered while a turn is streaming.
#   • `update available` — the self-update modal's title, shown whenever the
#     installed opencode is behind the latest npm release; it steals focus and
#     would swallow the prompt. Its body ("Would you like to update now?") is
#     wrapped mid-sentence by the modal, so the single-line title is the only
#     dependable marker. The OpenCode backend disables auto-update so it should
#     never appear, but an agent HOME provisioned by an older runner can.
# Claude Code renders none of the default hints either: its caret is ❯ (not ▌),
# and `Try "…"` only shows on a cold start — the example prompts are gone once
# the box has been used, and absent entirely when the CLI is logged out. Its one
# stable sentinel is the status footer, verified on 2.1.258:
#     cold start / idle  ⏸ manual mode on · ? for shortcuts · ← for agents
#     mid-response       ⏸ manual mode on · esc to interrupt · ← for agents
# 2.1.267 omits `? for shortcuts` in bypass mode and instead renders
# `bypass permissions on (shift+tab to cycle)`. Keep the interrupt veto:
# permission-mode hints can remain visible while a response is running.
_CLAUDE_READY_RECIPE = _ReadyRecipe(
    hints=("? for shortcuts", "shift+tab to cycle"),
    busy=("esc to interrupt",),
)

_READY_RECIPES: dict[str, _ReadyRecipe] = {
    # Codex 0.154.0 keeps the placeholder visible while working, so the
    # interrupt footer must veto it. The old generic caret (▌) is not rendered.
    "codex": _ReadyRecipe(
        hints=("ask codex to do anything", "? for shortcuts"),
        busy=("esc to interrupt", "esc to cancel"),
    ),
    "opencode": _ReadyRecipe(
        hints=("ctrl+p commands",),
        busy=("esc interrupt", "update available"),
    ),
    "claude": _CLAUDE_READY_RECIPE,
    "claude-code": _CLAUDE_READY_RECIPE,
}


def _ready_recipe(cmd: list[str]) -> _ReadyRecipe:
    executable = os.path.basename(cmd[0]).lower() if cmd else ""
    return _READY_RECIPES.get(executable, _DEFAULT_READY_RECIPE)


def screen_is_input_ready(screen: str, recipe: _ReadyRecipe) -> bool:
    """Classify one ANSI-stripped, lowercased TUI frame as input-ready.

    Matching is whitespace-insensitive. These TUIs lay their chrome out with
    absolute cursor positions, so `_strip_ansi` over the raw PTY stream can
    collapse a footer to `?forshortcuts·←foragents` — a sentinel written the
    way a human sees it would silently never match. Comparing the squeezed
    forms too costs one regex and removes that whole class of near-miss.

    Split out of wait_until_input_ready so the recipes can be checked against
    recorded frames of the real CLIs without spawning one.
    """
    squeezed = _WS_RE.sub("", screen)

    def present(sentinel: str) -> bool:
        return sentinel in screen or _WS_RE.sub("", sentinel) in squeezed

    if any(present(marker) for marker in recipe.busy):
        return False
    if recipe is _READY_RECIPES.get("codex") and not _codex_empty_draft(_codex_draft(screen)):
        return False
    return any(present(hint) for hint in recipe.hints)


def _strip_ansi(text: str) -> str:
    return _ANSI_RE.sub("", text)


class TerminalInputConflict(TimeoutError):
    """HTTP 409: preserving uncertain/user-owned input is safer than guessing."""


def _clean_terminal_text(text: str) -> str:
    """Turn raw/rendered terminal bytes into plain readable lines.

    Escape sequences, control characters and CR-based cursor tricks are all
    dropped so the result can be compared line-by-line (history scoping) and
    read by a human.
    """
    text = _strip_ansi(text).replace("\r\n", "\n").replace("\r", "\n")
    text = "".join(c for c in text if c in "\n\t" or (ord(c) >= 32 and ord(c) != 127))
    return "\n".join(line.rstrip() for line in text.splitlines()).strip()


def _codex_draft(screen: str) -> Optional[str]:
    # Read continuation lines too: the first line can be empty while another
    # line contains an administrator's draft. Never confuse transcript prompts
    # with a composer whose footer is absent (e.g. a modal or partial redraw).
    lines = screen.splitlines()
    starts = [i for i, line in enumerate(lines) if re.match(r"^\s*›", line)]
    if not starts:
        return None
    start = starts[-1]
    for end in range(start + 1, len(lines)):
        if lines[end - 1].strip():
            continue
        if re.match(r"^\s+(?:gpt-\S+|\? for shortcuts|tab to queue message|\d+% context left|/[a-z]+\s{2,})", lines[end], re.I):
            body = [re.sub(r"^\s*› ?", "", lines[start])]
            body.extend(line[2:] if line.startswith("  ") else line for line in lines[start + 1:end])
            return "\n".join(body).strip()
    return None


def _codex_empty_draft(draft: Optional[str]) -> bool:
    return draft is not None and draft.lower() in ("", "ask codex to do anything")


def _codex_matches_paste(draft: Optional[str], text: str) -> bool:
    expected = text.replace("\r\n", "\n").replace("\r", "\n")
    # A collapsed paste is attributable ONLY under the input epoch lease:
    # verified empty before our single write, no intervening broker writer,
    # and the exact size of that write. Any extra text/second paste conflicts.
    return draft == expected.strip() or draft == f"[Pasted Content {len(expected)} chars]"


# A "client" callback type: an async function the session calls to push
# bytes (raw PTY output) to one connected WebSocket. Each WS handler
# registers one such callback at attach time.
ClientCallback = Callable[[bytes], Awaitable[None]]
# Control-plane counterpart: pushes a JSON-able dict (e.g. the authoritative
# PTY geometry) to one client, on the text channel.
ControlCallback = Callable[[dict], Awaitable[None]]


class _FileWatcher:
    """Generic mtime-gated, content-deduped poller shared by the creds and
    config-files reverse-sync subsystems (one mechanism instead of twin
    copy-pasted loops).

    Invariants, encoded once here (see poll_once):
      • read() returning None means "unreadable right now" — the mtime marker
        is NOT advanced, so the next tick retries.
      • read() succeeding but dedup_key returning falsy (or raising) means
        "content present but nothing recognisable to sync" — the mtime marker
        IS advanced so the same blob isn't re-read every tick.
      • on_change raising means "persistence failed" — neither marker
        advances, so the next tick retries the push.
      • After a successful on_change the key marker advances only when a
        non-None key was computed. dedup_key is optional: without one, dedup
        is mtime-only (any newer write triggers a sync).
    """

    def __init__(
        self,
        agent_id: str,
        name: str,
        probe_mtime: Callable[[], Optional[float]],
        read: Callable[[], Optional[object]],
        dedup_key: Optional[Callable],
        on_change: Callable,
        log_success: Callable[[object], str],
    ):
        self.agent_id = agent_id
        self.name = name  # "creds" / "files" — used in log lines
        self._probe_mtime = probe_mtime
        self._read = read
        self._dedup_key = dedup_key
        self._on_change = on_change
        self._log_success = log_success
        self._last_mtime: float = 0.0
        self._last_key: Optional[str] = None

    def capture_baseline(self) -> None:
        """Record the just-seeded/restored content so the first poll doesn't
        push it straight back; only a real in-terminal change syncs.

        Baseline mtime and key are captured atomically: if either probe
        fails, BOTH reset (mtime→0.0, key→None) so any later write appears
        "newer" and triggers the first sync."""
        try:
            mtime = self._probe_mtime()
            if mtime is None:
                raise OSError(f"{self.name} baseline mtime unavailable")
            key = None
            if self._dedup_key is not None:
                value = self._read()
                if value is None:
                    raise OSError(f"{self.name} baseline content unreadable")
                key = self._dedup_key(value)
            self._last_mtime = mtime
            self._last_key = key
        except Exception:
            self._last_mtime = 0.0
            self._last_key = None

    async def run(self, closed: Callable[[], bool]) -> None:
        """Poll until the session closes. The on_change callable is sync and
        may do blocking HTTP, so poll_once runs it in a thread executor to
        avoid stalling the event loop."""
        try:
            while not closed():
                try:
                    await asyncio.sleep(CREDS_SYNC_INTERVAL_SEC)
                except asyncio.CancelledError:
                    return
                if closed():
                    return
                await self.poll_once()
        except Exception as e:
            logger.warning(f"[Terminal] {self.name} sync loop crashed for {self.agent_id}: {e}")

    async def poll_once(self) -> None:
        mtime = self._probe_mtime()
        if mtime is None:
            return
        if mtime <= self._last_mtime:
            return
        value = self._read()
        if value is None:
            return  # unreadable — retry next tick without advancing markers
        new_key: Optional[str] = None
        if self._dedup_key is not None:
            try:
                new_key = self._dedup_key(value)
            except Exception as e:
                logger.debug(f"[Terminal] {self.name}_dedup_key failed for {self.agent_id}: {e}")
                new_key = None
            if not new_key:
                # Content present but nothing to sync — advance the mtime
                # marker so we don't re-read the same blob next tick.
                self._last_mtime = mtime
                return
            if new_key == self._last_key:
                self._last_mtime = mtime
                return
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, self._on_change, value)
        except Exception as e:
            logger.warning(f"[Terminal] {self.name}_on_change failed for {self.agent_id}: {e}")
            return
        if new_key is not None:
            self._last_key = new_key
        self._last_mtime = mtime
        logger.info(self._log_success(value))


# ── Detached creds watchers ─────────────────────────────────────────────────
#
# A PtySession's creds watcher normally dies with the session, which is right
# as long as the session's death also ends the CLI. It doesn't always: the
# kill-session in close() is best-effort (a busy tmux server can time it out),
# and the CLI then keeps running orphaned in tmux. An orphaned CLI still
# refreshes its OAuth token in the background, and a refresh nobody mirrors
# back to the store is lost — worse than lost for codex, whose refresh_token
# rotates: the copy the store keeps serving was revoked by that very refresh,
# so the next spawn gets "your refresh token was revoked".
#
# So when a session closes over a tmux session that is still alive, its
# watcher is handed over here and keeps polling until tmux really goes away.
_DETACHED_CREDS_WATCHERS: dict[str, asyncio.Task] = {}


def _start_detached_creds_watcher(
    agent_id: str,
    watcher: _FileWatcher,
    still_alive: Callable[[], Awaitable[bool]],
) -> None:
    cancel_detached_creds_watcher(agent_id)

    async def _run() -> None:
        try:
            while await still_alive():
                await asyncio.sleep(DETACHED_CREDS_SYNC_INTERVAL_SEC)
                await watcher.poll_once()
            # The CLI is gone: one last look, in case it refreshed between the
            # previous tick and its exit.
            await watcher.poll_once()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.warning(f"[Terminal] detached creds sync failed for {agent_id}: {e}")
        finally:
            _DETACHED_CREDS_WATCHERS.pop(agent_id, None)

    _DETACHED_CREDS_WATCHERS[agent_id] = asyncio.create_task(_run())


def cancel_detached_creds_watcher(agent_id: str) -> None:
    """Stop the detached watcher for `agent_id`, if any. Called before a new
    session starts so the fresh watcher owns the file alone."""
    task = _DETACHED_CREDS_WATCHERS.pop(agent_id, None)
    if task is not None and not task.done():
        task.cancel()


@dataclass
class _Client:
    """One attached observer. We hold callbacks (not WebSocket objects
    directly) so this module stays framework-agnostic."""
    on_output: ClientCallback
    # Tracked just for logging / status — never the source of truth.
    label: str = "?"
    # While True, live output from the reader is buffered into `pending`
    # instead of being pushed straight to the socket. attach() flips this
    # off only after it has finished replaying the scrollback snapshot, so
    # the initial full-screen TUI paint can never be lost or reordered.
    replaying: bool = True
    pending: deque = field(default_factory=deque)
    # Receives {"type": "size", ...} whenever the shared PTY geometry changes,
    # so every viewer renders at exactly the grid the CLI draws for.
    on_control: Optional[ControlCallback] = None


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
    # Reverse-sync of in-TUI `/login` (or `codex login` etc.) results back to
    # the backend store. The backend's `prepare_interactive` recipe supplies
    # these fields:
    #   - creds_watch_path:    the credentials file the CLI writes after login
    #   - creds_on_change:     sync callable; receives the parsed JSON and
    #                          MUST raise on persistence failure so the
    #                          marker isn't advanced (next poll retries)
    #   - creds_dedup_key:     cheap extractor that returns a stable string
    #                          (e.g. the access token) so a same-content
    #                          rewrite doesn't trigger a useless re-push.
    #                          Optional — when None we fall back to mtime-
    #                          only dedup.
    # When either path or on_change is None, the polling loop is a no-op.
    creds_watch_path: Optional[str] = None
    creds_on_change: Optional[Callable[[dict], None]] = None
    creds_dedup_key: Optional[Callable[[dict], Optional[str]]] = None
    # Generic N-file watcher (parallel to the single-file creds one above).
    # Used by hermes to persist ~/.hermes/{config.yaml,.env} the user sets up in
    # the terminal, so a stateless restart can restore them. files_on_change
    # receives a {basename: text_content} dict of the watched files that exist.
    files_watch_paths: Optional[list] = None
    files_on_change: Optional[Callable[[dict], None]] = None
    # Token accounting for terminal-driven turns. The backend recipe supplies
    # {"kind": "claude"|"codex", "root": "<agent HOME>"} and we tail the CLI's
    # own session transcripts, reporting the deltas to team-api. Without it a
    # task injected into this PTY burns tokens that never reach the budget
    # screen (nothing on the API side sees a `usage` block for a PTY turn).
    usage_watch: Optional[dict] = None

    # Internals — filled in by start() and the background reader.
    master_fd: int = -1
    proc: Optional[subprocess.Popen] = None
    scrollback: deque = field(default_factory=lambda: deque(maxlen=1))  # placeholder
    _scrollback_size: int = 0
    _history_capture_state: HistoryCaptureState = HistoryCaptureState.NOT_STARTED
    _clients: dict[int, _Client] = field(default_factory=dict)
    _next_client_id: int = 0
    _reader_task: Optional[asyncio.Task] = None
    _idle_timer: Optional[asyncio.Task] = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _input_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _input_epoch: int = 0  # Stop and administrator writes invalidate injections
    # Once a paste may have happened, any ambiguous result quarantines automatic
    # input until this session is closed. Never erase drafts to recover ownership.
    _codex_input_uncertain: bool = False
    _closed: bool = False
    exit_code: Optional[int] = None
    _auto_answer_buf: bytearray = field(default_factory=bytearray)
    # Monotonic count of bytes ever fed into _auto_answer_buf. The buffer is
    # trimmed to its last 8 KB, so byte offsets shift — this counter lets
    # wait_until_input_ready scope its scan to bytes fed after it was called.
    _auto_answer_total: int = 0
    # Last time the PTY produced output — the idle reaper uses it to spare
    # headless sessions whose CLI is still mid-task.
    _last_output_at: float = 0.0
    _auto_answered: set[str] = field(default_factory=set)
    # Per-prompt retry counter for the screen-derived recipes (see
    # _maybe_auto_answer_startup_prompt).
    _auto_answer_attempts: dict = field(default_factory=dict)
    _last_auto_answer_at: float = 0.0
    _creds_watcher: Optional[_FileWatcher] = None
    _creds_sync_task: Optional[asyncio.Task] = None
    _files_watcher: Optional[_FileWatcher] = None
    _files_sync_task: Optional[asyncio.Task] = None
    _usage_watcher: Optional[object] = None
    _usage_watch_task: Optional[asyncio.Task] = None
    # First detected auth failure (decoded sentinel line). Latched until the
    # next prompt injection clears it (see clear_auth_error). Exposed in
    # status() so the API can fail the in-flight task instead of treating the
    # silent CLI as "done".
    auth_error: Optional[str] = None

    # tmux backing (see module header).
    _tmux_session: Optional[str] = None
    _slave_tty: Optional[str] = None
    # tmux dead-pane handling. With `remain-on-exit on` a CLI that exits leaves
    # a *dead* pane (its final output preserved on screen) instead of the
    # session being destroyed — so the attached broker still shows WHY the CLI
    # died (e.g. opencode printing a provider/auth error) instead of a blank
    # "[exited]". We poll for the dead pane here and translate it into the
    # normal exit/relaunch flow once detected.
    _pane_dead_handled: bool = False
    _last_pane_check: float = 0.0

    def __post_init__(self) -> None:
        # Watchers are built eagerly (not in start()): close() runs the final
        # creds sync even on spawn-failure paths where start() never completed.
        if self.creds_watch_path and self.creds_on_change:
            self._creds_watcher = self._build_creds_watcher()
        if self.files_watch_paths and self.files_on_change:
            self._files_watcher = self._build_files_watcher()
        if self.usage_watch:
            from usage_watcher import build_watcher
            self._usage_watcher = build_watcher(self.agent_id, self.usage_watch)

    # ── Reverse-sync watchers (creds + config files) ──────────────────────

    def _build_creds_watcher(self) -> _FileWatcher:
        """Single-file watcher for `creds_watch_path` (in-TUI /login result)."""
        path = self.creds_watch_path

        def _probe() -> Optional[float]:
            try:
                return os.path.getmtime(path)
            except OSError:
                return None

        def _read() -> Optional[dict]:
            try:
                with open(path) as f:
                    return json.load(f)
            except (OSError, json.JSONDecodeError) as e:
                logger.debug(f"[Terminal] creds read failed for {self.agent_id}: {e}")
                return None

        return _FileWatcher(
            agent_id=self.agent_id,
            name="creds",
            probe_mtime=_probe,
            read=_read,
            dedup_key=self.creds_dedup_key,  # optional → mtime-only fallback
            on_change=self.creds_on_change,
            log_success=lambda _data: (
                f"[Terminal] Persisted fresh credentials to backend store for agent {self.agent_id} "
                f"(triggered by in-TUI login)"
            ),
        )

    def _build_files_watcher(self) -> _FileWatcher:
        """N-file watcher for `files_watch_paths` (e.g. hermes' ~/.hermes
        config the user sets up in the terminal, persisted so a stateless
        restart can restore it)."""

        def _dedup(files: dict) -> Optional[str]:
            # Zero readable files maps to None so the watcher advances the
            # mtime marker and skips (the old "if not files" branch).
            return self._files_signature(files) if files else None

        return _FileWatcher(
            agent_id=self.agent_id,
            name="files",
            probe_mtime=self._files_max_mtime,
            read=self._read_watched_files,  # returns a dict, never None
            dedup_key=_dedup,
            on_change=self.files_on_change,
            log_success=lambda files: (
                f"[Terminal] Persisted runner config files for agent {self.agent_id} "
                f"({', '.join(sorted(files))})"
            ),
        )

    def _read_watched_files(self) -> dict:
        out: dict = {}
        for path in (self.files_watch_paths or []):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    out[os.path.basename(path)] = f.read()
            except (OSError, UnicodeDecodeError):
                continue
        return out

    def _files_signature(self, files: dict) -> str:
        import hashlib
        h = hashlib.sha256()
        for name in sorted(files):
            h.update(name.encode("utf-8", "replace"))
            h.update(b"\0")
            h.update(files[name].encode("utf-8", "replace"))
            h.update(b"\0")
        return h.hexdigest()

    def _files_max_mtime(self) -> float:
        latest = 0.0
        for path in (self.files_watch_paths or []):
            try:
                m = os.path.getmtime(path)
            except OSError:
                continue
            if m > latest:
                latest = m
        return latest

    # ── tmux helpers ──────────────────────────────────────────────────────
    def _tmux_env(self) -> dict:
        return {
            **self.env,
            "COLUMNS": str(self.cols),
            "LINES": str(self.rows),
            "TERM": self.env.get("TERM", "xterm-256color"),
        }

    def _tmux_run(self, args: list[str], timeout: float = 5.0) -> subprocess.CompletedProcess:
        """Run a tmux management subcommand as the agent's UID (so it talks to
        the agent's per-UID tmux server socket)."""
        full = [_TMUX_BIN, "-L", _TMUX_SOCKET, *args]
        return subprocess.run(
            full, cwd=self.cwd, env=self._tmux_env(),
            preexec_fn=self.preexec_fn, capture_output=True, timeout=timeout,
        )

    async def _tmux_session_alive(self) -> bool:
        """True when this session's tmux session still exists — i.e. the CLI
        outlived the broker. Blocking tmux call, so off the event loop."""
        if not self._tmux_session:
            return False
        try:
            res = await asyncio.to_thread(
                self._tmux_run, ["has-session", "-t", self._tmux_session]
            )
        except Exception:
            return False
        return res.returncode == 0

    def _ensure_tmux_session(self) -> None:
        """Create the detached tmux session running the CLI if it doesn't yet
        exist. Idempotent: an existing session (e.g. after a runner-service
        process restart) is reattached untouched, preserving the running CLI.
        Raises on any tmux failure, failing the spawn."""
        name = _tmux_session_name(self.agent_id)
        self._tmux_session = name
        has = self._tmux_run(["has-session", "-t", name])
        if has.returncode == 0:
            # The tmux server survives runner restarts. Its session may still
            # belong to a previous repo even when the Python registry is empty.
            path = self._tmux_run(["display-message", "-p", "-t", name, "#{session_path}"])
            session_cwd = path.stdout.decode("utf-8", "replace").strip()
            if path.returncode == 0 and session_cwd == self.cwd:
                logger.info(f"[Terminal] Reattaching existing tmux session {name} for agent {self.agent_id}")
                self._keep_outer_scrollback()
                return
            killed = self._tmux_run(["kill-session", "-t", name])
            if killed.returncode != 0:
                raise RuntimeError("Cannot close tmux session from previous project")
        # Keep a dead pane around instead of destroying the session the instant
        # the CLI exits. Without this, a CLI that fails on startup (opencode
        # printing a provider/auth/model error, then exiting) tears the whole
        # tmux session down before — or right as — the broker attaches, so the
        # user only ever sees a blank "[exited]" with no clue why. With
        # remain-on-exit the CLI's final output stays painted in the dead pane
        # for the attached client to read; we then detect the dead pane and run
        # the normal exit/relaunch flow (see _maybe_handle_tmux_exit).
        # `-g` sets it as a global window option so the session's window
        # inherits it even if the CLI exits in the same instant it is created.
        #
        # history-limit only applies to windows created AFTER it is set, and a
        # lone `set-option` cannot start the server, so both globals ride in
        # the same command list as new-session (which does start it).
        create = self._tmux_run(
            ["set-option", "-g", "remain-on-exit", "on", ";",
             "set-option", "-g", "history-limit", str(TMUX_HISTORY_LIMIT), ";",
             "new-session", "-d", "-s", name, "-c", self.cwd,
             "-x", str(self.cols), "-y", str(self.rows), "--", *self.cmd],
            timeout=15.0,
        )
        if create.returncode != 0:
            raise RuntimeError(
                f"tmux new-session failed (rc={create.returncode}): "
                f"{create.stderr.decode('utf-8', 'replace')[:300]}"
            )
        # No tmux status bar in the pane (it would steal a row and render its
        # green chrome into the user's terminal), and let the most recently
        # active client drive the geometry. remain-on-exit is also set on the
        # window directly (belt-and-braces with the global option above).
        self._tmux_run(["set-option", "-t", name, "status", "off"])
        self._tmux_run(["set-option", "-t", name, "window-size", "latest"])
        self._tmux_run(["set-option", "-t", name, "remain-on-exit", "on"])
        self._keep_outer_scrollback()
        logger.info(f"[Terminal] Created tmux session {name} for agent {self.agent_id} (cmd={self.cmd!r})")

    def _keep_outer_scrollback(self) -> None:
        """Stop tmux from switching the browser's xterm to the alternate screen.

        `tmux attach` emits smcup, and xterm.js's alternate buffer has NO
        scrollback: every line the CLI scrolled off was simply gone for the
        viewer. Disabling smcup/rmcup for the outer terminal keeps xterm on its
        normal buffer, where tmux's full-screen scrolls land in real scrollback
        (the classic iTerm+tmux recipe). Inner TUIs that use their own
        alternate screen are unaffected: tmux handles that per pane. Must be
        set before the broker attaches (read at client attach). A fixed array
        index keeps it idempotent across respawns."""
        self._tmux_run(["set-option", "-s", "terminal-overrides[90]", "*:smcup@:rmcup@"])

    async def request_repaint(self) -> None:
        """Ask tmux to redraw the authoritative current screen to the broker's
        client. Called on each new WS attach (instead of replaying raw
        scrollback, which corrupts alt-screen TUIs)."""
        if not self._slave_tty or self._closed:
            return
        def _do() -> None:
            try:
                self._tmux_run(["refresh-client", "-t", self._slave_tty])
            except Exception as e:
                logger.debug(f"[Terminal] refresh-client failed for {self.agent_id}: {e}")
        try:
            await asyncio.get_running_loop().run_in_executor(None, _do)
        except Exception:
            pass

    def _probe_tmux_pane_dead(self) -> Optional[tuple[Optional[int], str]]:
        """Return `(exit_status, captured_pane_text)` when the CLI inside the
        tmux session has exited (its pane is dead), else None.

        Relies on `remain-on-exit on` (set in _ensure_tmux_session): a CLI that
        exits leaves a dead pane whose final on-screen output we capture so the
        user can read WHY it died. Runs blocking tmux subcommands, so callers
        must invoke it off the event loop (run_in_executor)."""
        if not self._tmux_session:
            return None
        try:
            info = self._tmux_run([
                "list-panes", "-t", self._tmux_session,
                "-F", "#{pane_dead} #{pane_dead_status}",
            ])
        except Exception:
            return None
        if info.returncode != 0:
            # The session is gone entirely (killed externally / server died).
            # Treat that as an exit too so the broker doesn't hang forever.
            return (None, "")
        line = info.stdout.decode("utf-8", "replace").splitlines()
        if not line:
            return None
        first = line[0].strip().split()
        if not first or first[0] != "1":
            return None  # pane still alive
        status: Optional[int] = None
        if len(first) > 1:
            try:
                status = int(first[1])
            except ValueError:
                status = None
        captured = ""
        try:
            cap = self._tmux_run([
                "capture-pane", "-p", "-t", self._tmux_session, "-S", "-",
            ])
            if cap.returncode == 0:
                captured = cap.stdout.decode("utf-8", "replace").rstrip("\n")
        except Exception:
            captured = ""
        return (status, captured)

    async def _maybe_handle_tmux_exit(self) -> None:
        """Detect a dead tmux pane (CLI exited under remain-on-exit) and drive
        the normal exit/relaunch flow once, surfacing the captured error."""
        if self._closed or self._pane_dead_handled:
            return
        now = time.monotonic()
        if now - self._last_pane_check < 1.0:
            return
        self._last_pane_check = now
        try:
            result = await asyncio.get_running_loop().run_in_executor(
                None, self._probe_tmux_pane_dead
            )
        except Exception:
            return
        if result is None:
            return
        self._pane_dead_handled = True
        status, captured = result
        self.exit_code = status
        if captured:
            # Fold the dead pane's final screen into scrollback so tail_text()
            # (used for the client's exit notice) reports the real CLI error.
            self._append_scrollback(captured.encode("utf-8", "replace"))
        logger.info(
            f"[Terminal] tmux pane for agent {self.agent_id} is dead "
            f"(status={status}, cmd={self.cmd!r}); surfacing CLI exit"
        )
        clients = list(self._clients.values())
        self._clients.clear()
        for client in clients:
            try:
                await client.on_output(b"")
            except Exception:
                pass
        await self.close()

    async def start(self) -> None:
        """Spawn the CLI in a fresh PTY and start the reader loop.

        The CLI runs inside a detached tmux session and the broker's PTY is a
        `tmux attach` client (see module header); the subprocess we track is
        the attach client, and the real CLI lives in the tmux server so it
        survives this broker. Raises RuntimeError when tmux is unavailable."""
        if self.proc is not None:
            return
        self.scrollback = deque()  # holds raw byte chunks; size bounded manually
        self._scrollback_size = 0
        # A respawn has no initial history observation for the next execution.
        self._history_capture_state = HistoryCaptureState.NOT_STARTED

        if not _tmux_available():
            raise RuntimeError(
                f"tmux is required for terminal sessions but is not available "
                f"(agent {self.agent_id})"
            )
        # Blocking tmux subcommands (new-session can take up to 15 s on a
        # wedged server) must not run on the event loop.
        await asyncio.to_thread(self._ensure_tmux_session)

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
        # The slave's /dev/pts path is the tmux client tty — needed to target
        # `refresh-client` at exactly this broker connection.
        try:
            self._slave_tty = os.ttyname(slave_fd)
        except OSError:
            self._slave_tty = None

        env = self._tmux_env()
        # -d detaches every other client of the session: the broker must be its
        # only one, or under `window-size latest` a leftover attach (from a
        # broker that never finished closing) can own the window size.
        spawn_cmd = [_TMUX_BIN, "-L", _TMUX_SOCKET, "attach-session", "-d", "-t", self._tmux_session]

        try:
            self.proc = subprocess.Popen(
                spawn_cmd,
                cwd=self.cwd,
                env=env,
                stdin=slave_fd,
                stdout=slave_fd,
                stderr=slave_fd,
                preexec_fn=_attach_client_preexec(self.preexec_fn),
                close_fds=True,
            )
        except Exception as e:
            os.close(master_fd)
            os.close(slave_fd)
            logger.error(f"[Terminal] Failed to spawn {spawn_cmd[0]} for agent {self.agent_id}: {e}")
            raise

        os.close(slave_fd)
        self.master_fd = master_fd
        logger.info(
            f"[Terminal] Spawned tmux-attach PTY session "
            f"for agent {self.agent_id} (pid={self.proc.pid}, cols={self.cols}, rows={self.rows}, "
            f"cmd={self.cmd!r}, cwd={self.cwd})"
        )

        loop = asyncio.get_running_loop()
        self._reader_task = loop.create_task(self._read_loop())
        # Baseline the credentials.json that `seed_credentials_file` just
        # wrote so the polling loop only fires when the CLI's /login flow
        # produces a NEWER token. Without this baseline, the first poll
        # would always treat the seed as "fresh" and push it back to the
        # store unnecessarily. (Likewise for the just-restored config files.)
        if self._creds_watcher is not None:
            self._creds_watcher.capture_baseline()
            self._creds_sync_task = loop.create_task(
                self._creds_watcher.run(lambda: self._closed)
            )
        if self._files_watcher is not None:
            self._files_watcher.capture_baseline()
            self._files_sync_task = loop.create_task(
                self._files_watcher.run(lambda: self._closed)
            )
        # Same baseline reasoning for token accounting: everything already in
        # the CLI's transcripts predates this session and was billed then.
        if self._usage_watcher is not None:
            await asyncio.to_thread(self._usage_watcher.baseline)
            self._usage_watch_task = loop.create_task(
                self._usage_watcher.run(lambda: self._closed)
            )
        # A session spawned headlessly (POST /input, no WS viewer ever) must
        # still be idle-reaped — arm the timer now; attach() cancels it on the
        # first real viewer, and the reaper spares sessions with recent output.
        self._last_output_at = time.monotonic()
        if not self._clients:
            self._schedule_idle_timer()

    async def _handle_output(self, data: bytes) -> None:
        self._last_output_at = time.monotonic()
        # Record the chunk and decide each client's delivery path
        # atomically under the lock, so this can't interleave with attach()'s
        # scrollback snapshot + client registration. A client still replaying
        # its scrollback buffers the chunk in `pending`; live clients get it
        # pushed below (outside the lock, to avoid stalling the reader on a
        # slow socket).
        targets: list[tuple[int, _Client]] = []
        async with self._lock:
            self._append_scrollback(data)
            self._maybe_detect_auth_error(data)
            for client_id, client in self._clients.items():
                if client.replaying:
                    client.pending.append(data)
                else:
                    targets.append((client_id, client))

        if not targets:
            return
        dead: list[tuple[int, _Client]] = []
        for client_id, client in targets:
            try:
                await asyncio.wait_for(client.on_output(data), timeout=CLIENT_SEND_TIMEOUT_SEC)
            except Exception as e:
                logger.debug(f"[Terminal] Client {client_id} broadcast failed: {e}")
                dead.append((client_id, client))
        if dead:
            async with self._lock:
                for client_id, _ in dead:
                    self._evict_client(client_id)
            for _, client in dead:
                self._kick_client(client)

    def _maybe_detect_auth_error(self, data: bytes) -> None:
        """Latch the first auth-failure sentinel seen in the PTY output.

        Scans a short rolling tail (the auto-answer buffer is already fed the
        same bytes by the reader) so we don't re-decode the whole scrollback.
        Idempotent once latched — cleared only by clear_auth_error() at the
        next prompt injection."""
        if self.auth_error is not None:
            return
        if not data:
            return
        # Include the current chunk: the reader only extends _auto_answer_buf
        # with this data AFTER _handle_output returns, so reading the buffer
        # alone would lag one chunk behind.
        tail = _strip_ansi((bytes(self._auto_answer_buf) + data).decode("utf-8", errors="replace"))
        if len(tail) > 4096:
            # Drop the cut line: truncating away its code/diff prefix could
            # otherwise turn a quoted phrase into an apparent CLI banner.
            tail = tail[-4096:].partition("\n")[2]
        # find_auth_error_line already returns the diagnostic line carrying the
        # match, which is what the API surfaces as the task error.
        line = find_auth_error_line(tail)
        if line is None:
            return
        # That line is scraped straight off a login screen, which is where
        # device codes and one-time URLs live — scrub before latching, as the
        # API copies this into task errors and history.
        self.auth_error = redact_secrets(line)[:300]
        logger.warning(
            f"[Terminal] Auth failure detected in CLI output for agent {self.agent_id}: "
            f"{self.auth_error!r}"
        )

    def clear_auth_error(self) -> None:
        """Reset the latched auth error. Called before a fresh prompt injection
        so a recovered login (or a new attempt) starts from a clean slate."""
        if self.auth_error is not None:
            logger.info(f"[Terminal] Clearing latched auth error for agent {self.agent_id}")
        self.auth_error = None

    def set_auth_error(self, message: str) -> None:
        """Latch an auth failure detected OUT of band (e.g. a pre-injection
        auth preflight) rather than scraped from the PTY output. Same
        semantics as the reactive `_maybe_detect_auth_error` latch: first one
        wins, exposed via status() so the API probe can fail the task instead
        of treating the silent/login-screen CLI as "done". No-op once latched
        or for an empty message."""
        if self.auth_error is not None or not message:
            return
        self.auth_error = redact_secrets(message.strip())[:300]
        logger.warning(
            f"[Terminal] Auth failure flagged (preflight) for agent {self.agent_id}: "
            f"{self.auth_error!r}"
        )

    async def wait_until_input_ready(self, timeout: float = 20.0) -> bool:
        """Block until the TUI shows an input-ready hint (or timeout).

        Lets a workflow-injected prompt be pasted into the actual message box
        instead of into a startup confirmation screen (trust folder / bypass
        permissions), which would swallow or mangle the instructions. Returns
        True if input-ready was observed, False on timeout / dead session.
        The reader loop keeps auto-answering trust/bypass concurrently.

        Only hints rendered AFTER this call counts as ready: the rolling
        buffer persists across turns, so the previous idle screen's caret
        would otherwise signal "ready" while the CLI is mid-turn and let
        back-to-back workflow prompts interleave. An idle (quiescent) TUI
        emits no new bytes on its own — the tmux repaint below re-emits the
        current screen so a genuinely idle prompt is still seen immediately.

        A CLI whose recipe carries busy markers (opencode) renders its
        input-box hint even mid-response, so for those the scan is re-based on
        every iteration: each pass repaints and looks at that one frame, where
        the hint and its vetoing busy marker appear together. Codex instead
        captures the complete current tmux pane, independent of redraw timing
        and the rolling stream buffer's size."""
        recipe = _ready_recipe(self.cmd)
        epoch = self._input_epoch
        codex = bool(self.cmd and os.path.basename(self.cmd[0]).lower() == "codex")
        per_frame = bool(recipe.busy)
        start_total = self._auto_answer_total
        # Ask tmux to repaint the authoritative current screen (no-op without
        # tmux): an idle input box re-renders its caret as fresh bytes.
        await self.request_repaint()
        deadline = time.monotonic() + max(0.0, timeout)
        while time.monotonic() < deadline:
            if self._closed or not self.is_alive() or epoch != self._input_epoch:
                return False
            if codex and self._tmux_session:
                # Read one authoritative screen, not concatenated ANSI redraws:
                # a partial repaint can contain the placeholder without the
                # busy footer, and a tall pane can push it out of the byte tail.
                try:
                    frame = await asyncio.to_thread(
                        self._tmux_run, ["capture-pane", "-p", "-t", self._tmux_session]
                    )
                    if frame.returncode == 0:
                        screen = frame.stdout.decode("utf-8", errors="replace").lower()
                        draft = _codex_draft(screen)
                        if draft is not None and not _codex_empty_draft(draft):
                            raise TerminalInputConflict("Codex composer contains a draft; automatic input was not delivered")
                        if screen_is_input_ready(screen, recipe):
                            return True
                        await asyncio.sleep(0.2)
                        continue
                except TerminalInputConflict:
                    raise
                except (OSError, subprocess.SubprocessError):
                    pass
                # A failed screen capture is not evidence that Codex is ready.
                await asyncio.sleep(0.2)
                continue
            if per_frame:
                # Re-base on the bytes of the frame we are about to request, so
                # a stale idle frame can't out-vote the current busy one.
                start_total = self._auto_answer_total
                await self.request_repaint()
                await asyncio.sleep(0.2)
            fed_since = self._auto_answer_total - start_total
            if fed_since > 0:
                # Slice by bytes-fed (the buffer is trimmed, so offsets shift),
                # with a small overlap so a hint/ANSI sequence straddling the
                # entry point isn't corrupted.
                window = min(len(self._auto_answer_buf), fed_since + 32)
                tail = _strip_ansi(
                    self._auto_answer_buf[-window:].decode("utf-8", errors="replace")
                )[-4096:].lower()
                if screen_is_input_ready(tail, recipe):
                    return True
            if not per_frame:
                await asyncio.sleep(0.2)
        return False

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
                    await self._maybe_handle_tmux_exit()
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

    def _rendered_screen(self) -> str:
        """The CLI's screen as a terminal emulator would show it.

        `_strip_ansi` concatenates every repaint, so it can present a STALE
        frame — Claude Code paints its trust dialog more than once, and picking
        a row off an old frame is exactly how a confirm lands on the wrong
        option. Replaying the bytes through pyte collapses the repaints into
        what is actually on screen. Only the screen-derived recipes call this
        (at most once per dialog), never the hot path. Returns "" when pyte is
        unavailable so callers can fall back to the stripped tail.
        """
        try:
            import pyte
        except ImportError:  # pragma: no cover - pyte is a hard dependency
            return ""
        try:
            screen = pyte.Screen(self.cols, self.rows)
            pyte.Stream(screen).feed(
                bytes(self._auto_answer_buf).decode("utf-8", errors="replace")
            )
            return "\n".join(screen.display)
        except Exception as e:
            logger.debug(f"[Terminal] screen render failed for {self.agent_id}: {e}")
            return ""

    def _maybe_auto_answer_startup_prompt(self, data: bytes = b"") -> None:
        """Dismiss known CLI startup confirmations in the shared terminal.

        The one-shot PTY driver already handles these screens, but the shared
        /ws terminal intentionally runs as a transparent PTY broker. Without a
        tiny prompt recognizer here, CLIs can stop on first-run trust /
        bypass-permissions / update confirmations before the user can use the
        terminal.
        """
        if data:
            self._auto_answer_buf.extend(data)
            self._auto_answer_total += len(data)
            if len(self._auto_answer_buf) > 8192:
                del self._auto_answer_buf[:-8192]

        if self.master_fd < 0 or self._closed:
            return
        if time.monotonic() - self._last_auto_answer_at < _AUTO_ANSWER_COOLDOWN_S:
            return

        tail = _strip_ansi(self._auto_answer_buf.decode("utf-8", errors="replace"))[-4096:]
        if not tail.strip():
            return

        for prompt in STARTUP_PROMPTS:  # table order = match priority
            if prompt.key in self._auto_answered or not prompt.pattern.search(tail):
                continue
            keys = (
                prompt.keys(self._rendered_screen() or tail)
                if callable(prompt.keys)
                else prompt.keys
            )
            if not keys:
                # The recipe could not read this screen (e.g. the trust dialog
                # rendered without a selection marker yet). Send NOTHING and
                # leave the prompt unanswered so a later frame can retry —
                # confirming an unidentified row is how a bare Enter used to
                # land on "No, exit" and kill the CLI.
                logger.debug(
                    f"[Terminal] {prompt.description} prompt matched for agent "
                    f"{self.agent_id} but the screen was unreadable — retrying"
                )
                continue
            logger.info(
                f"[Terminal] Auto-answer {prompt.description} prompt for agent "
                f"{self.agent_id}: {prompt.keys_label}"
            )
            self._send_prompt_keys(keys)
            if callable(prompt.keys):
                # Screen-derived recipes are RETRYABLE, and must be: the dialog
                # paints before the CLI starts reading stdin, so the first
                # attempt is regularly swallowed (measured: keys sent at ~2 s do
                # nothing, the same keys at ~8 s move the selection). Marking it
                # answered there left the dialog up forever.
                #
                # Retrying is safe precisely because the keys come from the
                # CURRENT screen: once the dialog is gone the recipe finds no
                # accept row and returns nothing, and if only the move landed
                # the next pass sees the marker already on the accept row and
                # just confirms. Give up after a bounded number of tries so a
                # screen we keep misreading can't loop forever.
                attempts = self._auto_answer_attempts.get(prompt.key, 0) + 1
                self._auto_answer_attempts[prompt.key] = attempts
                if attempts >= _AUTO_ANSWER_MAX_ATTEMPTS:
                    logger.warning(
                        f"[Terminal] {prompt.description} prompt for agent "
                        f"{self.agent_id} did not clear after {attempts} attempts "
                        f"— leaving it to the user"
                    )
                    self._auto_answered.add(prompt.key)
            else:
                self._auto_answered.add(prompt.key)
            # Stamped once at fire time — a deferred Enter (PAUSE recipes)
            # must NOT re-stamp the cooldown.
            self._last_auto_answer_at = time.monotonic()
            return

    def _send_prompt_keys(self, keys: tuple) -> None:
        """Ship a StartupPrompt keystroke recipe through _write_keystroke.

        Pause-free recipes are written synchronously inline — the reader's
        timeout path (and the tests) may run this without a usable task
        context. A PAUSE sentinel defers the remaining keys by one render
        tick via create_task, so the TUI repaints its selection highlight
        before the confirming Enter lands; _write_keystroke re-checks
        _closed/master_fd at deferred-fire time."""
        for idx, item in enumerate(keys):
            if item is PAUSE:
                rest = keys[idx + 1:]

                async def _confirm_after_render_tick() -> None:
                    await asyncio.sleep(0.12)
                    for k in rest:
                        if k is not PAUSE:
                            self._write_keystroke(k)

                asyncio.create_task(_confirm_after_render_tick())
                return
            self._write_keystroke(item)

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

    def _evict_client(self, client_id: int) -> None:
        """Remove a client and arm the idle timer when the last one is gone —
        every removal path must go through here (or detach()) or a session
        whose last client dies eagerly escapes idle reaping."""
        removed = self._clients.pop(client_id, None)
        if removed is not None and not self._clients:
            self._schedule_idle_timer()

    def _kick_client(self, client: _Client) -> None:
        """Force-close an evicted client's socket from a detached task. A
        timed-out (but still open) WebSocket would otherwise sit parked in
        receive() while no longer getting any output; the b"" sentinel makes
        its handler close the socket so the browser can reconnect."""
        async def _close() -> None:
            try:
                await asyncio.wait_for(client.on_output(b""), timeout=CLIENT_SEND_TIMEOUT_SEC)
            except Exception:
                pass
        asyncio.create_task(_close())

    async def attach(
        self,
        on_output: ClientCallback,
        label: str = "?",
        on_control: Optional[ControlCallback] = None,
    ) -> int:
        """Register a new client. Replays the current scrollback synchronously
        so the client renders the existing screen state before live bytes
        start arriving. Returns the opaque client id used for detach()."""
        async with self._lock:
            self._cancel_idle_timer()
            # The raw scrollback ring is never replayed — that corrupts an
            # alt-screen TUI. Instead request_repaint() (below) makes tmux
            # re-emit the authoritative current screen to all clients.
            # Register the client atomically: from here on the reader buffers
            # live output into client.pending (the client starts in
            # replaying=True) instead of dropping it. This closes the race
            # where output emitted between registration and the repaint was
            # lost — for a TUI that meant a missed initial full-screen paint
            # and a blank screen.
            client_id = self._next_client_id
            self._next_client_id += 1
            client = _Client(on_output=on_output, label=label, on_control=on_control)
            self._clients[client_id] = client
            logger.info(
                f"[Terminal] Client {client_id} ({label}) attached to agent "
                f"{self.agent_id} (now {len(self._clients)} clients)"
            )

        # Live bytes arriving meanwhile accumulate in client.pending and are
        # flushed below, preserving order.
        #
        # A client that disconnects (or is cancelled) mid-replay must be
        # unregistered here — the WS handler's finally-detach only runs once
        # attach() has returned, so a propagating exception would otherwise
        # leak the client in _clients with replaying=True forever (unbounded
        # pending growth + the session never idle-reaped). BaseException so
        # CancelledError is covered too.
        try:
            # Flush anything buffered during replay, then switch to live delivery.
            # The flip to replaying=False happens under the lock while pending is
            # empty, so no chunk can slip past between the last drain and going live.
            while True:
                async with self._lock:
                    if not client.pending:
                        client.replaying = False
                        break
                    batch = list(client.pending)
                    client.pending.clear()
                for chunk in batch:
                    await on_output(chunk)

            # tmux repaints the authoritative screen to the broker's client, which
            # the reader loop then fans out to every attached client (this one
            # included) — replacing the corrupt raw-scrollback replay.
            await self.request_repaint()
        except BaseException:
            await self.detach(client_id)
            raise

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

    def _check_input_epoch(self, epoch: int) -> None:
        if epoch != self._input_epoch:
            raise InterruptedError("Terminal input interrupted or changed by another writer")
        if self._closed or not self.is_alive():
            raise OSError("Terminal session closed before submission")

    async def _codex_screen(self, epoch: int) -> str:
        self._check_input_epoch(epoch)
        if not self._tmux_session:
            raise TerminalInputConflict("Cannot inspect Codex composer; automatic input was not delivered")
        try:
            frame = await asyncio.to_thread(
                self._tmux_run, ["capture-pane", "-p", "-J", "-t", self._tmux_session]
            )
        except (OSError, subprocess.SubprocessError) as e:
            raise TerminalInputConflict("Cannot inspect Codex composer; automatic input stopped") from e
        self._check_input_epoch(epoch)
        if frame.returncode != 0:
            raise TerminalInputConflict("Cannot inspect Codex composer; automatic input stopped")
        return frame.stdout.decode("utf-8", errors="replace")

    async def _wait_for_codex_paste(self, text: str, epoch: int, timeout: float = 5.0) -> str:
        """A nonempty draft alone is not an acknowledgement of OUR injection."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            draft = _codex_draft(await self._codex_screen(epoch))
            if _codex_matches_paste(draft, text):
                return draft
            if draft is not None and not _codex_empty_draft(draft):
                raise TerminalInputConflict("Codex draft does not match this injection; submit was not sent")
            await asyncio.sleep(0.05)
        raise TimeoutError("Codex did not render the pasted input; submit was not sent")

    async def _submit_codex_paste(self, draft: str, epoch: int) -> None:
        """Revalidate ownership before EVERY Enter, including a lost-key retry."""
        for attempt in range(2):
            screen = await self._codex_screen(epoch)
            if _codex_draft(screen) != draft or any(
                marker in screen.lower() for marker in _READY_RECIPES["codex"].busy
            ):
                raise TerminalInputConflict("Codex draft changed before Enter; automatic submission stopped")
            self._check_input_epoch(epoch)
            # Deliberately no await between this last epoch check and send-keys:
            # a broker writer/Stop must not run after validation but before Enter.
            # Offloading send-keys would leave an uncancellable worker able to
            # submit after Stop. tmux is local and this call has a bounded timeout.
            try:
                result = self._tmux_run(["send-keys", "-t", self._tmux_session, "Enter"])
            except (OSError, subprocess.SubprocessError) as e:
                raise OSError("Terminal submit could not be written") from e
            if result.returncode != 0:
                raise OSError("Terminal submit could not be written")
            for _ in range(10):
                await asyncio.sleep(0.1)
                screen = await self._codex_screen(epoch)
                current = _codex_draft(screen)
                if _codex_empty_draft(current):
                    return
                if current is not None and current != draft:
                    raise TerminalInputConflict("Codex draft changed; submission was not confirmed")
        raise TimeoutError("Codex still has the pasted draft; submission was not confirmed")

    async def send_input(self, text: str, *, bracketed_paste: bool = True,
                         submit: bool = True, ready_timeout: float = 30.0) -> None:
        """Serialize workflow submissions and cancel those superseded by Stop.

        A live tmux attach process alone does not prove the CLI can accept a
        task. Codex must show its input box; never report a blind paste as a
        successful workflow delivery after the readiness deadline.
        """
        epoch = self._input_epoch
        codex = bool(self.cmd and os.path.basename(self.cmd[0]).lower() == "codex")
        async with self._input_lock:
            self._check_input_epoch(epoch)
            if codex and self._codex_input_uncertain:
                raise TerminalInputConflict("Codex input ownership is unresolved; restart this terminal before automatic input")
            if codex and not bracketed_paste:
                raise TerminalInputConflict("Codex automatic input requires bracketed paste")
            ready = await self.wait_until_input_ready(timeout=ready_timeout)
            self._check_input_epoch(epoch)
            if not ready:
                if codex:
                    raise TimeoutError("Codex input is not ready; prompt was not delivered")
                delay = float(os.getenv("TERMINAL_INPUT_STARTUP_DELAY_SEC", "0.75"))
                if delay > 0:
                    await asyncio.sleep(delay)
                logger.warning(
                    f"[Terminal] Input-ready hint not seen for agent {self.agent_id} within "
                    f"{ready_timeout}s — pasting prompt anyway after {delay}s fallback"
                )
            if codex:
                # Readiness is not ownership: recapture immediately before paste.
                screen = await self._codex_screen(epoch)
                if not screen_is_input_ready(screen.lower(), _READY_RECIPES["codex"]):
                    raise TerminalInputConflict("Codex composer is not empty and ready; prompt was not delivered")
                # Latch BEFORE writing, including failed/partial writes and task
                # cancellation. Only confirmed consumption clears it. No cleanup
                # keystrokes, no retry of an uncertain paste, no silent recovery.
                self._codex_input_uncertain = True
            self._check_input_epoch(epoch)
            self.clear_auth_error()
            payload = text.encode("utf-8", errors="replace")
            if bracketed_paste:
                payload = b"\x1b[200~" + payload + b"\x1b[201~"
            if submit and not codex:
                payload += b"\r"
            if not await self._write_input(payload):
                raise OSError("Terminal input could not be fully written")
            if submit and codex:
                draft = await self._wait_for_codex_paste(text, epoch)
                await asyncio.sleep(0.2)
                await self._submit_codex_paste(draft, epoch)
                self._codex_input_uncertain = False

    async def write(self, data: bytes) -> bool:
        """Administrator input wins: invalidate any pending automatic injection.

        Do not take _input_lock here; typing/Stop must cancel the workflow rather
        than wait behind it. A stalled write checks its epoch before resuming.
        """
        if data:
            self._input_epoch += 1
        return await self._write_input(data)

    async def _write_input(self, data: bytes) -> bool:
        """Resume temporary PTY backpressure without replaying accepted bytes."""
        if self.master_fd < 0 or self._closed:
            return False
        fd, epoch = self.master_fd, self._input_epoch
        deadline = time.monotonic() + INPUT_WRITE_TIMEOUT_SEC
        pending = memoryview(data)
        while pending:
            # Retrying yields to Stop, administrator input and session closure.
            # Never resume a stale paste or write into a replacement terminal.
            if epoch != self._input_epoch:
                raise InterruptedError("Terminal input interrupted or changed by another writer")
            if self._closed or self.master_fd != fd:
                return False
            try:
                written = os.write(fd, pending)
                if written <= 0:
                    raise OSError("PTY write made no progress")
                pending = pending[written:]
            except OSError as e:
                remaining = deadline - time.monotonic()
                if e.errno in (errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR) and remaining > 0:
                    # Yield so tmux and the output reader can drain their buffers.
                    # A recovered write is successful and produces no error log.
                    await asyncio.sleep(min(0.01, remaining))
                    continue
                logger.warning(f"[Terminal] write to {self.agent_id} failed: {e}")
                return False
        # A headless write (workflow prompt injection with no attached viewer)
        # restarts the idle countdown so the freshly started task isn't reaped
        # at a timer that began ticking at spawn.
        if not self._clients:
            self._schedule_idle_timer()
        return True

    async def interrupt(self) -> dict:
        """Ask the foreground CLI to abort its active run without killing the
        shared terminal session.

        Different coding TUIs deliberately bind different keys for "stop this
        turn"; routing through a backend-specific recipe avoids using Ctrl-C
        for CLIs where it exits the whole app.
        """
        self._input_epoch += 1
        if not self.is_alive():
            return {
                "interrupted": False,
                "reason": "session_not_alive",
            }
        cli_name, key_label, payload = _interrupt_recipe(self.cmd)
        await self._write_input(payload)
        logger.info(
            f"[Terminal] Sent {key_label} interrupt to {cli_name} "
            f"session for agent {self.agent_id}"
        )
        return {
            "interrupted": True,
            "cli": cli_name,
            "sequence": key_label,
            "alive": self.is_alive(),
        }

    async def resize(self, cols: int, rows: int) -> None:
        """Apply a new geometry. A PTY has one size, so the latest viewer to
        claim one wins (like tmux `window-size latest`); every other viewer is
        told the new grid and scales to it (see broadcast_size). TIOCSWINSZ
        also delivers SIGWINCH, which TUIs use to re-layout."""
        cols = max(20, min(500, int(cols)))
        rows = max(5, min(200, int(rows)))
        self.cols = cols
        self.rows = rows
        if self.master_fd >= 0:
            try:
                fcntl.ioctl(
                    self.master_fd, termios.TIOCSWINSZ,
                    struct.pack("HHHH", rows, cols, 0, 0),
                )
            except OSError as e:
                logger.debug(f"[Terminal] TIOCSWINSZ on resize failed: {e}")
        # Always announce, even when unchanged: the requester may have asked
        # for a size we clamped, and must learn the grid actually in force.
        await self.broadcast_size()

    def size_frame(self) -> dict:
        return {"type": "size", "cols": self.cols, "rows": self.rows}

    async def broadcast_size(self) -> None:
        """Tell every viewer the authoritative PTY geometry.

        There is ONE PTY, so there is one grid: a viewer whose xterm keeps its
        own cols/rows re-wraps bytes drawn for another width into garbage
        (e.g. a phone attached next to a desktop). Viewers adopt this size and
        scale their font to fit it instead."""
        async with self._lock:
            targets = [c for c in self._clients.values() if c.on_control is not None]
        frame = self.size_frame()
        for client in targets:
            try:
                await asyncio.wait_for(client.on_control(frame), timeout=CLIENT_SEND_TIMEOUT_SEC)
            except Exception as e:
                # The output path owns eviction; a dead socket fails there too.
                logger.debug(f"[Terminal] size broadcast failed for {client.label}: {e}")

    def history_snapshot(self, max_lines: int = HISTORY_REPLAY_LINES) -> bytes:
        """The pane's scrollback (lines ABOVE the visible screen), with colours,
        ready to seed a freshly attached viewer's xterm scrollback.

        The trailing CRLFs push those lines off the viewer's screen into its
        scrollback; tmux's repaint then draws the live screen below them.
        Lines are captured at the pane width (no -J), which is the grid every
        viewer renders at. Empty on any failure: history is best-effort."""
        if not self._tmux_session or max_lines <= 0:
            return b""
        try:
            res = self._tmux_run([
                "capture-pane", "-p", "-e", "-t", self._tmux_session,
                "-S", f"-{max_lines}", "-E", "-1",
            ])
        except Exception:
            return b""
        if res.returncode != 0:
            return b""
        lines = res.stdout.replace(b"\r\n", b"\n").split(b"\n")
        while lines and not lines[-1].strip():
            lines.pop()
        if not lines:
            return b""
        # Reset SGR at each line end so a colour left open on one line never
        # bleeds into the next (capture-pane -e does not close them).
        body = b"\x1b[0m\r\n".join(lines) + b"\x1b[0m\r\n"
        return body + b"\r\n" * self.rows

    def is_alive(self) -> bool:
        return (
            self.proc is not None
            and self.proc.poll() is None
            and not self._closed
            # Under tmux remain-on-exit the attach client (self.proc) stays up
            # even after the CLI inside the pane has exited; once we've detected
            # that dead pane, the session is no longer usable.
            and not self._pane_dead_handled
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
            "auth_error": self.auth_error,
        }

    def begin_history_capture(self) -> None:
        """Record whether the initial pane observation succeeded, not ownership.

        A failed observation must never become an empty, valid baseline on a
        later successful read. Even a real empty baseline does not prove where
        future TUI redraws came from, so neither case authorizes raw history.
        This changes no terminal contents, scrollback or administrator input.
        """
        baseline = self._pane_lines(HISTORY_BASELINE_LINES)
        self._history_capture_state = (
            HistoryCaptureState.BASELINE_FAILED if baseline is None
            else HistoryCaptureState.SHARED_PANE_UNVERIFIED
        )
        logger.debug(
            "[Terminal] History capture for agent %s: %s",
            self.agent_id, self._history_capture_state.value,
        )

    def _pane_lines(self, lines: int) -> Optional[list[str]]:
        """Cleaned pane lines; [] means a successful empty capture, None failure."""
        if not self._tmux_session:
            return None
        try:
            result = self._tmux_run([
                "capture-pane", "-p", "-J", "-t", self._tmux_session, "-S", f"-{lines}",
            ])
        except Exception:
            return None
        if result.returncode != 0:
            return None
        return _clean_terminal_text(result.stdout.decode("utf-8", "replace")).splitlines()

    def history_output(self) -> str:
        """Return a fixed diagnostic when execution provenance is unproven.

        Never re-read the shared pane or fall back to post-mark PTY bytes:
        both can contain old task text after repaint, scroll, resize or reflow.
        An unavailable initial capture stays unavailable for this execution,
        even if tmux recovers. Completion notes are preserved by the API.
        """
        if self._history_capture_state is HistoryCaptureState.NOT_STARTED:
            return HISTORY_UNSCOPED_NOTICE
        if self._history_capture_state is HistoryCaptureState.BASELINE_FAILED:
            return HISTORY_BASELINE_FAILED_NOTICE
        return HISTORY_UNVERIFIED_NOTICE

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
                rc = await asyncio.to_thread(self.proc.wait, 0.05)
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
        timer = self._idle_timer
        if timer and not timer.done():
            self._idle_timer = None
            # The reaper reaches here through its own close(): cancelling the
            # running task would abort close() at its next await, skipping
            # kill-session and leaving a dead session registered with its tmux
            # attach client still connected.
            if timer is not asyncio.current_task():
                timer.cancel()

    def _schedule_idle_timer(self) -> None:
        self._cancel_idle_timer()

        async def _reap_after_idle() -> None:
            delay = IDLE_TIMEOUT_SEC
            while True:
                try:
                    await asyncio.sleep(delay)
                except asyncio.CancelledError:
                    return
                if self._clients or not self.is_alive():
                    return
                # Pure elapsed time is not idleness: a headless session (no
                # viewer to cancel the timer) may have a workflow task mid-
                # flight. Spare it while the CLI keeps producing output.
                idle_for = time.monotonic() - self._last_output_at
                if idle_for < IDLE_TIMEOUT_SEC:
                    delay = IDLE_TIMEOUT_SEC - idle_for
                    continue
                logger.info(
                    f"[Terminal] Idle timeout reached for agent {self.agent_id} "
                    f"after {IDLE_TIMEOUT_SEC}s with no clients — reaping"
                )
                await self.close()
                return

        self._idle_timer = asyncio.create_task(_reap_after_idle())

    async def _maybe_detach_creds_watcher(self) -> None:
        """Hand this session's creds watcher over to the module-level registry
        when the CLI survived the close (see _start_detached_creds_watcher)."""
        if self._creds_watcher is None:
            return
        if not await self._tmux_session_alive():
            return
        logger.info(
            f"[Terminal] tmux session for agent {self.agent_id} outlived its broker "
            f"— keeping the credentials mirror running while the CLI is alive"
        )
        _start_detached_creds_watcher(
            self.agent_id, self._creds_watcher, self._tmux_session_alive
        )

    async def close(self) -> None:
        """Best-effort shutdown: send SIGTERM, wait briefly, then SIGKILL."""
        if self._closed:
            return
        # Final creds sync BEFORE we mark closed and tear the proc down — the
        # user may have done /login at the last moment and the polling
        # interval may not have fired yet. Safe even if no token is fresh:
        # poll_once is a no-op when nothing has changed. (The files watcher
        # deliberately gets no final sync.)
        if self._creds_watcher is not None:
            try:
                await self._creds_watcher.poll_once()
            except Exception as e:
                logger.warning(f"[Terminal] final creds sync failed for {self.agent_id}: {e}")
        # Same for token accounting: the last turn usually finishes between
        # two watcher ticks, and its tokens would die with the session.
        if self._usage_watcher is not None:
            try:
                await self._usage_watcher.poll_once()
            except Exception as e:
                logger.warning(f"[Usage] final usage scan failed for {self.agent_id}: {e}")
        self._closed = True
        self._cancel_idle_timer()
        if self._creds_sync_task and not self._creds_sync_task.done():
            self._creds_sync_task.cancel()
            self._creds_sync_task = None
        if self._files_sync_task and not self._files_sync_task.done():
            self._files_sync_task.cancel()
            self._files_sync_task = None
        if self._usage_watch_task and not self._usage_watch_task.done():
            self._usage_watch_task.cancel()
            self._usage_watch_task = None

        # Kill the tmux session first: the real CLI lives in the tmux server
        # (not as a child of `self.proc`, which is only the attach client), so
        # terminating the attach alone would orphan the CLI in tmux. kill-session
        # ends the CLI and makes the attach client exit cleanly.
        if self._tmux_session:
            try:
                await asyncio.to_thread(
                    self._tmux_run, ["kill-session", "-t", self._tmux_session]
                )
            except Exception as e:
                logger.debug(f"[Terminal] tmux kill-session failed for {self.agent_id}: {e}")
            # kill-session is best-effort (it can time out against a busy tmux
            # server). When it didn't take, the CLI is still running with no
            # session watching it — keep mirroring its credentials so a
            # background token refresh isn't lost.
            await self._maybe_detach_creds_watcher()

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
                await asyncio.to_thread(self.proc.wait, 2)
            except subprocess.TimeoutExpired:
                pass
            for sig in (signal.SIGTERM, signal.SIGKILL):
                if self.proc.poll() is not None:
                    break
                try:
                    self.proc.send_signal(sig)
                    await asyncio.to_thread(self.proc.wait, 2)
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
# Per-agent locks: one slow spawn (token hydration, HOME provisioning, tmux
# new-session) must not queue every other agent's attach/input behind it.
# setdefault is atomic enough in single-threaded asyncio (no await between
# lookup and insert). Entries are tiny and keyed by agent_id, so they are
# deliberately never pruned — popping a lock while a waiter still holds it
# would let two spawns for the same agent race.
_SESSION_LOCKS: dict[str, asyncio.Lock] = {}
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
    from agent_user import _get_project_lock
    async with _get_project_lock(agent_id), _SESSION_LOCKS.setdefault(agent_id, asyncio.Lock()):
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
            creds_watch_path=recipe.get("creds_watch_path"),
            creds_on_change=recipe.get("creds_on_change"),
            creds_dedup_key=recipe.get("creds_dedup_key"),
            files_watch_paths=recipe.get("files_watch_paths"),
            files_on_change=recipe.get("files_on_change"),
            usage_watch=recipe.get("usage_watch"),
        )
        # The new session's watcher takes over the file; a leftover detached
        # one would poll the same path with a stale baseline.
        cancel_detached_creds_watcher(agent_id)
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


async def interrupt_session(agent_id: str) -> dict:
    session = _SESSIONS.get(agent_id)
    if session is None:
        return {
            "interrupted": False,
            "reason": "no_session",
        }
    return await session.interrupt()


async def close_all_sessions() -> None:
    """Shutdown hook — terminate every live session on service stop."""
    sessions = list(_SESSIONS.values())
    for s in sessions:
        try:
            await s.close()
        except Exception as e:
            logger.warning(f"[Terminal] close_all_sessions error on {s.agent_id}: {e}")
