"""OpenCode runtime tests — does an agent on the default (free) OpenCode agent
actually reach a usable terminal and answer?

Two layers, because the two failure modes we hit have different reach:

  1. Recorded-frame tests (always run). The PTY broker decides "the TUI is
     ready for a prompt" by matching sentinels against the rendered screen. Our
     sentinels were Claude's (`▌`, `Type / for commands`) and matched NOTHING
     in opencode's TUI, so every injection timed out after 45 s and then pasted
     blind — into whatever screen happened to be up. The frames below are
     verbatim captures of the real CLI (1.17.12 and 1.18.25); they pin the
     recipe to what opencode actually renders without needing the binary.

  2. A live spawn (auto-skips without the `opencode` binary or tmux, like
     test_cli_flag_compatibility). It runs the production recipe end to end:
     prepare_interactive → PtySession → wait_until_input_ready → prompt → the
     free OpenCode Zen agent's answer → ready again. Run it inside the runner
     image / a deployed container, which ships both:
         /opt/venv/bin/python -m pytest tests/test_opencode_runtime.py
"""

import asyncio
import json
import os
import re
import shutil
import sys
import time
from pathlib import Path

import pyte
import pytest

if os.name == "nt":
    pytest.skip("pty_session depends on POSIX termios", allow_module_level=True)

os.environ.setdefault("RUNNER_TYPE", "opencode")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from _cli_matrix import build_recipe  # noqa: E402
from pty_session import (  # noqa: E402
    _DEFAULT_READY_RECIPE,
    _ready_recipe,
    _strip_ansi,
    PtySession,
)

# ── Layer 1: recorded frames ────────────────────────────────────────────────
# Captured with `tmux capture-pane -p` against the real CLI in the runner image
# (blank lines squeezed). Keep them verbatim: they are the contract between our
# sentinels and opencode's TUI, and re-capturing them is how we notice the CLI
# moved its chrome again.

# Cold start, no per-agent config — the "Default LLM" case the free agent uses.
OPENCODE_COLD_START = """
                                         █▀▀█ █▀▀█ █▀▀█ █▀▀▄ █▀▀▀ █▀▀█ █▀▀█ █▀▀█
                       ┃
                       ┃  Ask anything... "Fix a TODO in the codebase"
                       ┃
                       ┃  Build · Big Pickle OpenCode Zen
                       ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                       tab agents  ctrl+p commands
                                ● Tip Run /connect to add an AI provider
  /app                                                                  1.18.25
"""

# Back at the input box after a completed turn — note opencode drops the
# `Ask anything...` placeholder here, so only the footer survives both screens.
OPENCODE_IDLE_AFTER_TURN = """
  ┃
  ┃  Reply with exactly: PONG42
  ┃
     PONG42
     ▣  Build · Big Pickle · 3.4s
  ┃
  ┃
  ┃  Build · Big Pickle OpenCode Zen
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   /app                                        8.2K (4%)  ctrl+p commands
"""

# Mid-response. The footer hint is still on screen, which is exactly why the
# recipe needs the `esc interrupt` veto: pasting here interleaves a second
# prompt into a running turn.
OPENCODE_BUSY = """
  ┃
  ┃
  ┃  Build · Big Pickle OpenCode Zen
  ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                        tab agents  ctrl+p commands
"""

# The self-update modal (opencode 1.17.12 against a newer npm release). It
# steals focus, so the input box behind it cannot take a prompt.
OPENCODE_UPDATE_MODAL = """
                                Update Available                            esc
                                A new release v1.18.25 is available. Would you like to
                                update now?
                                                                 Skip  Confirm
                       ┃
                       ┃  Ask anything... "Fix a TODO in the codebase"
                       ┃
                       ┃  Build · Big Pickle OpenCode Zen
                       ╹▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀
                                                    tab agents  ctrl+p commands
  /app                                                                  1.17.12
"""

OPENCODE_RECIPE = _ready_recipe(["opencode"])


def _classify(frame):
    from pty_session import screen_is_input_ready

    return screen_is_input_ready(_strip_ansi(frame).lower(), OPENCODE_RECIPE)


@pytest.mark.parametrize(
    "frame, label",
    [(OPENCODE_COLD_START, "cold start"), (OPENCODE_IDLE_AFTER_TURN, "idle after turn")],
    ids=["cold-start", "idle-after-turn"],
)
def test_ready_frames_are_recognised(frame, label):
    assert _classify(frame), (
        f"opencode's {label} screen is not recognised as input-ready — the PTY "
        f"broker will burn its whole wait_until_input_ready budget and then "
        f"paste the prompt blind."
    )


@pytest.mark.parametrize(
    "frame, label",
    [(OPENCODE_BUSY, "mid-response"), (OPENCODE_UPDATE_MODAL, "self-update modal")],
    ids=["mid-response", "update-modal"],
)
def test_busy_frames_are_not_mistaken_for_ready(frame, label):
    assert not _classify(frame), (
        f"opencode's {label} screen was read as input-ready — a prompt pasted "
        f"there is swallowed or interleaved into a running turn."
    )


def test_default_hints_do_not_match_opencode():
    """The regression itself: Claude's sentinels match none of opencode's
    screens, so opencode MUST keep its own recipe."""
    from pty_session import screen_is_input_ready

    for frame in (OPENCODE_COLD_START, OPENCODE_IDLE_AFTER_TURN):
        assert not screen_is_input_ready(
            _strip_ansi(frame).lower(), _DEFAULT_READY_RECIPE
        )


def test_opencode_has_a_dedicated_recipe():
    assert _ready_recipe(["opencode"]) is not _DEFAULT_READY_RECIPE
    assert _ready_recipe(["/usr/bin/opencode"]) is OPENCODE_RECIPE
    # A CLI with no override still falls back to the default. (claude used to
    # stand in here; it has its own recipe now — see test_claude_ready_recipe.)
    assert _ready_recipe(["codex"]) is _DEFAULT_READY_RECIPE


# ── Layer 2: live spawn against the real CLI ────────────────────────────────

READY_TIMEOUT = float(os.getenv("OPENCODE_RUNTIME_READY_TIMEOUT_SEC", "60"))
ANSWER_TIMEOUT = float(os.getenv("OPENCODE_RUNTIME_ANSWER_TIMEOUT_SEC", "150"))

# The model is asked to join two fragments, so the sentinel cannot come from
# the echoed prompt itself — only from an actual answer.
PROMPT = "Reply with exactly PONG immediately followed by 42, and nothing else."
SENTINEL = "PONG42"


def _skip_unless_runnable():
    if not shutil.which("opencode"):
        pytest.skip("opencode is not installed")
    if not shutil.which("tmux"):
        pytest.skip("tmux is not installed (required by PtySession)")


def _screen(session, max_bytes=400_000):
    """The TUI as a terminal emulator would show it.

    Stripping ANSI from the raw stream is not enough here: opencode streams the
    answer while animating a spinner elsewhere on screen, so a plain
    concatenation of every repaint interleaves them ("PONG" … spinner frames …
    "42"). Replaying the bytes through pyte collapses the redraws into the
    screen the user actually sees — the same trick the Claude interactive
    driver uses to read an answer out of a TUI."""
    screen = pyte.Screen(session.cols, session.rows)
    stream = pyte.Stream(screen)
    stream.feed(session.tail_text(max_bytes=max_bytes))
    return "\n".join(screen.display)


def _squeezed(text):
    """Whitespace-free view of the screen: opencode may wrap the answer across
    the pane's right edge, which would split the sentinel in two."""
    return re.sub(r"\s+", "", text)


@pytest.fixture
def default_agent_recipe(request, tmp_path, monkeypatch):
    """(agent_id, recipe) for an agent left on the default (free) OpenCode
    agent — no per-agent LLM config at all.

    Built eagerly in a *sync* fixture on purpose: build_recipe drives
    prepare_interactive through asyncio.run, which cannot be called from inside
    the async tests' running event loop."""
    import backends.cli_backend as cli_backend_module
    import backends.opencode as opencode_module

    # No per-agent model: neither a cached one nor one hydrated from team-api.
    monkeypatch.setattr(cli_backend_module, "fetch_agent_llm_config", lambda _aid: None)
    # The operator's local vLLM/Ollama list is a team-api fetch; pin it empty so
    # the recipe is the same on a laptop and in the cluster.
    monkeypatch.setattr(opencode_module, "fetch_local_models", lambda: [])

    agent_id = "agent-oc-" + re.sub(r"[^A-Za-z0-9_-]", "-", request.node.name)
    return agent_id, build_recipe(
        "opencode", tmp_path, monkeypatch, llm=None, agent_id=agent_id
    )


def test_default_agent_recipe_leaves_model_and_updates_to_opencode(
    tmp_path, default_agent_recipe
):
    """Guards the recipe the live tests then spawn (and runs without the CLI):
    no `--model` (so OpenCode Zen's free default is used) and auto-update off
    (so the update modal can never take the first prompt)."""
    _agent_id, recipe = default_agent_recipe

    assert recipe["cmd"] == ["opencode"], (
        f"the default-LLM recipe must pass no model override, got {recipe['cmd']!r}"
    )
    assert recipe["env"]["OPENCODE_DISABLE_AUTOUPDATE"] == "1"

    config = json.loads(
        (tmp_path / ".config" / "opencode" / "config.json").read_text()
    )
    assert config["autoupdate"] is False, (
        "opencode would offer its self-update modal on every cold start of an "
        "image that is behind the latest npm release, swallowing the prompt."
    )
    assert "model" not in config


@pytest.mark.asyncio
async def test_opencode_terminal_reaches_input_box(default_agent_recipe):
    """The regression that broke the terminal: with the real CLI in a real PTY,
    the broker must SEE the input box rather than time out and paste blind."""
    _skip_unless_runnable()
    agent_id, recipe = default_agent_recipe
    session = PtySession(
        agent_id=agent_id,
        cmd=recipe["cmd"],
        cwd=recipe["cwd"],
        env=recipe["env"],
        preexec_fn=recipe.get("preexec_fn"),
    )
    await session.start()
    try:
        started = time.monotonic()
        ready = await session.wait_until_input_ready(timeout=READY_TIMEOUT)
        elapsed = time.monotonic() - started
        screen = _screen(session)
        assert ready, (
            f"opencode never reported an input box within {READY_TIMEOUT}s. "
            f"Last screen:\n{screen[-2000:]}"
        )
        assert "would you like to update now" not in screen.lower(), (
            "the self-update modal is up despite autoupdate being disabled — it "
            "will swallow the first injected prompt.\n"
            f"Last screen:\n{screen[-2000:]}"
        )
        assert elapsed < READY_TIMEOUT
    finally:
        await session.close()


@pytest.mark.asyncio
async def test_opencode_default_free_agent_answers(default_agent_recipe):
    """End to end on the free default agent: prompt in, answer out, and the
    broker back to "ready" afterwards (the gate that keeps the next workflow
    prompt from landing mid-turn)."""
    _skip_unless_runnable()
    agent_id, recipe = default_agent_recipe
    session = PtySession(
        agent_id=agent_id,
        cmd=recipe["cmd"],
        cwd=recipe["cwd"],
        env=recipe["env"],
        preexec_fn=recipe.get("preexec_fn"),
    )
    await session.start()
    try:
        assert await session.wait_until_input_ready(timeout=READY_TIMEOUT), (
            f"opencode never reached its input box:\n{_screen(session)[-2000:]}"
        )

        await session.write(PROMPT.encode())
        await asyncio.sleep(0.5)
        await session.write(b"\r")

        deadline = time.monotonic() + ANSWER_TIMEOUT
        while time.monotonic() < deadline:
            if SENTINEL in _squeezed(_screen(session)):
                break
            await asyncio.sleep(1.0)
        else:
            pytest.fail(
                f"the default (free) opencode agent produced no answer within "
                f"{ANSWER_TIMEOUT}s.\nLast screen:\n{_screen(session)[-3000:]}"
            )

        assert await session.wait_until_input_ready(timeout=READY_TIMEOUT), (
            "opencode answered but the broker never saw it return to the input "
            "box, so the next injected prompt would be pasted mid-turn.\n"
            f"Last screen:\n{_screen(session)[-2000:]}"
        )
    finally:
        await session.close()
