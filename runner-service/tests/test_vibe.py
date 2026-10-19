import json
import os
import sys
from pathlib import Path


os.environ["RUNNER_TYPE"] = "vibe"
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from backends import vibe as vibe_mod
from backends.runner_mcp_config import to_vibe_mcp
from backends.vibe import VibeBackend


def test_to_vibe_mcp_maps_http_servers_with_static_auth():
    out = to_vibe_mcp({
        "pulsar-gateway": {"type": "http", "url": "http://gw/mcp", "headers": {"Authorization": "Bearer t"}},
        "no-url": {"type": "http"},
        "bad": "x",
    })
    assert out == [{
        "name": "pulsar-gateway",
        "transport": "streamable-http",
        "url": "http://gw/mcp",
        "auth": {"type": "static", "headers": {"Authorization": "Bearer t"}},
    }]


def test_build_command_trusts_cwd_and_passes_prompt_safely():
    backend = VibeBackend()
    cmd = backend._build_command("-rf please", True, None, "agent", None, None)
    assert cmd == ["vibe", "--trust", "--auto-approve", "--output", "streaming", "--prompt=-rf please"]
    sync = backend._build_command("hi", False, None, "agent", None, None)
    assert "--output" not in sync


def test_permissions_toggle_drops_auto_approve():
    backend = VibeBackend()
    perms = {"execution": {"dangerousSkipPermissions": False}}
    assert backend._interactive_cmd("agent", perms) == ["vibe", "--trust"]


def test_agent_env_carries_mcp_and_permissions(monkeypatch):
    backend = VibeBackend()
    monkeypatch.setattr(vibe_mod, "fetch_vibe_mcp_servers", lambda _id: [{"name": "x"}])
    backend._configure_mcp(None, "agent")
    monkeypatch.setattr(backend, "_get_llm_config", lambda _id: None)
    env = backend._agent_env({"home": "/nonexistent"}, "agent")
    assert json.loads(env["VIBE_MCP_SERVERS"]) == [{"name": "x"}]
    assert env["VIBE_BYPASS_TOOL_PERMISSIONS"] == "true"
    assert env["VIBE_ENABLE_AUTO_UPDATE"] == "false"


def test_failed_mcp_fetch_keeps_last_known_servers(monkeypatch):
    backend = VibeBackend()
    monkeypatch.setattr(vibe_mod, "fetch_vibe_mcp_servers", lambda _id: [{"name": "x"}])
    backend._configure_mcp(None, "agent")
    monkeypatch.setattr(vibe_mod, "fetch_vibe_mcp_servers", lambda _id: None)
    backend._configure_mcp(None, "agent")
    assert json.loads(backend._mcp_env["agent"]) == [{"name": "x"}]


def test_service_key_does_not_shadow_terminal_saved_key(tmp_path, monkeypatch):
    backend = VibeBackend()
    monkeypatch.setattr(backend, "_get_llm_config", lambda _id: None)
    monkeypatch.setenv("MISTRAL_API_KEY", "service-key")
    assert backend._agent_env({"home": str(tmp_path)}, "agent")["MISTRAL_API_KEY"] == "service-key"
    (tmp_path / ".vibe").mkdir()
    (tmp_path / ".vibe" / ".env").write_text("MISTRAL_API_KEY=user-key\n")
    assert "MISTRAL_API_KEY" not in backend._agent_env({"home": str(tmp_path)}, "agent")


def test_stream_parser_maps_history_entries():
    backend = VibeBackend()
    msg = {"type": "message", "role": "assistant", "content": [{"type": "text", "text": "done"}]}
    assert backend._parse_stream_event(json.dumps(msg)) == {"type": "text", "content": "done"}
    user = {"type": "message", "role": "user", "content": [{"type": "text", "text": "q"}]}
    assert backend._parse_stream_event(json.dumps(user)) is None
    assert backend._parse_stream_event('{"type":"reasoning","text":"hmm"}') == {"type": "thinking", "content": "hmm"}
    assert backend._parse_stream_event('{"type":"effect","title":"bash"}')["type"] == "status"
    assert backend._parse_stream_event('{"type":"notice","level":"error","message":"x"}') == {"type": "error", "content": "x"}


def test_sync_result_is_plain_text():
    assert VibeBackend()._parse_sync_result('{"a": 1}') == {"status": "success", "output": '{"a": 1}'}
