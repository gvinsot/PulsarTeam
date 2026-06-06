"""
Re-hydrate a CLI agent's selected LLM config from team-api at spawn time.

The per-agent LLM config normally arrives via the `X-LLM-Config` request header
(routes_api / routes_terminal -> CliBackend.set_agent_llm_config) and lives ONLY
in the in-process `_llm_configs` cache. That cache is lost when the runner
process or its container restarts, so a CLI session re-spawned after a restart
(a tmux terminal reattach, or a task pasted into an idle runner) would fall back
to the static RUNNER_MODEL env — which is why hermes reverted to its default
model after every restart.

This module fetches the same resolved config the API forwards in the header,
keyed by agent_id, so `_get_llm_config` can rebuild the cache on a miss. Because
team-api resolves it via `agentManager.resolveLlmConfig`, the agent's legacy
`provider`/`model` fields are honored too (not just a named `llmConfigId`).

Mirrors fallback_llm_resolver / runner_mcp_config: shared CODER_API_KEY, short
TTL cache so we don't hit the api on every spawn. A `None` result means "no
per-agent selection" and the caller keeps using the RUNNER_MODEL default.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import httpx
from swarm_secrets import read as read_secret

from config import logger

_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH = "/api/internal/runner-llm/agents"

_CACHE: dict = {}
_CACHE_TTL = 30.0  # seconds


def _fetch(agent_id: str) -> Optional[dict]:
    url = f"{_API_BASE}{_PATH}/{agent_id}"
    try:
        r = httpx.get(url, headers={"X-Api-Key": _API_KEY}, timeout=3.0)
    except httpx.HTTPError as e:
        logger.warning(f"[Runner LLM] api unreachable for agent {agent_id[:12]}: {e}")
        return None
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        logger.warning(f"[Runner LLM] api {r.status_code} for agent {agent_id[:12]}: {r.text[:200]}")
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    if not isinstance(data, dict) or not data.get("configured"):
        return None
    model = (data.get("model") or "").strip()
    if not model:
        return None
    cfg = {
        "provider": (data.get("provider") or "").strip(),
        "model": model,
        # Keep camelCase to match the X-LLM-Config header shape that
        # set_agent_llm_config caches and that _agent_env / the backends read.
        "apiKey": (data.get("apiKey") or "").strip(),
        "endpoint": (data.get("endpoint") or "").strip(),
    }
    logger.info(
        f"[Runner LLM] hydrated agent {agent_id[:12]} model={model} "
        f"provider={cfg['provider'] or '-'} (in-memory cache miss / restart)"
    )
    return cfg


def fetch_agent_llm_config(agent_id: str) -> Optional[dict]:
    """Return ``{provider, model, apiKey, endpoint}`` for the agent, or None.

    Cached per agent for ``_CACHE_TTL`` seconds. None means there is no
    per-agent selection and the caller should keep using RUNNER_MODEL.
    """
    if not agent_id or not _API_KEY:
        return None
    cached = _CACHE.get(agent_id)
    if cached and time.monotonic() - cached["fetched_at"] < _CACHE_TTL:
        return cached["value"]
    value = _fetch(agent_id)
    _CACHE[agent_id] = {"fetched_at": time.monotonic(), "value": value}
    return value


def invalidate(agent_id: str) -> None:
    _CACHE.pop(agent_id, None)
