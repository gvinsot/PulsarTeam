import json
import os
import sys
from pathlib import Path


os.environ["RUNNER_TYPE"] = "opencode"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_user import _agent_users
from backends.opencode import OpenCodeBackend, _merge_opencode_config, _resolve_opencode_model


def test_default_llm_does_not_pass_model_override():
    backend = OpenCodeBackend()

    assert _resolve_opencode_model(None) == ""
    assert "--model" not in backend._build_command("hello", True, None, "agent", None, None)
    assert "--dangerously-skip-permissions" not in backend._build_command("hello", True, None, "agent", None, None)


def test_explicit_llm_still_passes_provider_prefixed_model():
    backend = OpenCodeBackend()
    backend.set_agent_llm_config("agent", {"provider": "vllm", "model": "qwen"})

    cmd = backend._build_command("hello", True, None, "agent", None, None)

    assert cmd[cmd.index("--model") + 1] == "vllm/qwen"


def test_clear_model_preserves_other_opencode_settings():
    existing = json.dumps({
        "model": "anthropic/claude-sonnet-4-20250514",
        "mcp": {"github": {"type": "local"}},
        "provider": {"anthropic": {"models": {"claude-sonnet-4-20250514": {}}}},
        "__pulsarManagedMcpServers": ["old"],
        "_pulsarMcpUpdatedAt": 123,
    })

    merged = json.loads(_merge_opencode_config(existing, None, clear_model=True))

    assert "model" not in merged
    assert "__pulsarManagedMcpServers" not in merged
    assert "_pulsarMcpUpdatedAt" not in merged
    assert merged["mcp"] == {"github": {"type": "local"}}
    assert "anthropic" in merged["provider"]


def test_clear_model_does_not_create_empty_config():
    assert _merge_opencode_config(None, None, clear_model=True) is None


def test_default_llm_removes_previous_pin_from_agent_config(tmp_path):
    agent_id = "agent-with-stale-model"
    config_dir = tmp_path / ".config" / "opencode"
    config_dir.mkdir(parents=True)
    config_path = config_dir / "config.json"
    config_path.write_text(json.dumps({
        "model": "anthropic/claude-sonnet-4-20250514",
        "mcp": {"github": {"type": "local"}},
        "__pulsarManagedMcpServers": ["stale"],
        "_pulsarMcpUpdatedAt": 123,
    }))
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": None, "gid": None}

    try:
        env = OpenCodeBackend()._agent_env(None, agent_id)
    finally:
        _agent_users.pop(agent_id, None)

    config = json.loads(config_path.read_text())
    assert env["HOME"] == str(tmp_path)
    assert "model" not in config
    assert config["permission"] == "allow"
    assert "__pulsarManagedMcpServers" not in config
    assert "_pulsarMcpUpdatedAt" not in config
    assert config["mcp"] == {"github": {"type": "local"}}


def test_dangerous_permissions_write_allow_config_and_env(tmp_path):
    agent_id = "agent-dangerous"
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": None, "gid": None}

    try:
        env = OpenCodeBackend()._agent_env(None, agent_id)
    finally:
        _agent_users.pop(agent_id, None)

    config = json.loads((tmp_path / ".config" / "opencode" / "config.json").read_text())
    assert config["permission"] == "allow"
    assert env["OPENCODE_PERMISSION"] == '"allow"'
    sidecar = tmp_path / ".config" / "opencode" / ".pulsar-managed-permission.json"
    assert json.loads(sidecar.read_text()) == {"managed": True}


def test_disabling_dangerous_permissions_clears_pulsar_allow_override(tmp_path):
    agent_id = "agent-not-dangerous"
    config_dir = tmp_path / ".config" / "opencode"
    config_dir.mkdir(parents=True)
    (config_dir / "config.json").write_text(json.dumps({
        "permission": "allow",
        "mcp": {"github": {"type": "local"}},
    }))
    (config_dir / ".pulsar-managed-permission.json").write_text(json.dumps({"managed": True}))
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": None, "gid": None}
    backend = OpenCodeBackend()
    backend.set_agent_permissions(agent_id, {"execution": {"dangerousSkipPermissions": False}})

    try:
        env = backend._agent_env(None, agent_id)
    finally:
        _agent_users.pop(agent_id, None)

    config = json.loads((config_dir / "config.json").read_text())
    assert "permission" not in config
    assert "OPENCODE_PERMISSION" not in env
    assert not (config_dir / ".pulsar-managed-permission.json").exists()
