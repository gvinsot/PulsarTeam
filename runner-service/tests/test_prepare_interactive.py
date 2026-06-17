"""Recipe-shape tests for the CLI backends' prepare_interactive.

These pin the spawn-recipe contract consumed by pty_session
(cmd/cwd/env/preexec_fn + per-backend extras such as hermes'
files_watch_paths and codex's creds_watch_path) so the shared
prepare_interactive template can be refactored safely.
"""

import asyncio
import os
import sys
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "hermes")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_user import _agent_users  # noqa: E402
import backends.cli_backend as cli_backend_module  # noqa: E402


def _noop_configure(agent_user, agent_id):
    return None


async def _no_agent_user(agent_id, owner_id=None):
    return None


def _prepare(backend_module, backend, agent_id, tmp_path, monkeypatch):
    """Run prepare_interactive with agent-user provisioning stubbed out:
    ensure_agent_user returns None (as under linuxUser.runAsRoot) and the
    agent HOME comes from the _agent_users cache, like the _agent_env tests
    in the sibling suites."""
    for mod in {backend_module, cli_backend_module}:
        if hasattr(mod, "ensure_agent_user"):
            monkeypatch.setattr(mod, "ensure_agent_user", _no_agent_user)
    backend._configure_mcp = _noop_configure
    backend._configure_instructions = _noop_configure
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": None, "gid": None}
    try:
        return asyncio.run(backend.prepare_interactive(agent_id))
    finally:
        _agent_users.pop(agent_id, None)


def test_opencode_recipe_shape(tmp_path, monkeypatch):
    import backends.opencode as opencode_module

    backend = opencode_module.OpenCodeBackend()
    backend.set_agent_llm_config("agent-oc", {"provider": "vllm", "model": "qwen"})

    recipe = _prepare(opencode_module, backend, "agent-oc", tmp_path, monkeypatch)

    assert recipe["cmd"][0] == "opencode"
    assert recipe["cmd"][recipe["cmd"].index("--model") + 1] == "vllm/qwen"
    assert isinstance(recipe["cwd"], str) and recipe["cwd"]
    assert recipe["env"]["HOME"] == str(tmp_path)
    assert recipe["preexec_fn"] is None


def test_openclaw_recipe_shape(tmp_path, monkeypatch):
    import backends.openclaw as openclaw_module

    backend = openclaw_module.OpenClawBackend()

    recipe = _prepare(openclaw_module, backend, "agent-claw", tmp_path, monkeypatch)

    assert recipe["cmd"][:2] == ["openclaw", "tui"]
    assert "--local" in recipe["cmd"]  # OPENCLAW_LOCAL defaults to true
    assert isinstance(recipe["cwd"], str) and recipe["cwd"]
    assert recipe["env"]["HOME"] == str(tmp_path)
    assert recipe["preexec_fn"] is None


def test_hermes_recipe_includes_files_watch(tmp_path, monkeypatch):
    import backends.hermes as hermes_module

    backend = hermes_module.HermesBackend()

    recipe = _prepare(hermes_module, backend, "agent-hermes", tmp_path, monkeypatch)

    assert recipe["cmd"][:2] == ["hermes", "chat"]
    assert "--yolo" in recipe["cmd"]  # dangerousSkipPermissions defaults on
    assert isinstance(recipe["cwd"], str) and recipe["cwd"]
    assert recipe["preexec_fn"] is None
    assert recipe["files_watch_paths"] == [
        os.path.join(str(tmp_path), ".hermes", "config.yaml"),
        os.path.join(str(tmp_path), ".hermes", ".env"),
    ]
    assert callable(recipe["files_on_change"])


def test_aider_recipe_shape(tmp_path, monkeypatch):
    import backends.aider as aider_module

    backend = aider_module.AiderBackend()
    backend.set_agent_llm_config("agent-aider", {"provider": "openai", "model": "gpt-4o"})

    recipe = _prepare(aider_module, backend, "agent-aider", tmp_path, monkeypatch)

    assert recipe["cmd"][0] == "aider"
    assert recipe["cmd"][recipe["cmd"].index("--model") + 1] == "openai/gpt-4o"
    assert "--yes-always" in recipe["cmd"]
    assert isinstance(recipe["cwd"], str) and recipe["cwd"]
    assert recipe["preexec_fn"] is None


def test_codex_recipe_includes_creds_watch(tmp_path, monkeypatch):
    import backends.codex as codex_module

    backend = codex_module.CodexBackend()

    recipe = _prepare(codex_module, backend, "agent-codex", tmp_path, monkeypatch)

    assert recipe["cmd"][0] == "codex"
    assert "--dangerously-bypass-approvals-and-sandbox" in recipe["cmd"]
    assert isinstance(recipe["cwd"], str) and recipe["cwd"]
    assert recipe["preexec_fn"] is None
    assert recipe["creds_watch_path"].endswith("auth.json")
    assert callable(recipe["creds_on_change"])
    assert callable(recipe["creds_dedup_key"])


def test_claude_recipe_refreshes_auth_before_spawning(tmp_path, monkeypatch):
    import backends.claude_code as claude_module

    agent_user = {
        "username": "agent_claude",
        "owner_id": "owner-1",
        "home": str(tmp_path),
        "uid": None,
        "gid": None,
    }
    calls = []

    async def _fake_user(agent_id, owner_id=None):
        return agent_user

    async def _fake_gate(user, agent_id):
        calls.append((user, agent_id))
        return None

    backend = claude_module.ClaudeCodeBackend()
    monkeypatch.setattr(claude_module, "ensure_agent_user", _fake_user)
    monkeypatch.setattr(claude_module, "configure_claude_mcp", _noop_configure)
    monkeypatch.setattr(claude_module, "configure_claude_instructions", _noop_configure)
    monkeypatch.setattr(claude_module, "seed_credentials_file", lambda _user: True)
    monkeypatch.setattr(backend, "_ensure_auth", _fake_gate)

    recipe = asyncio.run(backend.prepare_interactive("agent-claude", owner_id="owner-1"))

    assert calls == [(agent_user, "agent-claude")]
    assert recipe["cmd"][0] == "claude"
    assert recipe["creds_watch_path"].endswith(os.path.join(".claude", ".credentials.json"))
    assert callable(recipe["creds_on_change"])
