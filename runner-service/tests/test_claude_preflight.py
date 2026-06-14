"""Auth preflight for terminal task injection (claude-code).

`interactive_preflight_auth` gates a workflow-injected prompt: when the agent/
owner has no usable OAuth token the CLI would sit at a `/login` screen and
silently swallow the paste, so the route latches the returned message and the
API fails the task. It must surface the `_ensure_auth` gate's error message and
return None when a token is available.
"""
import asyncio
import os
import sys
from pathlib import Path

import pytest

# The claude-code backend imports claude_interactive → pty → termios, which
# only exist on POSIX. Skip BEFORE touching RUNNER_TYPE so a Windows dev box
# doesn't poison the shared backend singleton for the rest of the suite.
if os.name == "nt":
    pytest.skip("claude_code backend imports POSIX pty/termios", allow_module_level=True)

os.environ.setdefault("RUNNER_TYPE", "claude-code")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import backends.claude_code as cc  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


async def _fake_user(agent_id, owner_id=None):
    return {"username": "agent_x", "owner_id": owner_id, "home": "/tmp/agent_x"}


def test_preflight_returns_error_when_no_token(monkeypatch):
    backend = cc.ClaudeCodeBackend()

    async def _gate(agent_user, agent_id):
        return {
            "status": "auth_required",
            "output": "",
            "error": "No authentication token available. Please authenticate: https://x",
        }

    monkeypatch.setattr(cc, "ensure_agent_user", _fake_user)
    monkeypatch.setattr(backend, "_ensure_auth", _gate)

    err = _run(backend.interactive_preflight_auth("agent-1", owner_id="owner-1"))
    assert err and "authenticate" in err.lower()


def test_preflight_returns_none_when_authenticated(monkeypatch):
    backend = cc.ClaudeCodeBackend()

    async def _ok(agent_user, agent_id):
        return None

    monkeypatch.setattr(cc, "ensure_agent_user", _fake_user)
    monkeypatch.setattr(backend, "_ensure_auth", _ok)

    assert _run(backend.interactive_preflight_auth("agent-1", owner_id="owner-1")) is None


def test_base_backend_preflight_defaults_to_none():
    from backends.base import RunnerBackend

    assert _run(RunnerBackend().interactive_preflight_auth("agent-1", owner_id="o")) is None
