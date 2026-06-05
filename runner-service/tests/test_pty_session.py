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
