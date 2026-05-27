"""
Fetch agent plugin MCP wiring from team-api and write runner-native config.

For Claude Code, MCP servers live in ~/.claude/settings.json under
`mcpServers`. The API returns exactly that shape after resolving plugin
assignments, direct MCP assignments, internal JWT headers, and per-agent
context headers.
"""

from __future__ import annotations

import json
import os
import time
from typing import Optional

import httpx
from swarm_secrets import read as read_secret

from config import logger


_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH = "/api/internal/runner-mcp/agents"
_MANAGED_KEY = "__pulsarManagedMcpServers"


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
        return r.json()
    except ValueError:
        return None


def configure_claude_mcp(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    """Write ~/.claude/settings.json MCP servers for this agent.

    The write is idempotent and removes previously managed plugin MCP entries
    before adding the fresh set, so removing a plugin really removes its tools
    from the next CLI spawn.
    """
    if not agent_user or not agent_id:
        return
    home = agent_user.get("home")
    if not home:
        return

    data = _fetch_agent_mcp(agent_id)
    if data is None:
        return

    settings_dir = os.path.join(home, ".claude")
    settings_path = os.path.join(settings_dir, "settings.json")
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
    except (OSError, json.JSONDecodeError):
        settings = {}

    mcp_servers = settings.setdefault("mcpServers", {})
    previous = settings.get(_MANAGED_KEY) or []
    for name in previous:
        if isinstance(name, str):
            mcp_servers.pop(name, None)

    incoming = data.get("mcpServers") if isinstance(data, dict) else {}
    if isinstance(incoming, dict):
        mcp_servers.update(incoming)
        settings[_MANAGED_KEY] = list(incoming.keys())
    else:
        settings[_MANAGED_KEY] = []

    settings["_pulsarMcpUpdatedAt"] = int(time.time())

    try:
        os.makedirs(settings_dir, mode=0o700, exist_ok=True)
        tmp = f"{settings_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
            f.write("\n")
        os.replace(tmp, settings_path)
        os.chmod(settings_path, 0o600)
        uid = agent_user.get("uid")
        gid = agent_user.get("gid", uid)
        if uid is not None:
            try:
                os.chown(settings_dir, uid, gid)
                os.chown(settings_path, uid, gid)
            except OSError:
                pass
        logger.info(
            f"[Runner MCP] configured {len(settings.get(_MANAGED_KEY) or [])} MCP server(s) "
            f"for agent {agent_id[:12]}"
        )
    except OSError as e:
        logger.warning(f"[Runner MCP] failed to write {settings_path}: {e}")
