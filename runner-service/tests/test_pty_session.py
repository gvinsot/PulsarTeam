import asyncio
import os
import sys
import time
from pathlib import Path

import pytest

if os.name == "nt":
    pytest.skip("pty_session depends on POSIX termios", allow_module_level=True)

os.environ.setdefault("RUNNER_TYPE", "codex")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from pty_session import PtySession  # noqa: E402


@pytest.mark.asyncio
async def test_auto_answers_opencode_update_prompt(monkeypatch):
    session = PtySession(agent_id="agent-a", cmd=["opencode"], cwd="/tmp", env={})
    session.master_fd = 1
    written = []

    monkeypatch.setattr(session, "_write_keystroke", lambda data: written.append(data))

    session._maybe_auto_answer_startup_prompt(
        b"A new release v1.16.1 is available. Would you like to update now?"
    )
    await asyncio.sleep(0.2)

    assert written == [b"\x1b[D", b"\r"]
    assert "opencode_update" in session._auto_answered


@pytest.mark.asyncio
async def test_auto_answers_opencode_update_prompt_once(monkeypatch):
    session = PtySession(agent_id="agent-a", cmd=["opencode"], cwd="/tmp", env={})
    session.master_fd = 1
    session._last_auto_answer_at = time.monotonic() - 10
    written = []

    monkeypatch.setattr(session, "_write_keystroke", lambda data: written.append(data))

    prompt = b"A new release v1.16.1 is available. Would you like to update now?"
    session._maybe_auto_answer_startup_prompt(prompt)
    await asyncio.sleep(0.2)
    session._last_auto_answer_at = time.monotonic() - 10
    session._maybe_auto_answer_startup_prompt(prompt)
    await asyncio.sleep(0.2)

    assert written == [b"\x1b[D", b"\r"]


def test_auto_answers_codex_update_prompt(monkeypatch):
    session = PtySession(agent_id="agent-a", cmd=["codex"], cwd="/tmp", env={})
    session.master_fd = 1
    written = []

    monkeypatch.setattr(session, "_write_keystroke", lambda data: written.append(data))

    session._maybe_auto_answer_startup_prompt(
        b"""
        A new version of Codex is available.
        1. Update now (runs `npm install -g @openai/codex`)
        2. Skip
        """
    )

    assert written == [b"2\r"]
    assert "codex_update" in session._auto_answered


def test_auto_answers_codex_update_prompt_once(monkeypatch):
    session = PtySession(agent_id="agent-a", cmd=["codex"], cwd="/tmp", env={})
    session.master_fd = 1
    session._last_auto_answer_at = time.monotonic() - 10
    written = []

    monkeypatch.setattr(session, "_write_keystroke", lambda data: written.append(data))

    prompt = (
        b"1. Update now (runs `npm install -g @openai/codex`)\r\n"
        b"2. Skip\r\n"
    )
    session._maybe_auto_answer_startup_prompt(prompt)
    session._last_auto_answer_at = time.monotonic() - 10
    session._maybe_auto_answer_startup_prompt(prompt)

    assert written == [b"2\r"]


def test_set_auth_error_latches_once():
    session = PtySession(agent_id="agent-a", cmd=["claude"], cwd="/tmp", env={})

    session.set_auth_error("Please run /login")
    assert session.auth_error == "Please run /login"
    assert session.status()["auth_error"] == "Please run /login"

    # First match wins — a later preflight/detection must not overwrite it.
    session.set_auth_error("a different error")
    assert session.auth_error == "Please run /login"


def test_set_auth_error_ignores_empty():
    session = PtySession(agent_id="agent-a", cmd=["claude"], cwd="/tmp", env={})
    session.set_auth_error("")
    assert session.auth_error is None


def test_clear_then_set_auth_error_roundtrip():
    session = PtySession(agent_id="agent-a", cmd=["claude"], cwd="/tmp", env={})
    session.set_auth_error("Please run /login")
    session.clear_auth_error()
    assert session.auth_error is None
    # After a genuine recovery + a fresh logout, the latch works again.
    session.set_auth_error("Please run /login")
    assert session.auth_error == "Please run /login"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("cmd", "expected_sequence", "expected_label"),
    [
        (["claude"], b"\x03", "ctrl-c"),
        (["codex"], b"\x1b", "escape"),
        (["opencode"], b"\x07", "ctrl-g"),
        (["openclaw", "tui"], b"\x1b", "escape"),
        (["hermes", "chat"], b"\x03", "ctrl-c"),
        (["aider"], b"\x03", "ctrl-c"),
    ],
)
async def test_interrupt_uses_cli_specific_sequence(monkeypatch, cmd, expected_sequence, expected_label):
    session = PtySession(agent_id="agent-a", cmd=cmd, cwd="/tmp", env={})
    written = []

    async def fake_write(data):
        written.append(data)

    monkeypatch.setattr(session, "is_alive", lambda: True)
    monkeypatch.setattr(session, "write", fake_write)

    result = await session.interrupt()

    assert written == [expected_sequence]
    assert result["interrupted"] is True
    assert result["sequence"] == expected_label
