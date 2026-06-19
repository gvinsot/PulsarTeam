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
    _rewrite_internal_url,
    _rewrite_internal_mcp_urls,
    configure_opencode_mcp,
    configure_codex_mcp,
    configure_hermes_mcp,
    configure_openclaw_mcp,
    configure_claude_mcp,
    claude_mcp_config_path,
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


# ── Internal-MCP URL rewrite (localhost → runner-facing team-api) ─────────────

def test_rewrite_internal_url_swaps_localhost_for_api_base(monkeypatch):
    monkeypatch.setattr(rmc, "_API_BASE", "http://team-api:3001")
    # localhost / 127.0.0.1 (any port) → team-api host, path/query preserved
    assert (
        _rewrite_internal_url("http://localhost:3001/api/swarm-api/mcp")
        == "http://team-api:3001/api/swarm-api/mcp"
    )
    assert (
        _rewrite_internal_url("http://127.0.0.1:9999/api/code-index/mcp?x=1")
        == "http://team-api:3001/api/code-index/mcp?x=1"
    )


def test_rewrite_internal_url_leaves_external_untouched(monkeypatch):
    monkeypatch.setattr(rmc, "_API_BASE", "http://team-api:3001")
    external = "https://mcp.example.com/sse"
    assert _rewrite_internal_url(external) == external
    assert _rewrite_internal_url("") == ""
    assert _rewrite_internal_url(None) is None


def test_rewrite_internal_mcp_urls_maps_only_local(monkeypatch):
    monkeypatch.setattr(rmc, "_API_BASE", "http://team-api:3001")
    servers = {
        "swarm-api": {"type": "http", "url": "http://localhost:3001/api/swarm-api/mcp",
                      "headers": {"Authorization": "Bearer t"}},
        "external": {"type": "http", "url": "https://x/mcp"},
        "no_url": {"type": "http"},
    }
    out = _rewrite_internal_mcp_urls(servers)
    assert out["swarm-api"]["url"] == "http://team-api:3001/api/swarm-api/mcp"
    # headers and other fields preserved; original dict not mutated
    assert out["swarm-api"]["headers"] == {"Authorization": "Bearer t"}
    assert servers["swarm-api"]["url"] == "http://localhost:3001/api/swarm-api/mcp"
    assert out["external"]["url"] == "https://x/mcp"
    assert out["no_url"] == {"type": "http"}


def test_fetch_agent_mcp_rewrites_localhost(monkeypatch):
    """_fetch_agent_mcp applies the rewrite to the team-api payload so all
    downstream writers materialize runner-reachable URLs."""
    monkeypatch.setattr(rmc, "_API_BASE", "http://team-api:3001")
    monkeypatch.setattr(rmc, "_API_KEY", "secret")

    class _Resp:
        status_code = 200

        def json(self):
            return {"configured": True, "mcpServers": {
                "swarm-api": {"type": "http", "url": "http://localhost:3001/api/swarm-api/mcp"},
            }}

    monkeypatch.setattr(rmc.httpx, "get", lambda *a, **k: _Resp())
    data = rmc._fetch_agent_mcp("agent-1")
    assert data["mcpServers"]["swarm-api"]["url"] == "http://team-api:3001/api/swarm-api/mcp"


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


def test_hermes_never_passes_ignore_user_config():
    """~/.hermes/{config.yaml,.env} is now authoritative (restored from team-api
    = what the user set up in the terminal), so we must never tell hermes to
    ignore it — that flag was what caused the 'no providers found' setup loop."""
    from backends.hermes import HermesBackend

    b = HermesBackend()
    assert "--ignore-user-config" not in b._common_chat_args("a", None)
    b._mcp_present["a"] = True
    assert "--ignore-user-config" not in b._common_chat_args("a", None)


def test_hermes_never_emits_model_flag():
    """hermes' model is fully terminal-driven: it comes from ~/.hermes/config.yaml
    (restored from team-api), never from the Settings per-agent LLM config. So we
    must emit no --provider/--model — even WITH a per-agent config attached — or a
    stale Settings pin (e.g. claude-opus-4-8) would override the terminal config
    and the user could not change the model from the terminal."""
    from backends.hermes import HermesBackend

    b = HermesBackend()
    assert "--model" not in b._common_chat_args("a", None)
    assert "--provider" not in b._common_chat_args("a", None)

    # Even with a per-agent LLM config attached, no model/provider flag leaks.
    b.set_agent_llm_config("a", {"provider": "anthropic", "model": "claude-opus-4-8"})
    args = b._common_chat_args("a", None)
    assert "--model" not in args
    assert "--provider" not in args
    assert "claude-opus-4-8" not in args


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


# ── claude writer (--mcp-config file, NOT settings.json) ─────────────────────

def test_configure_claude_writes_mcp_config_file(tmp_path, monkeypatch):
    """Claude Code ignores settings.json mcpServers, so the server map must land
    in ~/.claude/pulsar-mcp.json (loaded via --mcp-config), shaped as a top-level
    {"mcpServers": {...}} document."""
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})
    configure_claude_mcp(_agent(tmp_path), "agent-1")

    cfg = claude_mcp_config_path(str(tmp_path))
    data = json.loads(Path(cfg).read_text())
    assert set(data.keys()) == {"mcpServers"}
    assert data["mcpServers"] == CANONICAL
    # The map must NOT have been written into settings.json (the CLI ignores it).
    assert not (tmp_path / ".claude" / "settings.json").exists()


def test_configure_claude_purges_stale_settings_mcp(tmp_path, monkeypatch):
    """A settings.json polluted by older builds (mcpServers + managed key) gets
    those keys stripped while unrelated settings are preserved."""
    settings = tmp_path / ".claude" / "settings.json"
    settings.parent.mkdir(parents=True)
    settings.write_text(json.dumps({
        "theme": "dark",
        "permissions": {"deny": ["Bash"]},
        "mcpServers": {"stale": {"type": "http", "url": "http://x/mcp"}},
        "__pulsarManagedMcpServers": ["stale"],
        "_pulsarMcpUpdatedAt": 123,
    }))
    _patch_fetch(monkeypatch, {"mcpServers": CANONICAL})

    configure_claude_mcp(_agent(tmp_path), "agent-1")

    after = json.loads(settings.read_text())
    assert after["theme"] == "dark"                       # preserved
    assert after["permissions"] == {"deny": ["Bash"]}      # preserved
    assert "mcpServers" not in after                       # dead key removed
    assert "__pulsarManagedMcpServers" not in after
    assert "_pulsarMcpUpdatedAt" not in after
    # And the live config file now carries the servers.
    data = json.loads(Path(claude_mcp_config_path(str(tmp_path))).read_text())
    assert data["mcpServers"] == CANONICAL


def test_configure_claude_skips_on_fetch_failure(tmp_path, monkeypatch):
    cfg = Path(claude_mcp_config_path(str(tmp_path)))
    cfg.parent.mkdir(parents=True)
    original = json.dumps({"mcpServers": {"keep": {"type": "http", "url": "http://k/mcp"}}})
    cfg.write_text(original)
    _patch_fetch(monkeypatch, None)  # team-api unreachable

    configure_claude_mcp(_agent(tmp_path), "a")

    assert cfg.read_text() == original  # left untouched


def test_configure_claude_empty_map_clears_file(tmp_path, monkeypatch):
    cfg = Path(claude_mcp_config_path(str(tmp_path)))
    cfg.parent.mkdir(parents=True)
    cfg.write_text(json.dumps({"mcpServers": CANONICAL}))
    _patch_fetch(monkeypatch, {"mcpServers": {}})  # agent has zero servers

    configure_claude_mcp(_agent(tmp_path), "a")

    assert not cfg.exists()  # stale file removed so --mcp-config is skipped
