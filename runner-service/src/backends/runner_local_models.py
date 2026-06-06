"""
Fetch the operator's local (vLLM / Ollama) LLM configs from team-api.

Multi-provider CLI runners (opencode/hermes/openclaw/aider) inject these local
models into their on-disk config at spawn so the models are reachable — and, for
opencode, switchable in the TUI — alongside the agent's Settings-selected
default. Mirrors runner_llm_config / fallback_llm_resolver: shared CODER_API_KEY,
short TTL cache.

Returns a list of ``{id, name, provider, model, endpoint, apiKey}`` dicts (empty
list on any failure — injection is best-effort and never blocks a spawn).
"""

from __future__ import annotations

import os
import time
from typing import List

import httpx
from swarm_secrets import read as read_secret

from config import logger

_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH = "/api/internal/runner-llm/local-models"

_CACHE: dict = {"fetched_at": 0.0, "value": []}
_CACHE_TTL = 30.0  # seconds


def _fetch() -> List[dict]:
    url = f"{_API_BASE}{_PATH}"
    try:
        r = httpx.get(url, headers={"X-Api-Key": _API_KEY}, timeout=3.0)
    except httpx.HTTPError as e:
        logger.warning(f"[Runner LLM] local-models api unreachable: {e}")
        return []
    if r.status_code >= 400:
        logger.warning(f"[Runner LLM] local-models api {r.status_code}: {r.text[:200]}")
        return []
    try:
        data = r.json()
    except ValueError:
        return []
    models = data.get("models") if isinstance(data, dict) else None
    out: List[dict] = []
    for m in models or []:
        if not isinstance(m, dict):
            continue
        model = (m.get("model") or "").strip()
        provider = (m.get("provider") or "").strip().lower()
        if not model or not provider:
            continue
        out.append({
            "id": m.get("id") or "",
            "name": (m.get("name") or "").strip(),
            "provider": provider,
            "model": model,
            "endpoint": (m.get("endpoint") or "").strip(),
            # camelCase to match the X-LLM-Config / _llm_configs shape.
            "apiKey": (m.get("apiKey") or "").strip(),
        })
    return out


def fetch_local_models() -> List[dict]:
    """Return the operator's local (vLLM/Ollama) LLM configs, cached for TTL.

    Always returns a list (possibly empty); never raises.
    """
    if not _API_KEY:
        return []
    if time.monotonic() - _CACHE["fetched_at"] < _CACHE_TTL:
        return _CACHE["value"]
    value = _fetch()
    _CACHE["fetched_at"] = time.monotonic()
    _CACHE["value"] = value
    return value
