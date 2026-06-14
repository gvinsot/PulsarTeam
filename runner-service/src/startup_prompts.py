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
    keys: tuple              # keystrokes (bytes), with optional PAUSE sentinel
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
    # Option 1 ("Yes, I trust this folder") is highlighted by default in
    # Claude Code's TUI; Enter confirms it without leaking a typed "1" into
    # the following screen.
    StartupPrompt(
        key="trust",
        pattern=build_trust_re(
            (r"do\s*you\s*trust\s*the\s*contents\s*of\s*this\s*director(y|ies)",)
        ),
        keys=(b"\r",),
        description="trust-folder",
        keys_label="Enter",
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
