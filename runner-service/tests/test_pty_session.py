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

import pty_session as pty_session_module  # noqa: E402
from pty_session import PtySession  # noqa: E402


@pytest.mark.parametrize("old_cwd,replace", [("/repo/a", False), ("/repo/b", True)])
def test_tmux_reattach_checks_project_after_runner_restart(monkeypatch, old_cwd, replace):
    from subprocess import CompletedProcess
    session = PtySession(agent_id="repo-test", cmd=["codex"], cwd="/repo/a", env={})
    calls = []

    def tmux(args, **kwargs):
        calls.append(args)
        return CompletedProcess(args, 0, stdout=old_cwd.encode(), stderr=b"")

    monkeypatch.setattr(session, "_tmux_run", tmux)
    session._ensure_tmux_session()
    assert any(c[0] == "kill-session" for c in calls) == replace
    assert any(c[0] == "new-session" for c in calls) == replace
    if replace:
        create = next(c for c in calls if c[0] == "new-session")
        assert create[create.index("-c") + 1] == "/repo/a"


@pytest.mark.asyncio
async def test_terminal_creation_waits_for_project_transition(monkeypatch):
    import pty_session
    from agent_user import _get_project_lock
    from unittest.mock import AsyncMock

    agent_id = "transition-test"
    factory = AsyncMock(return_value={"cmd": ["codex"], "cwd": "/repo/b", "env": {}})
    monkeypatch.setattr(PtySession, "start", AsyncMock())
    monkeypatch.setattr(pty_session, "_SESSIONS", {})
    async with _get_project_lock(agent_id):
        pending = asyncio.create_task(pty_session.get_or_create_session(agent_id, factory))
        await asyncio.sleep(0)
        factory.assert_not_awaited()
    session = await pending
    assert session.cwd == "/repo/b"


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


def test_auto_answers_codex_trust_directory_prompt(monkeypatch):
    session = PtySession(agent_id="agent-a", cmd=["codex"], cwd="/tmp", env={})
    session.master_fd = 1
    written = []

    monkeypatch.setattr(session, "_write_keystroke", lambda data: written.append(data))

    session._maybe_auto_answer_startup_prompt(
        b"""
        You are in /app/data/agents/agent_x/projects/gvinsot/PulsarTeam

        Do you trust the contents of this directory?
        Working with untrusted contents comes with higher risk of prompt injection.
        Trusting the directory allows project-local config, hooks, and exec policies to load.

        \xe2\x80\xba 1. Yes, continue
          2. No, quit

        Press enter to continue
        """
    )

    assert written == [b"\r"]
    # Trust dialogs can render before the CLI reads stdin. The screen-derived
    # recipe must remain retryable if the first Enter was swallowed.
    assert "trust" not in session._auto_answered
    assert session._auto_answer_attempts["trust"] == 1


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


def _detect(data: bytes):
    session = PtySession(agent_id="agent-a", cmd=["claude"], cwd="/tmp", env={})
    session._maybe_detect_auth_error(data)
    return session.auth_error


@pytest.mark.parametrize("blob", [
    b"Please run /login to continue",
    b"Invalid API key",
    b"OAuth token has expired",
    b"Invalid authentication credentials",
])
def test_detects_real_cli_auth_sentinels(blob):
    assert _detect(blob) is not None


def test_bare_authentication_error_without_401_does_not_latch():
    # The agent's OWN output / a tool result mentioning the API error type must
    # NOT spuriously fail the task and demand re-authentication.
    assert _detect(b'the API returns {"type":"authentication_error"} on bad keys') is None
    assert _detect(b"grep -rn authentication_error src/") is None


def test_authentication_error_with_401_latches():
    # A genuine CLI auth failure prints the type alongside an HTTP 401.
    assert _detect(b'API error 401: {"type":"authentication_error","message":"..."}') is not None


def test_401_alone_without_authentication_error_does_not_latch():
    # A 401 from some unrelated HTTP call the agent made is not an auth failure.
    assert _detect(b"HTTP/1.1 401 Unauthorized from https://example.com/api") is None


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
    monkeypatch.setattr(session, "_write_input", fake_write)

    result = await session.interrupt()

    assert written == [expected_sequence]
    assert result["interrupted"] is True
    assert result["sequence"] == expected_label


# ── Execution-scoped, credential-free history capture ───────────────────────
#
# The PTY (and its tmux pane) is shared by every task an agent runs, so a
# capture that is not bounded to the current execution copies the previous
# ticket's output — and whatever a /login screen printed — into an unrelated
# task's history. Every value below is synthetic.


def _tmux_pane(session, monkeypatch, screens):
    """Stub `capture-pane` with successive rendered pane contents."""
    from subprocess import CompletedProcess
    calls = []
    pending = list(screens)

    def tmux(args, **kwargs):
        calls.append(args)
        text = pending.pop(0) if len(pending) > 1 else pending[0]
        return CompletedProcess(args, 0, stdout=text.encode())

    session._tmux_session = f"agent-{session.agent_id}"
    monkeypatch.setattr(session, "_tmux_run", tmux)
    return calls


def test_history_output_uses_readable_tmux_pane_and_bounds_lines(monkeypatch):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    calls = _tmux_pane(session, monkeypatch, ["", "\n".join(f"line {i}" for i in range(150))])
    session.begin_history_capture()

    lines = session.history_output().splitlines()
    assert len(lines) == pty_session_module.HISTORY_MAX_LINES
    assert lines[-1] == "line 149"
    assert calls[-1] == [
        "capture-pane", "-p", "-J", "-t", "agent-history",
        "-S", f"-{pty_session_module.HISTORY_MAX_LINES}",
    ]


def test_history_output_excludes_the_previous_tasks_output(monkeypatch):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    previous = "Task PREV-1: refactored the billing module\nsecret-plan for customer X"
    _tmux_pane(session, monkeypatch, [previous, f"{previous}\nTask NOW-2: tests pass"])
    session.begin_history_capture()

    output = session.history_output()
    assert output == "Task NOW-2: tests pass"
    assert "PREV-1" not in output and "secret-plan" not in output


def test_history_output_is_omitted_when_no_execution_window_was_opened():
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session._append_scrollback(b"leftover output from the previous task\n")
    assert session.history_output() == pty_session_module.HISTORY_UNSCOPED_NOTICE


def test_history_output_falls_back_to_bytes_produced_after_the_mark(monkeypatch):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session._append_scrollback(b"previous task: deployed to staging\r\n")

    def unavailable(*args, **kwargs):
        raise OSError("tmux gone")

    session._tmux_session = "agent-history"
    monkeypatch.setattr(session, "_tmux_run", unavailable)
    session.begin_history_capture()
    session._append_scrollback(b"\x1b[32mTests passed\x1b[0m\r\nChanges pushed\x07")

    assert session.history_output() == "Tests passed\nChanges pushed"


def test_history_output_fallback_survives_scrollback_eviction(monkeypatch):
    monkeypatch.setattr(pty_session_module, "SCROLLBACK_BYTES", 64)
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session._append_scrollback(b"previous task line\n" * 4)
    session.begin_history_capture()
    session._append_scrollback(b"current run line\n" * 8)

    output = session.history_output()
    assert "previous task line" not in output
    assert output.splitlines()[-1] == "current run line"


def test_history_output_bounds_characters_and_reports_empty_runs():
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session.begin_history_capture()
    assert session.history_output() == pty_session_module.HISTORY_EMPTY_NOTICE
    session._append_scrollback(b"x" * 20000)
    assert session.history_output() == "x" * pty_session_module.HISTORY_MAX_CHARS


def test_history_output_redacts_credentials(monkeypatch):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    _tmux_pane(session, monkeypatch, [
        "",
        "Login failed\n"
        "Authorization: Bearer abcdef1234567890SYNTHETIC\n"
        "Open https://example.invalid/device?user_code=WXYZ-1234&state=abc to continue\n"
        "GITHUB_TOKEN=ghp_0000000000000000000000000000SYNTH",
    ])
    session.begin_history_capture()

    output = session.history_output()
    assert "abcdef1234567890SYNTHETIC" not in output
    assert "WXYZ-1234" not in output
    assert "ghp_0000000000000000000000000000SYNTH" not in output
    assert "Login failed" in output
    assert "https://example.invalid/device?user_code=[redacted]" in output


def test_latched_auth_errors_are_redacted():
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session.set_auth_error("Invalid API key sk-ant-SYNTHETICKEY0123456789 — run /login")
    assert "SYNTHETICKEY" not in session.auth_error
    assert "run /login" in session.auth_error
