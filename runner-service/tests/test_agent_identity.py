"""Agent launches never honor legacy root grants or degrade to the server UID."""
import asyncio
import os
import subprocess
import sys
from pathlib import Path

import pytest

os.environ.setdefault("RUNNER_TYPE", "hermes")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import agent_user
from backends.claude_code import ClaudeCodeBackend
from backends.claude_token_store import get_subprocess_kwargs
from backends.codex import CodexBackend
from backends.hermes import HermesBackend


@pytest.mark.parametrize("backend_class", [ClaudeCodeBackend, CodexBackend, HermesBackend])
@pytest.mark.parametrize("legacy_grant", [True, False])
def test_legacy_permission_cannot_disable_isolation(backend_class, legacy_grant):
    backend = backend_class()
    backend.set_agent_permissions("agent", {"linuxUser": {"runAsRoot": legacy_grant}})
    user = {"uid": 20001, "gid": 20001, "home": "/tmp/agent"}
    assert backend._resolve_effective_user("agent", user) is user
    assert callable(get_subprocess_kwargs(user)["preexec_fn"])


@pytest.mark.parametrize("backend_class", [ClaudeCodeBackend, CodexBackend, HermesBackend])
def test_agent_cannot_inherit_server_identity(backend_class):
    with pytest.raises(RuntimeError, match="non-root UID and GID"):
        backend_class()._resolve_effective_user("agent", None)


@pytest.mark.parametrize("user", [{}, {"uid": 0}, {"uid": 20001, "gid": 0}, {"uid": None}, {"uid": -1}])
def test_subprocess_rejects_invalid_agent_identity(user):
    with pytest.raises(RuntimeError, match="non-root UID and GID"):
        get_subprocess_kwargs(user)


def test_home_preparation_failure_does_not_fall_back_to_root(tmp_path, monkeypatch):
    monkeypatch.setattr(agent_user, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(agent_user, "_agent_users", {})
    monkeypatch.setattr(agent_user, "_agent_user_lock", None)
    monkeypatch.setattr(agent_user.os.path, "expanduser", lambda _: str(tmp_path / "server"))

    def denied(*args):
        raise PermissionError("chown denied")

    monkeypatch.setattr(agent_user.os, "lchown", denied)
    with pytest.raises(RuntimeError, match="Failed to initialize isolated user"):
        asyncio.run(agent_user.ensure_agent_user("agent-failed"))
    assert "agent-failed" not in agent_user._agent_users


def test_child_process_runs_with_non_root_uid_and_gid():
    uid = 20001 if os.getuid() == 0 else os.getuid()
    gid = 20001 if os.getuid() == 0 else os.getgid()
    result = subprocess.run(
        ["/usr/bin/id"], capture_output=True, text=True, check=True,
        **get_subprocess_kwargs({"uid": uid, "gid": gid}),
    )
    assert f"uid={uid}" in result.stdout
    assert f"gid={gid}" in result.stdout
    assert "root" not in result.stdout


def test_privilege_drop_sets_groups_before_uid(monkeypatch):
    calls = []
    monkeypatch.setattr(os, "getuid", lambda: 0)
    for name in ("setgroups", "setgid", "setuid"):
        monkeypatch.setattr(os, name, lambda value, name=name: calls.append((name, value)))
    get_subprocess_kwargs({"uid": 20001, "gid": 20001})["preexec_fn"]()
    assert calls == [("setgroups", [20001]), ("setgid", 20001), ("setuid", 20001)]
