"""
Startup-prompt knowledge shared by the two PTY drivers.

The shared-PTY broker (pty_session) auto-answers known CLI startup
confirmations from the declarative STARTUP_PROMPTS table below; the one-shot
interactive driver (backends/claude_interactive) reuses the trust/bypass
regexes but keeps its own answer recipes (it ships keystrokes through a
blocking, jittered, offset-tracking path the broker doesn't have).

Leaf module by design: it imports only re/dataclasses. pty_session must not
import anything from the backends package — backends/__init__ instantiates
the BACKEND singleton (and raises on unknown RUNNER_TYPE) at package import.
"""
from __future__ import annotations

import re
from dataclasses import dataclass


# Sentinel inside a StartupPrompt.keys recipe: wait one render tick
# (asyncio.sleep(0.12)) before sending the remaining keystrokes, so the TUI
# has repainted its selection highlight before the confirming Enter lands.
PAUSE = object()


# Trust-folder prompt: the wording varies across Claude Code CLI versions
# AND the TUI lays each word out with absolute cursor positions (so after
# ANSI-stripping the buffer is compacted to e.g. "Isthisaprojectyou…trust?").
# `\s*` between every word matches either form. Each alternative is
# distinctive enough that over-matching against chat content is unlikely.
#
# Shared as an alternation LIST, not a compiled pattern: pty_session appends
# one extra wording (the directory variant) that claude_interactive must NOT
# match — its trust branch preempts the numbered-choice/arrow/fallback-LLM
# branches, so widening its regex would change behavior there.
_TRUST_ALTERNATIVES_BASE = (
    r"do\s*you\s*trust\s*this\s*folder",
    r"is\s*this\s*a\s*project\s*you\s*(created|trust)",
    r"trust\s*this\s*folder\s*\?",
    r"yes,?\s*i\s*trust\s*this\s*folder",
)


def build_trust_re(extra_alternatives: tuple = ()) -> re.Pattern:
    """Compile the trust-folder prompt regex from the shared alternation
    list, optionally extended with caller-specific wordings."""
    alternatives = _TRUST_ALTERNATIVES_BASE + tuple(extra_alternatives)
    return re.compile("(" + "|".join(alternatives) + ")", re.IGNORECASE)


# The trust screen's option ORDER is not stable across Claude Code versions.
# 2.1.258 renders the destructive option as the highlighted default:
#
#     Security guide
#     ❯ No, exit
#       Yes, I trust this folder
#     Enter to confirm · Esc to cancel
#
# so the bare Enter both drivers used to send picked "No, exit" and the CLI
# exited at startup — verified in a runner container: after Enter the tmux
# server is gone, while Down+Enter reaches the prompt. Hardcoding "one Down"
# would just move the bug to the next reordering, so the keystrokes are derived
# from the screen instead: find the accept line, find the selection marker, and
# walk from one to the other.
_TRUST_ACCEPT_RE = re.compile(r"yes,?\s*i\s*trust\s*this\s*folder", re.IGNORECASE)
# Markers Claude Code has used for the highlighted row. A bare ">" is
# deliberately absent: it appears in the assistant's own markdown. These are the
# UTF-8 glyphs; the CLI falls back to ASCII ones only without a UTF-8 locale,
# which the runner never does (the image sets LANG=C.UTF-8 and sanitize_env
# allowlists LANG/LC_ALL/LC_CTYPE). If that ever changes the recipe reads no
# marker and answers nothing, which is the safe direction.
_SELECTION_MARKERS = ("❯", "›", "▶")
# The marker must be on a line near the accept line — beyond that we are
# looking at unrelated chrome (the input caret uses ❯ too).
_TRUST_MARKER_WINDOW = 6
# A trust dialog with more options than this is not one we understand.
_TRUST_MAX_STEPS = 4


def trust_answer_keys(screen: str) -> tuple:
    """Keystrokes that select "Yes, I trust this folder" and confirm it.

    `screen` is the ANSI-stripped tail of the TUI. Returns an empty tuple when
    the layout can't be read — callers must then send NOTHING and retry on a
    later frame. Doing nothing leaves the dialog up for the user; guessing
    wrong exits the CLI, which is how this bug presented.
    """
    lines = screen.splitlines()
    accept_idx = None
    for idx in range(len(lines) - 1, -1, -1):
        if _TRUST_ACCEPT_RE.search(lines[idx]):
            accept_idx = idx
            break
    if accept_idx is None:
        return ()
    marker_idx = None
    lo = max(0, accept_idx - _TRUST_MARKER_WINDOW)
    hi = min(len(lines), accept_idx + _TRUST_MARKER_WINDOW + 1)
    for idx in range(hi - 1, lo - 1, -1):
        if any(marker in lines[idx] for marker in _SELECTION_MARKERS):
            marker_idx = idx
            break
    if marker_idx is None:
        return ()
    steps = accept_idx - marker_idx
    if abs(steps) > _TRUST_MAX_STEPS:
        return ()
    move = b"\x1b[B" if steps > 0 else b"\x1b[A"  # CSI B / CSI A = Down / Up
    keys: tuple = tuple(move for _ in range(abs(steps)))
    # The confirming Enter must land AFTER the TUI has repainted its selection,
    # or it confirms the row we were moving off (see the bypass recipe).
    return keys + (PAUSE, b"\r") if keys else (b"\r",)


# Bypass-permissions warning: shown when the CLI is started with
# `--dangerously-skip-permissions`. Two numbered options where the DEFAULT
# (option 1) is "No, exit" — picking the default would terminate the CLI.
BYPASS_PERMS_RE = re.compile(
    r"(bypass\s*permissions\s*mode|yes,?\s*i\s*accept)",
    re.IGNORECASE,
)

CODEX_UPDATE_RE = re.compile(
    r"(update\s+now"
    r".{0,500}npm\s+install\s+-g\s+@openai/codex"
    r".{0,500}\bskip\b)",
    re.IGNORECASE | re.DOTALL,
)

OPENCODE_UPDATE_RE = re.compile(
    r"(new\s+release\s+v?\d+(?:\.\d+){1,3}"
    r".{0,500}\bis\s+available\b"
    r".{0,500}would\s+you\s+like\s+to\s+update\s+now\??)",
    re.IGNORECASE | re.DOTALL,
)


@dataclass(frozen=True)
class StartupPrompt:
    """One auto-answerable startup confirmation for the shared PTY broker."""
    key: str                 # dedup key in PtySession._auto_answered
    pattern: re.Pattern      # matched against the ANSI-stripped output tail
    # Keystrokes (bytes), with an optional PAUSE sentinel — or a callable taking
    # the matched screen and returning that tuple, for a dialog whose option
    # order moves between CLI versions. An empty result means "can't read this
    # screen": the caller sends nothing and retries on a later frame instead of
    # confirming a row it hasn't identified.
    keys: object
    description: str         # log wording: "Auto-answer <description> prompt"
    keys_label: str          # log wording for the keystrokes sent


# Table order is match priority (checked first to last).
STARTUP_PROMPTS: tuple[StartupPrompt, ...] = (
    # Codex's update prompt: option 2 is "Skip".
    StartupPrompt(
        key="codex_update",
        pattern=CODEX_UPDATE_RE,
        keys=(b"2\r",),
        description="codex update",
        keys_label="2+Enter",
    ),
    # OpenCode's update prompt: move Left to "No", confirm after a render tick.
    StartupPrompt(
        key="opencode_update",
        pattern=OPENCODE_UPDATE_RE,
        keys=(b"\x1b[D", PAUSE, b"\r"),
        description="opencode update",
        keys_label="Left+Enter",
    ),
    # Trust folder. The accepting option is NOT reliably the highlighted one
    # (2.1.258 highlights "No, exit"), so the move is computed from the screen
    # — see trust_answer_keys.
    StartupPrompt(
        key="trust",
        pattern=build_trust_re(
            (r"do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*director(y|ies)",)
        ),
        keys=trust_answer_keys,
        description="trust-folder",
        keys_label="move to “Yes, I trust this folder”+Enter",
    ),
    # On the bypass-permissions warning, option 1 is "No, exit" and option 2
    # is "Yes, I accept". Move down once, then confirm after a render tick.
    StartupPrompt(
        key="bypass",
        pattern=BYPASS_PERMS_RE,
        keys=(b"\x1b[B", PAUSE, b"\r"),
        description="bypass-permissions",
        keys_label="Down+Enter",
    ),
)
