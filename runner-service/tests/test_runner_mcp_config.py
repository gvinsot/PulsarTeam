"""Tests for per-CLI MCP injection (runner_mcp_config + backend wiring).

Covers the pure translators (canonical team-api shape → each CLI's native
schema), the writers' idempotency / user-config preservation, the codex
managed-block strip/replace, and hermes' --ignore-user-config interaction.
"""

import json
import os
import sys
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "opencode")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import yaml  # noqa: E402
import backends.runner_mcp_config as rmc  # noqa: E402
from backends.runner_mcp_config import (  # noqa: E402
    to_opencode_mcp,
    to_openclaw_mcp,
    to_hermes_mcp,
    to_codex_mcp_toml,
    _strip_managed_block,
    _CODEX_MARK_START,
    _CODEX_MARK_END,
    configure_opencode_mcp,
    configure_codex_mcp,
    configure_hermes_mcp,
    configure_openclaw_mcp,
)


# Canonical shape returned by team-api (mcpManager.getClaudeMcpConfigForAgent).
CANONICAL = {
    "swarm-manager": {"type": "http", "url": "http://swarm:8000/ai/mcp"},
    "code-index": {
        "type": "http",
        "url": "https://api/code-index/mcp",
        "headers": {"Authorization": "Bearer tok"},
    },
}


def _patch_fetch(monkeypatch, payload):
    """Patch the team-api fetch. payload=None simulates an unreachable API."""
    monkeypatch.setattr(rmc, "_fetch_agent_mcp", lambda agent_id: payload)


def _agent(home):
    return {"home": str(home), "uid": None, "gid": None}


# ── Translators ────────────────────────────────────────────────────────────

def test_to_opencode_mcp_maps_http_to_remote():
    out = to_opencode_mcp(CANONICAL)
    assert out["swarm-manager"] == {
        "type": "remote",
        "url": "http://swarm:8000/ai/mcp",
        "enabled": True,
    }
    assert out["code-index"]["type"] == "remote"
    assert out["code-index"]["enabled"] is True
    assert out["code-index"]["headers"] == {"Authorization": "Bearer tok"}


def test_to_openclaw_uses_streamable_http():
    # openclaw 2026.5.27: HTTP servers stored as {url, transport, headers}.
    out = to_openclaw_mcp(CANONICAL)
    assert out["swarm-manager"] == {
        "url": "http://swarm:8000/ai/mcp",
        "transport": "streamable-http",
    }
    assert out["code-index"]["headers"] == {"Authorization": "Bearer tok"}


def test_to_hermes_uses_url_only_for_http():
    # hermes v0.15.0: an entry with `url` (and no transport) is HTTP/StreamableHTTP.
    out = to_hermes_mcp(CANONICAL)
    assert out["swarm-manager"] == {"url": "http://swarm:8000/ai/mcp"}
    assert "transport" not in out["swarm-manager"]
    assert out["code-index"]["headers"] == {"Authorization": "Bearer tok"}


def test_translators_skip_invalid_entries():
    bad = {
        "no_url": {"type": "http"},
        "not_dict": "nope",
        "empty_url": {"type": "http", "url": ""},
    }
    assert to_opencode_mcp(bad) == {}
    assert to_openclaw_mcp(bad) == {}
    assert to_hermes_mcp(bad) == {}
    assert to_codex_mcp_toml(bad) == ""


def test_translators_handle_none():
    assert to_opencode_mcp(None) == {}
    assert to_hermes_mcp(None) == {}
    assert to_codex_mcp_toml(None) == ""


# ── Codex TOML rendering ─────────────────────────────────────────────────────

def test_to_codex_mcp_toml_renders_tables():
    toml = to_codex_mcp_toml(CANONICAL)
    assert "[mcp_servers.swarm-manager]" in toml
    assert 'url = "http://swarm:8000/ai/mcp"' in toml
    assert "[mcp_servers.code-index]" in toml
    assert 'http_headers = { "Authorization" = "Bearer tok" }' in toml


def test_to_codex_quotes_non_bare_keys_and_escapes():
    servers = {"weird name": {"type": "http", "url": 'http://x/"q"'}}
    toml = to_codex_mcp_toml(servers)
    assert '[mcp_servers."weird name"]' in toml
    assert r'url = "http://x/\"q\""' in toml


def test_strip_managed_block_removes_region():
    text = (
        'model = "gpt"\n'
        f"{_CODEX_MARK_START}\n"
        '[mcp_servers.foo]\nurl = "u"\n'
        f"{_CODEX_MARK_END}\n"
        "other = true\n"
    )
    out = _strip_managed_block(text, _CODEX_MARK_START, _CODEX_MARK_END)
    assert "mcp_servers.foo" not in out
    assert 'model = "gpt"' in out
    assert "other = true" in out


def test_strip_managed_block_noop_without_markers():
    text = 'model = "gpt"\n'
    assert _strip_managed_block(text, _CODEX_MARK_START, _CODEX_MARK_END) == text


# ── opencode writer ──────────────────────────────────────────────────────────

def test_configure_opencode_preserves_user_config(tmp_path, monkeypatch):
    cfg = tmp_path / ".config" / "opencode" / "config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text(json.dumps({"model": "anthropic/x", "mcp": {"github": {"type": "local"}}}))
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})

    configure_opencode_mcp(_agent(tmp_path), "agent-1")

    data = json.loads(cfg.read_text())
    assert data["model"] == "anthropic/x"                 # untouched
    assert data["mcp"]["github"] == {"type": "local"}      # user MCP preserved
    assert data["mcp"]["swarm-manager"]["type"] == "remote"
    assert "__pulsarManagedMcpServers" not in data
    assert "_pulsarMcpUpdatedAt" not in data
    sidecar = cfg.parent / ".pulsar-managed-mcp.json"
    assert set(json.loads(sidecar.read_text())) == {"swarm-manager", "code-index"}


def test_configure_opencode_idempotent_removes_stale(tmp_path, monkeypatch):
    agent = _agent(tmp_path)
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})
    configure_opencode_mcp(agent, "a")
    # Plugin removed → only swarm-manager remains.
    _patch_fetch(monkeypatch, {"mcpServers": {"swarm-manager": CANONICAL["swarm-manager"]}})
    configure_opencode_mcp(agent, "a")

    data = json.loads((tmp_path / ".config" / "opencode" / "config.json").read_text())
    assert "code-index" not in data["mcp"]
    assert "swarm-manager" in data["mcp"]
    assert "__pulsarManagedMcpServers" not in data
    sidecar = tmp_path / ".config" / "opencode" / ".pulsar-managed-mcp.json"
    assert json.loads(sidecar.read_text()) == ["swarm-manager"]


def test_configure_opencode_migrates_legacy_bookkeeping(tmp_path, monkeypatch):
    cfg = tmp_path / ".config" / "opencode" / "config.json"
    cfg.parent.mkdir(parents=True)
    cfg.write_text(json.dumps({
        "mcp": {
            "old-managed": {"type": "remote", "url": "https://old", "enabled": True},
            "github": {"type": "local", "command": ["npx"]},
        },
        "__pulsarManagedMcpServers": ["old-managed"],
        "_pulsarMcpUpdatedAt": 123,
    }))
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})

    configure_opencode_mcp(_agent(tmp_path), "agent-1")

    data = json.loads(cfg.read_text())
    assert "__pulsarManagedMcpServers" not in data
    assert "_pulsarMcpUpdatedAt" not in data
    assert "old-managed" not in data["mcp"]
    assert data["mcp"]["github"] == {"type": "local", "command": ["npx"]}
    assert set(data["mcp"]) == {"github", "swarm-manager", "code-index"}


def test_configure_skips_on_fetch_failure(tmp_path, monkeypatch):
    cfg = tmp_path / ".config" / "opencode" / "config.json"
    cfg.parent.mkdir(parents=True)
    original = {"mcp": {"keep": {"type": "local"}}}
    cfg.write_text(json.dumps(original))
    _patch_fetch(monkeypatch, None)  # team-api unreachable

    configure_opencode_mcp(_agent(tmp_path), "a")

    assert json.loads(cfg.read_text()) == original  # left untouched


# ── codex writer ─────────────────────────────────────────────────────────────

def test_configure_codex_managed_block_idempotent(tmp_path, monkeypatch):
    cfg = tmp_path / ".codex" / "config.toml"
    cfg.parent.mkdir(parents=True)
    cfg.write_text('model = "gpt-5"\n')
    agent = _agent(tmp_path)

    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})
    configure_codex_mcp(agent, "a")
    text = cfg.read_text()
    assert 'model = "gpt-5"' in text                  # user content preserved
    assert text.count(_CODEX_MARK_START) == 1
    assert "[mcp_servers.swarm-manager]" in text
    assert "[mcp_servers.code-index]" in text

    # Re-run with one fewer server: still a single managed block.
    _patch_fetch(monkeypatch, {"mcpServers": {"swarm-manager": CANONICAL["swarm-manager"]}})
    configure_codex_mcp(agent, "a")
    text2 = cfg.read_text()
    assert text2.count(_CODEX_MARK_START) == 1
    assert "[mcp_servers.code-index]" not in text2
    assert 'model = "gpt-5"' in text2


# ── hermes writer + flag ─────────────────────────────────────────────────────

def test_configure_hermes_writes_yaml_and_counts(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})
    n = configure_hermes_mcp(_agent(tmp_path), "a")
    assert n == 2
    data = yaml.safe_load((tmp_path / ".hermes" / "config.yaml").read_text())
    assert data["mcp_servers"]["swarm-manager"] == {"url": "http://swarm:8000/ai/mcp"}


def test_configure_hermes_returns_minus_one_on_failure(tmp_path, monkeypatch):
    _patch_fetch(monkeypatch, None)
    assert configure_hermes_mcp(_agent(tmp_path), "a") == -1


def test_hermes_drops_ignore_user_config_when_mcp_present():
    from backends.hermes import HermesBackend

    b = HermesBackend()
    assert "--ignore-user-config" in b._common_chat_args("a", None)
    b._mcp_present["a"] = True
    assert "--ignore-user-config" not in b._common_chat_args("a", None)


# ── openclaw writer ──────────────────────────────────────────────────────────

def test_configure_openclaw_nested_servers_preserves_config(tmp_path, monkeypatch):
    cfg = tmp_path / ".openclaw" / "openclaw.json"
    cfg.parent.mkdir(parents=True)
    # Pre-existing openclaw.json with unrelated keys + a user-added MCP server.
    cfg.write_text(json.dumps({
        "commands": {"native": "auto"},
        "mcp": {"servers": {"user-srv": {"command": "npx", "args": ["x"]}}},
        "meta": {"lastTouchedVersion": "2026.5.27"},
    }))
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})

    configure_openclaw_mcp(_agent(tmp_path), "a")

    data = json.loads(cfg.read_text())
    assert data["commands"] == {"native": "auto"}                  # untouched
    assert data["meta"]["lastTouchedVersion"] == "2026.5.27"        # untouched
    assert "__pulsarManagedMcpServers" not in data                 # no pollution
    srv = data["mcp"]["servers"]
    assert srv["user-srv"] == {"command": "npx", "args": ["x"]}     # user MCP preserved
    assert srv["swarm-manager"] == {
        "url": "http://swarm:8000/ai/mcp",
        "transport": "streamable-http",
    }
    # Managed list tracked in a sidecar, not in openclaw.json.
    sidecar = json.loads((tmp_path / ".openclaw" / ".pulsar-managed-mcp.json").read_text())
    assert set(sidecar) == {"swarm-manager", "code-index"}


def test_configure_openclaw_idempotent_removes_stale(tmp_path, monkeypatch):
    agent = _agent(tmp_path)
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})
    configure_openclaw_mcp(agent, "a")
    # Plugin removed → only swarm-manager remains; code-index must be dropped.
    _patch_fetch(monkeypatch, {"mcpServers": {"swarm-manager": CANONICAL["swarm-manager"]}})
    configure_openclaw_mcp(agent, "a")

    srv = json.loads((tmp_path / ".openclaw" / "openclaw.json").read_text())["mcp"]["servers"]
    assert "code-index" not in srv
    assert "swarm-manager" in srv
