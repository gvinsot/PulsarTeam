"""
Resolve the "fallback LLM" used by the Claude interactive driver.

Priority:
  1. Explicit env vars (CLAUDE_FALLBACK_LLM_URL/KEY/MODEL) — operator override.
  2. Admin-configured selection (settings.claudeFallbackLlmConfigId in team-api).
  3. None — the driver falls back to safe hardcoded answers ("y" / "1").

The team-api selection is fetched from /api/internal/runner-llm/claude-fallback
using the shared CODER_API_KEY and cached for 60s so we don't hit the api on
every interactive prompt.
"""

from __future__ import annotations

import os
import time
from typing import Optional

import httpx
from swarm_secrets import read as read_secret

from config import (
    CLAUDE_FALLBACK_LLM_URL,
    CLAUDE_FALLBACK_LLM_KEY,
    CLAUDE_FALLBACK_LLM_MODEL,
    logger,
)

_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH = "/api/internal/runner-llm/claude-fallback"

_CACHE: dict = {"fetched_at": 0.0, "value": None}
_CACHE_TTL = 60.0


def _from_env() -> Optional[dict]:
    if CLAUDE_FALLBACK_LLM_URL and CLAUDE_FALLBACK_LLM_KEY:
        return {
            "endpoint": CLAUDE_FALLBACK_LLM_URL,
            "apiKey": CLAUDE_FALLBACK_LLM_KEY,
            "model": CLAUDE_FALLBACK_LLM_MODEL or "gpt-4o-mini",
            "source": "env",
        }
    return None


def _fetch_from_api() -> Optional[dict]:
    if not _API_KEY:
        return None
    url = f"{_API_BASE}{_PATH}"
    try:
        r = httpx.get(
            url,
            headers={"X-Api-Key": _API_KEY},
            timeout=3.0,
        )
    except httpx.HTTPError as e:
        logger.warning(f"[Fallback LLM] api unreachable: {e}")
        return None
    if r.status_code >= 400:
        logger.warning(f"[Fallback LLM] api {r.status_code}: {r.text[:200]}")
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    if not data.get("configured"):
        return None
    endpoint = (data.get("endpoint") or "").strip()
    api_key = (data.get("apiKey") or "").strip()
    model = (data.get("model") or "").strip()
    if not endpoint or not api_key or not model:
        return None
    return {
        "endpoint": endpoint,
        "apiKey": api_key,
        "model": model,
        "source": "admin-setting",
    }


def resolve_fallback_llm(force_refresh: bool = False) -> Optional[dict]:
    """Return the resolved fallback LLM config or None.

    The cached result is shared across calls within _CACHE_TTL seconds.
    Env vars always win and are returned without hitting the api.
    """
    env_cfg = _from_env()
    if env_cfg:
        return env_cfg

    if not force_refresh and (time.monotonic() - _CACHE["fetched_at"] < _CACHE_TTL):
        return _CACHE["value"]

    cfg = _fetch_from_api()
    _CACHE["fetched_at"] = time.monotonic()
    _CACHE["value"] = cfg
    return cfg
