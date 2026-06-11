"""
Persist/restore a CLI runner's on-disk config files via team-api.

Stateless runners lose the agent HOME on restart, so config a user sets up
INSIDE the terminal (e.g. `hermes setup` → ~/.hermes/{config.yaml,.env}) is gone
on the next spawn — hence the "no providers found" wizard loop. This module
saves those files to team-api (encrypted at rest) and restores them on spawn.

Mirrors claude_token_store: shared CODER_API_KEY, httpx, short fetch cache, a
few retries on save. `files` is a plain dict {relative_path: text_content}.
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
_PATH = "/api/internal/runner-config"
_HTTP_TIMEOUT = 4.0
_SAVE_MAX_ATTEMPTS = 3
_SAVE_BACKOFF = (0.5, 1.0)
_FETCH_MAX_ATTEMPTS = 3
_FETCH_BACKOFF = (0.5, 1.0)

_cache: dict = {}
_CACHE_TTL = 15.0  # seconds


def _headers() -> dict:
    return {"X-Api-Key": _API_KEY, "Content-Type": "application/json"}


def fetch_runner_config(runner: str, agent_id: str, force: bool = False) -> Optional[dict]:
    """Return {relative_path: content} for the agent, or None if none saved.

    Cached briefly per (runner, agent_id). Transient failures (network, 5xx)
    are retried with a short backoff and NOT cached, so the next call tries
    again. Never raises.
    """
    if not runner or not agent_id or not _API_KEY:
        return None
    key = f"{runner}:{agent_id}"
    cached = _cache.get(key)
    if not force and cached and time.monotonic() - cached["fetched_at"] < _CACHE_TTL:
        return cached["value"]
    url = f"{_API_BASE}{_PATH}/{runner}/agents/{agent_id}"
    last_err = ""
    for attempt in range(_FETCH_MAX_ATTEMPTS):
        try:
            r = httpx.get(url, headers=_headers(), timeout=_HTTP_TIMEOUT)
        except httpx.HTTPError as e:
            last_err = f"network: {e}"
        else:
            if r.status_code >= 500:
                last_err = f"http {r.status_code}: {r.text[:200]}"
            else:
                value: Optional[dict] = None
                if r.status_code == 404:
                    value = None
                elif r.status_code >= 400:
                    logger.warning(f"[Runner Config] api {r.status_code} for {key}: {r.text[:200]}")
                    value = None
                else:
                    try:
                        data = r.json()
                    except ValueError:
                        data = None
                    files = data.get("files") if isinstance(data, dict) else None
                    if isinstance(files, dict):
                        value = {k: v for k, v in files.items() if isinstance(k, str) and isinstance(v, str)}
                    else:
                        value = None
                _cache[key] = {"fetched_at": time.monotonic(), "value": value}
                return value
        if attempt < _FETCH_MAX_ATTEMPTS - 1:
            time.sleep(_FETCH_BACKOFF[attempt])
    logger.warning(f"[Runner Config] failed to fetch {key} after {_FETCH_MAX_ATTEMPTS} attempts: {last_err}")
    return None


def save_runner_config(runner: str, agent_id: str, files: dict) -> bool:
    """Persist {relative_path: content} for the agent via team-api. Retries on
    transient failures. Returns True on success. Never raises on network error."""
    if not runner or not agent_id or not _API_KEY:
        return False
    clean = {k: v for k, v in (files or {}).items() if isinstance(k, str) and isinstance(v, str)}
    if not clean:
        return False
    url = f"{_API_BASE}{_PATH}/{runner}/agents/{agent_id}"
    last_err = ""
    for attempt in range(_SAVE_MAX_ATTEMPTS):
        try:
            r = httpx.put(url, json={"files": clean}, headers=_headers(), timeout=_HTTP_TIMEOUT)
        except httpx.HTTPError as e:
            last_err = f"network: {e}"
        else:
            if r.status_code < 300:
                _cache.pop(f"{runner}:{agent_id}", None)
                return True
            if r.status_code in (400, 401, 403):
                logger.error(f"[Runner Config] api {r.status_code} saving {runner}:{agent_id} (not retrying): {r.text[:200]}")
                return False
            last_err = f"http {r.status_code}: {r.text[:200]}"
        if attempt < _SAVE_MAX_ATTEMPTS - 1:
            time.sleep(_SAVE_BACKOFF[attempt])
    logger.warning(f"[Runner Config] failed to save {runner}:{agent_id} after {_SAVE_MAX_ATTEMPTS} attempts: {last_err}")
    return False
