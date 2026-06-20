"""
Fetch agent MCP wiring from team-api and write runner-native config.

For Claude Code, MCP server *definitions* are NOT read from settings.json
(only approval keys such as enableAllProjectMcpServers live there). They must
come from --mcp-config, the user ~/.claude.json, or a project .mcp.json. We
therefore write the API's server map to a dedicated ~/.claude/pulsar-mcp.json
and the claude backend launches with `--mcp-config <that file>
--strict-mcp-config` (see ClaudeCodeBackend._build_cmd) so it is the single,
guaranteed source of MCP servers for the session. The API returns the
canonical Claude shape with the internal JWT and per-agent context
(X-Agent-Id / X-Board-Id) headers already resolved.

As of the gateway change, team-api returns a SINGLE server for CLI runners —
the Pulsar Gateway — instead of one entry per attached plugin/MCP. The agent
discovers and invokes every other MCP (its own plugins, board plugins, the
Swarm API) dynamically through the gateway's list_mcps / call_mcp_tool tools.
This module stays agnostic: it writes whatever server map the API returns and
reconciles previously-managed entries idempotently, so the transition from the
old multi-entry config to the single gateway entry happens on the next spawn.
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional
from urllib.parse import urlsplit, urlunsplit

import httpx
import yaml
from swarm_secrets import read as read_secret

from config import logger
# Aliased so the many call sites here (and runner_instructions_config's
# import of `_resolve_home`) keep working against the shared resolver.
from agent_user import resolve_agent_home as _resolve_home
from .runner_local_models import fetch_local_models

# Opt-in: write the operator's local (vLLM/Ollama) models into hermes'
# ~/.hermes/config.yaml so they can be switched inside the TUI. OFF by default
# because the hermes `providers:` schema below is NOT verified against a hermes
# release (only `mcp_servers` is — see the comment above to_hermes_mcp). The
# agent's Settings-selected model already works as the default via the
# --provider/--model flags + env injection, independent of this. Verify the
# schema against the deployed hermes build, then set HERMES_INJECT_LOCAL_PROVIDERS=true.
_HERMES_INJECT_LOCAL = os.getenv("HERMES_INJECT_LOCAL_PROVIDERS", "false").lower() in ("1", "true", "yes")
_HERMES_MANAGED_PROVIDERS_KEY = "__pulsarManagedProviders"


_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH = "/api/internal/runner-mcp/agents"
_MANAGED_KEY = "__pulsarManagedMcpServers"

# team-api mints its internal MCP server URLs relative to its OWN container
# (http://localhost:<port>/api/...; see mcpManager.resolveInternalMcpConfig).
# The CLI process we spawn runs in THIS (runner) container, where localhost is
# not team-api — so those URLs must be rewritten to the runner-facing team-api
# host (the same base we use to reach the API: SWARM_API_BASE_URL). Without this
# every internal MCP (Swarm API, Code Index, …) would be unreachable from a CLI
# runner agent.
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "0.0.0.0"}


def _rewrite_internal_url(url: Optional[str]) -> Optional[str]:
    """Rewrite a team-api internal MCP URL whose host is localhost/127.0.0.1 to
    the runner-facing team-api host (SWARM_API_BASE_URL). External MCP URLs are
    returned unchanged."""
    if not isinstance(url, str) or not url:
        return url
    try:
        parts = urlsplit(url)
    except ValueError:
        return url
    if (parts.hostname or "").lower() not in _LOCAL_HOSTS:
        return url
    base = urlsplit(_API_BASE)
    if not base.netloc:
        return url
    return urlunsplit(
        (base.scheme or "http", base.netloc, parts.path, parts.query, parts.fragment)
    )


def _rewrite_internal_mcp_urls(servers: Optional[dict]) -> Optional[dict]:
    """Return a copy of the canonical server map with localhost MCP URLs
    rewritten to be reachable from inside the runner container."""
    if not isinstance(servers, dict):
        return servers
    out: dict = {}
    for name, cfg in servers.items():
        if isinstance(cfg, dict) and cfg.get("url"):
            cfg = {**cfg, "url": _rewrite_internal_url(cfg["url"])}
        out[name] = cfg
    return out


def _fetch_agent_mcp(agent_id: str) -> Optional[dict]:
    if not agent_id or not _API_KEY:
        return None
    try:
        r = httpx.get(
            f"{_API_BASE}{_PATH}/{agent_id}",
            headers={"X-Api-Key": _API_KEY},
            timeout=5.0,
        )
    except httpx.HTTPError as e:
        logger.warning(f"[Runner MCP] api unreachable for agent {agent_id[:12]}: {e}")
        return None
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        logger.warning(f"[Runner MCP] api {r.status_code} for agent {agent_id[:12]}: {r.text[:200]}")
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    # Rewrite localhost internal MCP URLs to the runner-facing team-api host so
    # the spawned CLI can actually reach them (see _rewrite_internal_url).
    if isinstance(data, dict) and isinstance(data.get("mcpServers"), dict):
        data["mcpServers"] = _rewrite_internal_mcp_urls(data["mcpServers"])
    return data


# Claude Code ignores `mcpServers` in settings.json (see module docstring), so
# the agent's server map is written here and loaded via `--mcp-config <file>
# --strict-mcp-config` at spawn. Lives under ~/.claude/ alongside settings.json.
_CLAUDE_MCP_CONFIG_FILE = "pulsar-mcp.json"


def claude_mcp_config_path(home: str) -> str:
    """Absolute path of the --mcp-config file written for a Claude runner."""
    return os.path.join(home, ".claude", _CLAUDE_MCP_CONFIG_FILE)


def _purge_stale_claude_settings_mcp(home: str, uid: Optional[int], gid: Optional[int]) -> None:
    """Strip the dead `mcpServers` / `__pulsarManagedMcpServers` keys that older
    builds wrote into ~/.claude/settings.json. The Claude CLI never read them,
    but they make it look like MCP is configured when it is not — remove them so
    the only live source is the --mcp-config file. All other settings (permissions,
    theme, …) are preserved."""
    settings_path = os.path.join(home, ".claude", "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    if not isinstance(settings, dict):
        return
    if not any(k in settings for k in ("mcpServers", _MANAGED_KEY, "_pulsarMcpUpdatedAt")):
        return
    for k in ("mcpServers", _MANAGED_KEY, "_pulsarMcpUpdatedAt"):
        settings.pop(k, None)
    try:
        _atomic_write(
            settings_path, os.path.join(home, ".claude"),
            json.dumps(settings, indent=2) + "\n", uid, gid,
        )
    except OSError:
        pass


def configure_claude_mcp(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    """Write the agent's MCP server map to ~/.claude/pulsar-mcp.json.

    Claude Code does NOT read MCP definitions from settings.json, so the claude
    backend launches with `--mcp-config <this file> --strict-mcp-config`,
    making this file the single source of MCP servers for the session —
    currently the Pulsar Gateway, which always carries the unified update_task
    tool (move and/or finish the current task) plus the dynamic list_mcps /
    call_mcp_tool proxy.

    A team-api fetch failure leaves any existing file untouched (we never strip
    tools on a transient outage). An empty server map removes a stale file so
    --mcp-config is not passed with nothing to load on the next spawn.
    """
    if not agent_user or not agent_id:
        return
    home = agent_user.get("home")
    if not home:
        return

    data = _fetch_agent_mcp(agent_id)
    if data is None:
        return

    uid = agent_user.get("uid")
    gid = agent_user.get("gid", uid)

    # One-time migration: clear the dead settings.json MCP keys older builds left.
    _purge_stale_claude_settings_mcp(home, uid, gid)

    incoming = data.get("mcpServers") if isinstance(data, dict) else {}
    if not isinstance(incoming, dict):
        incoming = {}

    cfg_dir = os.path.join(home, ".claude")
    cfg_path = claude_mcp_config_path(home)

    if not incoming:
        # No servers for this agent — drop a stale file so the backend skips the
        # --mcp-config flag rather than launching with an empty (strict) map.
        try:
            os.remove(cfg_path)
        except OSError:
            pass
        logger.info(f"[Runner MCP] no MCP servers for agent {agent_id[:12]} — cleared {_CLAUDE_MCP_CONFIG_FILE}")
        return

    payload = json.dumps({"mcpServers": incoming}, indent=2) + "\n"
    try:
        _atomic_write(cfg_path, cfg_dir, payload, uid, gid)
        logger.info(
            f"[Runner MCP] configured {len(incoming)} MCP server(s) for agent "
            f"{agent_id[:12]} via --mcp-config"
        )
    except OSError as e:
        logger.warning(f"[Runner MCP] failed to write {cfg_path}: {e}")


# ─────────────────────────────────────────────────────────────────────────────
# Non-Claude CLI runners (opencode / codex / hermes / openclaw)
#
# `configure_claude_mcp` above writes the Claude-Code-native shape into
# `~/.claude/settings.json`. Every other CLI reads its MCP wiring from a
# different file in a different format, so the team-api server list must be
# *translated* per CLI. team-api always returns the canonical Claude shape
# (see mcpManager.getClaudeMcpConfigForAgent):
#
#     { "<name>": { "type": "http", "url": "...", "headers": {...} } }
#
# The translators below are pure functions (unit-tested) that map that shape
# to each CLI's native schema; the `configure_*_mcp` writers fetch + reconcile
# + persist. All writers follow the same idempotency contract as
# `configure_claude_mcp`: previously-managed entries are removed before the
# fresh set is added (tracked under `_MANAGED_KEY`), so removing a plugin
# really removes its tools on the next spawn. A team-api fetch failure leaves
# the existing on-disk config untouched (we never wipe tools on a transient
# outage).
# ─────────────────────────────────────────────────────────────────────────────

_CODEX_MARK_START = "# >>> pulsarteam-managed-mcp (do not edit) >>>"
_CODEX_MARK_END = "# <<< pulsarteam-managed-mcp <<<"
_BARE_TOML_KEY = re.compile(r"^[A-Za-z0-9_-]+$")


def _fetch_servers_or_none(agent_id: Optional[str]) -> Optional[dict]:
    """Return the agent's canonical MCP server map, or None to mean
    "leave the existing config untouched" (team-api unreachable / 404).

    An empty dict means "the agent has zero MCP servers" and DOES trigger a
    reconcile (any previously-managed entries get removed)."""
    if not agent_id:
        return None
    data = _fetch_agent_mcp(agent_id)
    if data is None:
        return None
    servers = data.get("mcpServers") if isinstance(data, dict) else None
    return servers if isinstance(servers, dict) else {}


def _atomic_write(
    path: str, parent_dir: str, text: str,
    uid: Optional[int], gid: Optional[int], dir_mode: int = 0o700,
) -> None:
    """Write `text` to `path` atomically and chown it to the agent UID so the
    dropped-privilege CLI process can read it back."""
    # Capture the ancestor directories we are about to create so we can chown
    # *each* of them — not just `parent_dir`. os.makedirs creates intermediate
    # dirs (e.g. `$HOME/.config` on the way to `$HOME/.config/opencode`) owned
    # by the server process (root). If we only chown the leaf, that root-owned
    # `.config` is mode 0700 and the agent-UID CLI can't traverse/write it,
    # so opencode fails with `mkdir .config/opencode EACCES`.
    created_dirs: list[str] = []
    probe = parent_dir
    while probe and not os.path.isdir(probe):
        created_dirs.append(probe)
        nxt = os.path.dirname(probe)
        if nxt == probe:
            break
        probe = nxt
    os.makedirs(parent_dir, mode=dir_mode, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
    if uid is not None:
        eff_gid = gid if gid is not None else uid
        # Newly created dirs (deepest-first order is fine for chown) + the file.
        for p in (*created_dirs, path):
            try:
                os.chown(p, uid, eff_gid)
            except OSError:
                pass


def _strip_managed_block(text: str, start: str, end: str) -> str:
    """Remove the region between the `start`/`end` marker lines (inclusive).
    Used for line-oriented configs (TOML) where we append a managed block
    rather than round-tripping the whole document."""
    if start not in text:
        return text
    out: list[str] = []
    skipping = False
    for line in text.splitlines():
        if line.strip() == start:
            skipping = True
            continue
        if skipping:
            if line.strip() == end:
                skipping = False
            continue
        out.append(line)
    return "\n".join(out)


# ── opencode ──────────────────────────────────────────────────────────────────
# ~/.config/opencode/config.json, key `mcp`. Remote (HTTP) servers use
# {type:"remote", url, headers, enabled:true}. See opencode.ai/docs config schema.
_OPENCODE_MANAGED_SIDECAR = ".pulsar-managed-mcp.json"

def to_opencode_mcp(servers: Optional[dict]) -> dict:
    out: dict = {}
    for name, cfg in (servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        url = cfg.get("url")
        if not url:
            continue
        entry = {"type": "remote", "url": url, "enabled": True}
        headers = cfg.get("headers")
        if isinstance(headers, dict) and headers:
            entry["headers"] = dict(headers)
        out[name] = entry
    return out


def configure_opencode_mcp(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    servers = _fetch_servers_or_none(agent_id)
    if servers is None:
        return
    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        logger.warning(f"[OpenCode MCP] no HOME for agent {(agent_id or '?')[:12]} — skipping MCP write")
        return
    cfg_dir = os.path.join(home, ".config", "opencode")
    cfg_path = os.path.join(cfg_dir, "config.json")
    sidecar = os.path.join(cfg_dir, _OPENCODE_MANAGED_SIDECAR)
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        if not isinstance(settings, dict):
            settings = {}
    except (OSError, json.JSONDecodeError):
        settings = {}

    # Managed-server bookkeeping lives in a sidecar, not in config.json —
    # OpenCode validates config.json with additionalProperties=false.
    previous = _read_managed_sidecar(sidecar)

    servers_map = settings.get("mcp")
    if not isinstance(servers_map, dict):
        servers_map = {}
    for name in previous:
        servers_map.pop(name, None)

    block = to_opencode_mcp(servers)
    servers_map.update(block)

    if servers_map:
        settings["mcp"] = servers_map
    else:
        settings.pop("mcp", None)

    try:
        _atomic_write(cfg_path, cfg_dir, json.dumps(settings, indent=2) + "\n", uid, gid)
        _atomic_write(sidecar, cfg_dir, json.dumps(list(block.keys())) + "\n", uid, gid)
        logger.info(f"[OpenCode MCP] configured {len(block)} MCP server(s) for agent {(agent_id or '?')[:12]}")
    except OSError as e:
        logger.warning(f"[OpenCode MCP] failed to write {cfg_path}: {e}")


# ── openclaw ──────────────────────────────────────────────────────────────────
# ~/.openclaw/openclaw.json, NESTED under mcp.servers.<name>. Schema VERIFIED
# against openclaw 2026.5.27 (`openclaw mcp set` normalizes a {type:http,url,
# headers} input to):
#
#     { "mcp": { "servers": { "<name>": {
#         "url": "...", "transport": "streamable-http", "headers": {...} } } } }
#
# openclaw.json carries many other top-level keys (commands, agents, cron, …)
# and has a `config validate` command, so we MUST NOT pollute it with our own
# bookkeeping key. The managed-server list is tracked in a sidecar file
# (.pulsar-managed-mcp.json) instead.

def to_openclaw_mcp(servers: Optional[dict]) -> dict:
    out: dict = {}
    for name, cfg in (servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        url = cfg.get("url")
        if not url:
            continue
        entry: dict = {"url": url, "transport": "streamable-http"}
        headers = cfg.get("headers")
        if isinstance(headers, dict) and headers:
            entry["headers"] = dict(headers)
        out[name] = entry
    return out


def _read_managed_sidecar(path: str) -> list[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return []
    return [n for n in data if isinstance(n, str)] if isinstance(data, list) else []


def configure_openclaw_mcp(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    servers = _fetch_servers_or_none(agent_id)
    if servers is None:
        return
    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        logger.warning(f"[OpenClaw MCP] no HOME for agent {(agent_id or '?')[:12]} — skipping MCP write")
        return
    cfg_dir = os.path.join(home, ".openclaw")
    cfg_path = os.path.join(cfg_dir, "openclaw.json")
    sidecar = os.path.join(cfg_dir, ".pulsar-managed-mcp.json")
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except (OSError, json.JSONDecodeError):
        data = {}

    block = to_openclaw_mcp(servers)
    mcp = data.get("mcp")
    if not isinstance(mcp, dict):
        mcp = {}
    srv = mcp.get("servers")
    if not isinstance(srv, dict):
        srv = {}
    for name in _read_managed_sidecar(sidecar):
        srv.pop(name, None)
    srv.update(block)

    if srv:
        mcp["servers"] = srv
        data["mcp"] = mcp
    else:
        mcp.pop("servers", None)
        if mcp:
            data["mcp"] = mcp
        else:
            data.pop("mcp", None)

    try:
        _atomic_write(cfg_path, cfg_dir, json.dumps(data, indent=2) + "\n", uid, gid)
        _atomic_write(sidecar, cfg_dir, json.dumps(list(block.keys())) + "\n", uid, gid)
        logger.info(f"[OpenClaw MCP] configured {len(block)} MCP server(s) for agent {(agent_id or '?')[:12]}")
    except OSError as e:
        logger.warning(f"[OpenClaw MCP] failed to write {cfg_path}: {e}")


# ── hermes ────────────────────────────────────────────────────────────────────
# ~/.hermes/config.yaml, key `mcp_servers`. Schema VERIFIED against hermes
# v0.15.0 (tools/mcp_tool.py docstring + parser):
#
#     mcp_servers:
#       <name>:
#         url: "https://.../mcp"          # presence of `url` ⇒ HTTP/StreamableHTTP
#         headers: { Authorization: "Bearer ..." }
#
# `transport:` is only read for the literal value "sse"; HTTP/StreamableHTTP is
# the default for a `url` entry, so we omit it. The hermes backend must ALSO
# drop `--ignore-user-config` when MCP is present (otherwise this file is
# ignored) — see HermesBackend._configure_mcp.

def to_hermes_mcp(servers: Optional[dict]) -> dict:
    out: dict = {}
    for name, cfg in (servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        url = cfg.get("url")
        if not url:
            continue
        entry: dict = {"url": url}
        headers = cfg.get("headers")
        if isinstance(headers, dict) and headers:
            entry["headers"] = dict(headers)
        out[name] = entry
    return out


def configure_hermes_mcp(agent_user: Optional[dict], agent_id: Optional[str]) -> int:
    """Returns the number of MCP servers written (so the backend can decide
    whether to drop `--ignore-user-config`), or -1 when the fetch failed and
    the existing config was left untouched."""
    servers = _fetch_servers_or_none(agent_id)
    if servers is None:
        return -1
    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        logger.warning(f"[Hermes MCP] no HOME for agent {(agent_id or '?')[:12]} — skipping MCP write")
        return -1
    cfg_dir = os.path.join(home, ".hermes")
    cfg_path = os.path.join(cfg_dir, "config.yaml")
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            data = {}
    except (OSError, yaml.YAMLError):
        data = {}

    block = to_hermes_mcp(servers)
    mcp_map = data.get("mcp_servers")
    if not isinstance(mcp_map, dict):
        mcp_map = {}
    for name in (data.get(_MANAGED_KEY) or []):
        if isinstance(name, str):
            mcp_map.pop(name, None)
    mcp_map.update(block)

    if mcp_map:
        data["mcp_servers"] = mcp_map
    else:
        data.pop("mcp_servers", None)
    data[_MANAGED_KEY] = list(block.keys())

    text = yaml.safe_dump(data, sort_keys=False, default_flow_style=False)
    try:
        _atomic_write(cfg_path, cfg_dir, text, uid, gid)
        logger.info(f"[Hermes MCP] configured {len(block)} MCP server(s) for agent {(agent_id or '?')[:12]}")
    except OSError as e:
        logger.warning(f"[Hermes MCP] failed to write {cfg_path}: {e}")
        return -1
    return len(block)


def _to_hermes_local_providers(models: list) -> dict:
    """Best-effort hermes `providers` map for local vLLM/Ollama models.

    SCHEMA UNVERIFIED — this mirrors a conventional OpenAI-compatible provider
    block; adjust to match the deployed hermes build before enabling
    HERMES_INJECT_LOCAL_PROVIDERS. Keyed by a stable, collision-resistant name.
    """
    out: dict = {}
    for m in models or []:
        provider = (m.get("provider") or "").strip().lower()
        model = (m.get("model") or "").strip()
        if not provider or not model:
            continue
        endpoint = (m.get("endpoint") or "").strip().rstrip("/")
        if endpoint and not endpoint.endswith("/v1"):
            endpoint = f"{endpoint}/v1"
        name = f"{provider}-{model}".replace("/", "-")
        entry: dict = {"type": "openai", "models": [model]}
        if endpoint:
            entry["base_url"] = endpoint
        entry["api_key"] = (m.get("apiKey") or "").strip() or "local"
        out[name] = entry
    return out


def configure_hermes_local_providers(agent_user: Optional[dict], agent_id: Optional[str]) -> int:
    """Inject the operator's local models into ~/.hermes/config.yaml (opt-in).

    No-op unless HERMES_INJECT_LOCAL_PROVIDERS is set. Returns the number of
    providers written, or -1 on skip/failure. Tracked via a managed key so a
    stale set is replaced on the next spawn. Never raises.
    """
    if not _HERMES_INJECT_LOCAL:
        return -1
    models = fetch_local_models()
    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        return -1
    cfg_dir = os.path.join(home, ".hermes")
    cfg_path = os.path.join(cfg_dir, "config.yaml")
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        if not isinstance(data, dict):
            data = {}
    except (OSError, yaml.YAMLError):
        data = {}

    block = _to_hermes_local_providers(models)
    providers = data.get("providers")
    if not isinstance(providers, dict):
        providers = {}
    for name in (data.get(_HERMES_MANAGED_PROVIDERS_KEY) or []):
        if isinstance(name, str):
            providers.pop(name, None)
    providers.update(block)

    if providers:
        data["providers"] = providers
    else:
        data.pop("providers", None)
    data[_HERMES_MANAGED_PROVIDERS_KEY] = list(block.keys())

    text = yaml.safe_dump(data, sort_keys=False, default_flow_style=False)
    try:
        _atomic_write(cfg_path, cfg_dir, text, uid, gid)
        logger.info(f"[Hermes LLM] injected {len(block)} local provider(s) for agent {(agent_id or '?')[:12]}")
    except OSError as e:
        logger.warning(f"[Hermes LLM] failed to write {cfg_path}: {e}")
        return -1
    return len(block)


# ── codex ─────────────────────────────────────────────────────────────────────
# ~/.codex/config.toml, [mcp_servers.<name>] tables. Streamable-HTTP MCP support
# in codex is recent/version-dependent; older codex CLIs only support stdio MCP
# and will ignore (or reject) `url`. We emit a marker-delimited managed block so
# the user's hand-written config above the markers is preserved and the block is
# rewritten idempotently on each spawn.

def _toml_basic_string(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def to_codex_mcp_toml(servers: Optional[dict]) -> str:
    """Render the [mcp_servers.*] tables (no markers). Empty string when there
    are no servers to write."""
    chunks: list[str] = []
    for name, cfg in (servers or {}).items():
        if not isinstance(cfg, dict):
            continue
        url = cfg.get("url")
        if not url:
            continue
        key = name if _BARE_TOML_KEY.match(name) else _toml_basic_string(name)
        lines = [f"[mcp_servers.{key}]", f"url = {_toml_basic_string(url)}"]
        headers = cfg.get("headers")
        if isinstance(headers, dict) and headers:
            inline = ", ".join(
                f"{_toml_basic_string(str(k))} = {_toml_basic_string(str(v))}"
                for k, v in headers.items()
            )
            lines.append(f"http_headers = {{ {inline} }}")
        chunks.append("\n".join(lines))
    return "\n\n".join(chunks)


def configure_codex_mcp(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    servers = _fetch_servers_or_none(agent_id)
    if servers is None:
        return
    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        logger.warning(f"[Codex MCP] no HOME for agent {(agent_id or '?')[:12]} — skipping MCP write")
        return
    cfg_dir = os.path.join(home, ".codex")
    cfg_path = os.path.join(cfg_dir, "config.toml")
    try:
        with open(cfg_path, "r", encoding="utf-8") as f:
            existing = f.read()
    except OSError:
        existing = ""

    stripped = _strip_managed_block(existing, _CODEX_MARK_START, _CODEX_MARK_END)
    block = to_codex_mcp_toml(servers)
    if block:
        managed = f"{_CODEX_MARK_START}\n{block}\n{_CODEX_MARK_END}\n"
        head = stripped.rstrip("\n")
        new_text = f"{head}\n\n{managed}" if head.strip() else managed
    else:
        new_text = stripped.rstrip("\n") + "\n" if stripped.strip() else ""

    if new_text == existing:
        return
    try:
        if not new_text:
            # Nothing left to write and the file only contained our block.
            if os.path.exists(cfg_path):
                _atomic_write(cfg_path, cfg_dir, "", uid, gid)
        else:
            _atomic_write(cfg_path, cfg_dir, new_text, uid, gid)
        n = len(to_codex_mcp_toml(servers).split("[mcp_servers.")) - 1 if block else 0
        logger.info(f"[Codex MCP] configured {n} MCP server(s) for agent {(agent_id or '?')[:12]}")
    except OSError as e:
        logger.warning(f"[Codex MCP] failed to write {cfg_path}: {e}")
