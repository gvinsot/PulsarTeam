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
    assert any("new-session" in c for c in calls) == replace
    if replace:
        create = next(c for c in calls if "new-session" in c)
        assert create[create.index("-c") + 1] == "/repo/a"
        # history-limit must be set in the SAME command list, before the
        # window exists, or the new pane keeps tmux's 2000-line default.
        assert create.index("history-limit") < create.index("new-session")
    # Either way the browser's xterm must stay off the alternate screen.
    assert any("terminal-overrides[90]" in c for c in calls)


def test_history_snapshot_pushes_pane_history_into_scrollback(monkeypatch):
    from subprocess import CompletedProcess
    session = PtySession(agent_id="hist", cmd=["codex"], cwd="/tmp", env={}, cols=80, rows=3)
    session._tmux_session = "pulsar-hist"
    seen = []

    def tmux(args, **kwargs):
        seen.append(args)
        return CompletedProcess(args, 0, stdout=b"\x1b[31mone\nTwo\n\n\n", stderr=b"")

    monkeypatch.setattr(session, "_tmux_run", tmux)
    out = session.history_snapshot(100)
    assert seen[0][seen[0].index("-S") + 1] == "-100"
    assert seen[0][seen[0].index("-E") + 1] == "-1"
    # Trailing blank lines dropped, SGR closed per line, then `rows` CRLFs.
    assert out == b"\x1b[31mone\x1b[0m\r\nTwo\x1b[0m\r\n" + b"\r\n" * 3


def test_history_snapshot_is_empty_on_failure(monkeypatch):
    from subprocess import CompletedProcess
    session = PtySession(agent_id="hist2", cmd=["codex"], cwd="/tmp", env={})
    session._tmux_session = "pulsar-hist2"
    monkeypatch.setattr(session, "_tmux_run", lambda args: CompletedProcess(args, 1, b"", b"x"))
    assert session.history_snapshot() == b""


@pytest.mark.asyncio
async def test_resize_broadcasts_authoritative_size_to_viewers():
    session = PtySession(agent_id="size", cmd=["codex"], cwd="/tmp", env={})
    frames = []

    async def ctrl(frame):
        frames.append(frame)

    async def out(_data):
        pass

    session._clients[1] = pty_session_module._Client(on_output=out, on_control=ctrl)
    session._clients[2] = pty_session_module._Client(on_output=out)  # no control channel
    await session.resize(9999, 3)
    # Clamped values are what viewers must render at.
    assert frames == [{"type": "size", "cols": 500, "rows": 5}]


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


def test_auth_detector_ignores_the_production_source_diff():
    diff = ('359 +    session.set_auth_error("Invalid API key '
            'sk-ant-SYNTHETICKEY0123456789 — run /login")      '
            '360 +    assert "SYNTHETICKEY" not in session.auth_error')
    assert _detect(diff.encode()) is None


def test_auth_detector_keeps_source_context_across_chunks():
    session = PtySession(agent_id="agent-a", cmd=["claude"], cwd="/tmp", env={})
    session._auto_answer_buf.extend(b'359 + session.set_auth_error("')
    session._maybe_detect_auth_error(b'Invalid API key")')
    assert session.auth_error is None


def test_auth_detector_keeps_real_banner_across_chunks():
    session = PtySession(agent_id="agent-a", cmd=["claude"], cwd="/tmp", env={})
    session._auto_answer_buf.extend(b'\x1b[31m  Error: Invalid API ')
    session._maybe_detect_auth_error(b'key\x1b[0m')
    assert session.auth_error == "Error: Invalid API key"


def test_auth_detector_does_not_turn_a_truncated_source_line_into_a_banner():
    text = 'source = "' + 'x' * 100 + 'Invalid API key' + 'x' * (4096 - len('Invalid API key'))
    assert _detect(text.encode()) is None


def test_auth_detector_captures_diagnostic_instead_of_later_source():
    text = b'Invalid API key\n359 + session.set_auth_error("Please run /login")'
    assert _detect(text) == "Invalid API key"


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


def test_pane_capture_distinguishes_empty_success_from_failure(monkeypatch):
    from subprocess import CompletedProcess
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    assert session._pane_lines(10) is None
    session._tmux_session = "agent-history"
    monkeypatch.setattr(session, "_tmux_run", lambda args: CompletedProcess(args, 0, b"", b""))
    assert session._pane_lines(10) == []
    monkeypatch.setattr(session, "_tmux_run", lambda args: CompletedProcess(args, 1, b"", b""))
    assert session._pane_lines(10) is None


@pytest.mark.parametrize("failure", ["exception", "nonzero"])
def test_failed_initial_capture_never_reuses_recovered_shared_pane(monkeypatch, failure):
    from subprocess import CompletedProcess
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    previous = b"PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL"
    calls = []
    def tmux(args):
        calls.append(args)
        if len(calls) == 1:
            if failure == "exception":
                raise OSError("synthetic initial failure")
            # Even stdout on a failed command is not an initial baseline.
            return CompletedProcess(args, 1, previous, b"failed")
        return CompletedProcess(args, 0, previous, b"")
    session._tmux_session = "agent-history"
    monkeypatch.setattr(session, "_tmux_run", tmux)
    session.begin_history_capture()
    assert session._history_capture_state is pty_session_module.HistoryCaptureState.BASELINE_FAILED
    # Demonstrate tmux recovery without a single new byte from this execution.
    assert session._pane_lines(10) == [previous.decode()]
    for _ in range(2):
        assert session.history_output() == pty_session_module.HISTORY_BASELINE_FAILED_NOTICE
    assert len(calls) == 2, "history must not consult the shared pane again"
    assert previous.decode() not in session.history_output()


@pytest.mark.parametrize("baseline,repaint", [
    ("PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL", "PREVIOUS_TASK_SYNTHETIC_\nCONFIDENTIAL"),
    ("PREVIOUS_TASK_SYNTHETIC_\nCONFIDENTIAL", "PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL"),
    ("old screen", "PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL moved back into view"),
    ("", "PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL"),
])
def test_successful_baseline_cannot_prove_provenance_after_repaint_or_reflow(monkeypatch, baseline, repaint):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    calls = _tmux_pane(session, monkeypatch, [baseline, repaint])
    session.begin_history_capture()
    assert session._history_capture_state is pty_session_module.HistoryCaptureState.SHARED_PANE_UNVERIFIED
    # Redraws arrive AFTER the mark, but their contents belong to the old task.
    session._append_scrollback(repaint.encode())
    assert session._pane_lines(10) == repaint.splitlines()
    output = session.history_output()
    assert output == pty_session_module.HISTORY_UNVERIFIED_NOTICE
    assert "SYNTHETIC" not in output
    assert len(calls) == 2


def test_history_output_is_omitted_when_no_execution_window_was_opened():
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session._append_scrollback(b"leftover output from the previous task\n")
    assert session.history_output() == pty_session_module.HISTORY_UNSCOPED_NOTICE


def test_raw_pty_bytes_after_failed_baseline_are_not_a_trusted_fallback(monkeypatch):
    monkeypatch.setattr(pty_session_module, "SCROLLBACK_BYTES", 64)
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session.begin_history_capture()  # no tmux, so no successful baseline
    session._append_scrollback(b"old bytes\n" * 10)
    session._append_scrollback(b"PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL repainted\n")
    assert session.history_output() == pty_session_module.HISTORY_BASELINE_FAILED_NOTICE


def test_new_capture_records_its_own_state_without_resetting_the_session(monkeypatch):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session.begin_history_capture()
    assert session.history_output() == pty_session_module.HISTORY_BASELINE_FAILED_NOTICE
    session._append_scrollback(b"existing administrator terminal content")
    calls = _tmux_pane(session, monkeypatch, [""])
    session.begin_history_capture()
    assert session.history_output() == pty_session_module.HISTORY_UNVERIFIED_NOTICE
    assert b"".join(session.scrollback) == b"existing administrator terminal content"
    assert not session._closed
    assert all(call[0] == "capture-pane" for call in calls)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["exception", "nonzero", "reflow"])
async def test_output_http_response_never_exports_an_old_ticket(monkeypatch, failure):
    from subprocess import CompletedProcess
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    import routes_terminal
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session._tmux_session = "agent-history"
    previous = "PREVIOUS_TASK_SYNTHETIC_CONFIDENTIAL"
    calls = []
    def tmux(args):
        calls.append(args)
        if len(calls) == 1:
            if failure == "exception":
                raise OSError("synthetic initial failure")
            if failure == "nonzero":
                return CompletedProcess(args, 1, b"", b"failed")
            return CompletedProcess(args, 0, b"PREVIOUS_TASK_SYNTHETIC_\nCONFIDENTIAL", b"")
        return CompletedProcess(args, 0, previous.encode(), b"")
    monkeypatch.setattr(session, "_tmux_run", tmux)
    session.begin_history_capture()
    session._append_scrollback(previous.encode())
    monkeypatch.setattr(routes_terminal, "API_KEY", "test-only")
    monkeypatch.setattr(routes_terminal.pty_session, "get_session", lambda agent_id: session)
    app = FastAPI()
    app.include_router(routes_terminal.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
        response = await client.get("/terminal/sessions/history/output", headers={"Authorization": "Bearer test-only"})
    assert response.status_code == 200
    assert previous not in response.text
    assert response.json()["output"] == session.history_output()
    assert "capture omitted" in response.json()["output"]
    assert len(calls) == 1


def test_latched_auth_errors_are_redacted():
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session.set_auth_error("Invalid API key sk-ant-SYNTHETICKEY0123456789 — run /login")
    assert "SYNTHETICKEY" not in session.auth_error
    assert "run /login" in session.auth_error


@pytest.mark.parametrize(
    "line,leak",
    [
        # The terminal capture no longer leaves the runner, but a latched auth
        # error still does — the API copies it into task errors and history. It
        # is scraped off a login screen, so it carries exactly the quoted
        # assignments the filter used to only half-mask. Values are synthetic.
        ("Invalid API key: API_TOKEN='SYNTHETIC_VALUE_123456' rejected", "SYNTHETIC_VALUE_123456"),
        ('Invalid API key {"password": "SYNTHETIC FIRST SECOND"}', "SECOND"),
    ],
)
def test_latched_auth_errors_mask_quoted_values_whole(line, leak):
    session = PtySession(agent_id="history", cmd=["codex"], cwd="/tmp", env={})
    session.set_auth_error(line)
    assert leak not in session.auth_error
    assert "[redacted]" in session.auth_error


# ── Credential mirroring past the session's death ───────────────────────────
#
# close() kills the tmux session, but that kill is best-effort: against a busy
# tmux server it can time out and leave the CLI running. An orphaned CLI still
# refreshes its OAuth token in the background, and for codex that refresh
# ROTATES the refresh_token — a rotation nobody mirrors back leaves the store
# serving a token OpenAI has already revoked.


def _creds_session(tmp_path, blob, pushed):
    import json
    from subprocess import CompletedProcess

    path = tmp_path / "auth.json"
    path.write_text(json.dumps(blob), encoding="utf-8")
    session = PtySession(
        agent_id="creds-agent",
        cmd=["codex"],
        cwd=str(tmp_path),
        env={},
        creds_watch_path=str(path),
        creds_on_change=pushed.append,
        creds_dedup_key=lambda b: (b.get("tokens") or {}).get("access_token"),
    )
    session._tmux_session = "pt-creds-agent"
    session._creds_watcher.capture_baseline()
    return session, path, CompletedProcess


def _rewrite(path, blob):
    """Write `blob` with a definitely-newer mtime (the watcher is mtime-gated
    and a test writes both copies within the same filesystem tick)."""
    import json

    path.write_text(json.dumps(blob), encoding="utf-8")
    stamp = os.path.getmtime(path) + 2
    os.utime(path, (stamp, stamp))


@pytest.mark.asyncio
async def test_close_keeps_mirroring_when_the_cli_outlived_the_session(tmp_path, monkeypatch):
    pushed = []
    session, path, CompletedProcess = _creds_session(
        tmp_path, {"tokens": {"access_token": "at-1", "refresh_token": "rt-1"}}, pushed
    )
    # kill-session didn't take: has-session still reports the CLI alive.
    monkeypatch.setattr(session, "_tmux_run",
                        lambda args, **kw: CompletedProcess(args, 0, stdout=b"", stderr=b""))
    monkeypatch.setattr(pty_session_module, "DETACHED_CREDS_SYNC_INTERVAL_SEC", 0.01)

    await session.close()
    assert "creds-agent" in pty_session_module._DETACHED_CREDS_WATCHERS
    assert pushed == []  # nothing changed yet — the final sync is a no-op

    # The orphaned CLI refreshes its token with no session left to watch it.
    rotated = {"tokens": {"access_token": "at-2", "refresh_token": "rt-2"}}
    _rewrite(path, rotated)
    for _ in range(50):
        await asyncio.sleep(0.02)
        if pushed:
            break

    assert pushed == [rotated]
    pty_session_module.cancel_detached_creds_watcher("creds-agent")


@pytest.mark.asyncio
async def test_close_detaches_nothing_when_the_tmux_session_is_gone(tmp_path, monkeypatch):
    pushed = []
    session, _path, CompletedProcess = _creds_session(
        tmp_path, {"tokens": {"access_token": "at-1"}}, pushed
    )
    # kill-session worked: has-session now fails.
    monkeypatch.setattr(session, "_tmux_run",
                        lambda args, **kw: CompletedProcess(args, 1, stdout=b"", stderr=b""))

    await session.close()

    assert "creds-agent" not in pty_session_module._DETACHED_CREDS_WATCHERS
