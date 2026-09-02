"""The PTY broker must recognise Claude Code's input box.

Same failure as opencode had: `wait_until_input_ready` gates every workflow
prompt injection on sentinels matched against the rendered screen, and Claude
Code renders none of the defaults (`▌`, `Type / for commands`, `Try "`):

  • its caret is `❯`, not `▌`;
  • `Try "…"` is a cold-start example prompt — gone once the box has been used,
    and absent entirely when the CLI is logged out.

The frames below are verbatim `tmux capture-pane` output from claude 2.1.258 in
a runner container. They show the one sentinel that survives every state — the
status footer — and its mid-response replacement:

    cold start / idle   ⏸ manual mode on · ? for shortcuts · ← for agents
    mid-response        ⏸ manual mode on · esc to interrupt · ← for agents

Re-capturing these is how we notice the CLI moved its chrome again.

Linux-only, like the rest of the suite; no CLI binary or network needed.
"""

import asyncio
import os
import re
import sys
import time
from pathlib import Path

import pytest

if os.name == "nt":
    pytest.skip("pty_session depends on POSIX termios", allow_module_level=True)

os.environ.setdefault("RUNNER_TYPE", "claude-code")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pty_session import (  # noqa: E402
    _DEFAULT_READY_RECIPE,
    _ready_recipe,
    _strip_ansi,
    screen_is_input_ready,
)

CLAUDE_COLD_START = """\
 ▐▛███▛█   Claude Code v2.1.258
▝▜██████▀  Sonnet 5 · Claude API
  ▝▝ ▝▝    ~/projects/gvinsot/PulsarTeam
  Fable 5.1 writes better code and reports progress on long tasks. Switch anytime with /model.
                     tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf
────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for index.ts"
────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
"""

CLAUDE_BUSY = """\
✶ Tempering…
                  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf
────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · esc to interrupt · ← for agents
"""

# Note the empty input box: the `Try "…"` examples are NOT shown any more.
CLAUDE_IDLE_AFTER_TURN = """\
  paired "master" and "slave" interface. Programs like shells, SSH sessions, or terminal emulators
  controlling process reads and writes through the master end to interact with it programmatically.
✻ Crunched for 4s · done 6:23 PM
────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
"""

# Logged out: no example prompts either, and an extra status segment.
CLAUDE_LOGGED_OUT = """\
────────────────────────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents      Not logged in · Run /login   ● high · /effort
"""

# What `_strip_ansi` over the RAW PTY stream actually yields: the TUI positions
# each word absolutely, so the footer comes out with its spaces collapsed. A
# sentinel written the way a human sees it must still match this.
CLAUDE_RAW_STREAM_FOOTER = (
    "────❯  (B\n"
    "────⏸manualmodeon·?forshortcuts·←foragentsNotloggedin·Run/login●high·/effort"
)

CLAUDE_RECIPE = _ready_recipe(["claude"])


def _classify(frame, recipe=None):
    return screen_is_input_ready(_strip_ansi(frame).lower(), recipe or CLAUDE_RECIPE)


@pytest.mark.parametrize(
    "frame, label",
    [
        (CLAUDE_COLD_START, "cold start"),
        (CLAUDE_IDLE_AFTER_TURN, "idle after turn"),
        (CLAUDE_LOGGED_OUT, "logged out"),
        (CLAUDE_RAW_STREAM_FOOTER, "raw stream, spaces collapsed"),
    ],
    ids=["cold-start", "idle-after-turn", "logged-out", "raw-stream"],
)
def test_ready_frames_are_recognised(frame, label):
    assert _classify(frame), (
        f"claude's {label} screen is not recognised as input-ready — the broker "
        f"burns its whole wait_until_input_ready budget and then pastes the "
        f"prompt blind"
    )


def test_mid_response_is_not_mistaken_for_ready():
    """`wait_until_input_ready` doubles as the "PTY is free" gate: a prompt
    pasted here interleaves into a running turn."""
    assert not _classify(CLAUDE_BUSY)


def test_default_hints_only_ever_matched_the_cold_start():
    """Why this looked intermittent rather than broken: the default `Try "`
    hint does match the cold-start example prompt, so the very first injection
    could work — and every later one, on the used or logged-out box, timed out.
    """
    assert _classify(CLAUDE_COLD_START, _DEFAULT_READY_RECIPE)
    for frame in (CLAUDE_IDLE_AFTER_TURN, CLAUDE_LOGGED_OUT, CLAUDE_RAW_STREAM_FOOTER):
        assert not _classify(frame, _DEFAULT_READY_RECIPE), (
            "claude must keep its own recipe — the defaults are Claude's OLD "
            "chrome and stop matching as soon as the box has been used"
        )


def test_claude_has_a_dedicated_recipe():
    assert _ready_recipe(["claude"]) is not _DEFAULT_READY_RECIPE
    assert _ready_recipe(["/usr/bin/claude"]) is CLAUDE_RECIPE
    assert _ready_recipe(["codex"]) is _DEFAULT_READY_RECIPE


def test_recipe_is_evaluated_per_frame():
    """Declaring busy markers is what makes wait_until_input_ready re-base its
    scan on each repaint — without that a stale idle frame out-votes the
    current busy one."""
    assert CLAUDE_RECIPE.busy


def test_whitespace_squeeze_applies_to_the_busy_veto_too():
    """The squeeze is not hint-only: a collapsed frame carrying BOTH sentinels
    must still read as busy, or the tolerance would quietly disable the veto."""
    both_collapsed = "?forshortcuts ⏸manualmodeon·esctointerrupt·←foragents"

    assert not screen_is_input_ready(both_collapsed.lower(), CLAUDE_RECIPE)
    # …and the hint alone, collapsed, is still recognised.
    assert screen_is_input_ready("⏸manualmodeon·?forshortcuts", CLAUDE_RECIPE)


# ── Live: the real CLI through the production broker ────────────────────────
#
# Auto-skips without the binary/tmux, and without a logged-in HOME to clone
# (the round trip needs a usable token). Run inside a runner container:
#     /opt/venv/bin/python -m pytest tests/test_claude_ready_recipe.py

import glob  # noqa: E402
import shutil  # noqa: E402

from pty_session import PtySession  # noqa: E402

LIVE_TIMEOUT = float(os.getenv("CLAUDE_READY_TIMEOUT_SEC", "60"))
ANSWER_TIMEOUT = float(os.getenv("CLAUDE_ANSWER_TIMEOUT_SEC", "150"))
PROMPT = "Reply with exactly PONG immediately followed by 42, and nothing else."
SENTINEL = "PONG42"


def _logged_in_home(tmp_path):
    """Clone a provisioned agent HOME so the CLI starts authenticated and past
    the trust dialog. Skips when the container has no agent yet."""
    for src in glob.glob("/app/data/agents/*/"):
        if os.path.isfile(os.path.join(src, ".claude", ".credentials.json")):
            dst = str(tmp_path / "home")
            shutil.copytree(src, dst)
            claude_json = os.path.join(dst, ".claude.json")
            try:  # re-point the per-project keys (trust, history) at the clone
                with open(claude_json) as f:
                    body = f.read()
                with open(claude_json, "w") as f:
                    f.write(body.replace(src.rstrip("/"), dst))
            except OSError:
                pass
            cwd = os.path.join(dst, "projects")
            matches = glob.glob(os.path.join(cwd, "*", "*"))
            return dst, (matches[0] if matches else dst)
    pytest.skip("no provisioned claude agent HOME to clone in this container")


def _live_or_skip():
    if not shutil.which("claude"):
        pytest.skip("claude is not installed")
    if not shutil.which("tmux"):
        pytest.skip("tmux is not installed (required by PtySession)")


@pytest.mark.asyncio
async def test_broker_sees_the_input_box_before_and_after_a_turn(tmp_path):
    """The whole point of the recipe. Before this, cold start matched only by
    luck (the `Try "…"` example) and the post-turn box matched nothing, so every
    later injection burned the full timeout and pasted blind."""
    _live_or_skip()
    home, cwd = _logged_in_home(tmp_path)
    session = PtySession(
        agent_id="agent-claude-ready",
        cmd=["claude"],
        cwd=cwd,
        env={
            "HOME": home,
            "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
            "LANG": os.environ.get("LANG", "C.UTF-8"),
            "TERM": os.environ.get("TERM", "xterm-256color"),
        },
    )
    await session.start()
    try:
        assert await session.wait_until_input_ready(timeout=LIVE_TIMEOUT), (
            f"cold start not seen as ready:\n{session._rendered_screen()}"
        )

        await session.write(PROMPT.encode())
        await asyncio.sleep(0.5)
        await session.write(b"\r")

        deadline = time.monotonic() + ANSWER_TIMEOUT
        while time.monotonic() < deadline:
            if SENTINEL in re.sub(r"\s+", "", session._rendered_screen()):
                break
            await asyncio.sleep(1.0)
        else:
            pytest.fail(
                f"no answer within {ANSWER_TIMEOUT}s:\n{session._rendered_screen()}"
            )

        assert await session.wait_until_input_ready(timeout=LIVE_TIMEOUT), (
            "the box was not seen as ready again after the turn — the next "
            f"injection would be pasted blind:\n{session._rendered_screen()}"
        )
    finally:
        await session.close()
