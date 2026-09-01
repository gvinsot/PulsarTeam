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

from agent_user import resolve_agent_home
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


class PersistedConfigMixin:
    """Give a backend "the config the user set in the terminal survives a
    restart" for the cost of one class attribute.

    Runners are stateless: `/app/data` is not volumed, so the agent HOME — and
    with it whatever the user chose inside the TUI, above all their model — is
    gone on the next boot. Backends list the files that hold those choices in
    `persisted_config_files`; this mixin restores them before every spawn and
    hands `prepare_interactive` the PtySession watcher hooks that save them back
    whenever the terminal changes them.

    Two rules for what belongs in the list:
      • only files the CLI writes on the USER's behalf — never one the runner
        regenerates wholesale each spawn (opencode's config.json, openclaw's
        exec-approvals.json), which would just fight itself;
      • strip any runner-managed content via `_sanitize_persisted_config`, so a
        revoked permission or a stale MCP token can't be resurrected from the
        saved copy.

    The stored key is the file's BASENAME — that is what PtySession's watcher
    reports — so a backend's paths must have distinct basenames.
    """

    # Paths relative to the agent HOME.
    persisted_config_files: tuple[str, ...] = ()

    def _sanitize_persisted_config(self, name: str, raw: str) -> Optional[str]:
        """Strip runner-managed content from `raw` before it is persisted.
        `name` is the file's basename. Return None to skip saving it entirely.
        Default: persist verbatim."""
        return raw

    def _persisted_config_paths(
        self, agent_user: Optional[dict], agent_id: Optional[str],
    ) -> list:
        if not self.persisted_config_files or not agent_id:
            return []
        home, _, _ = resolve_agent_home(agent_user, agent_id)
        if not home:
            return []
        return [os.path.join(home, rel) for rel in self.persisted_config_files]

    def _restore_persisted_config(
        self, agent_user: Optional[dict], agent_id: Optional[str],
    ) -> None:
        """Write the agent's saved config files back into its HOME.

        Runs on every spawn — interactive AND headless — so a stateless restart
        cannot silently reset the model the user chose in the terminal.

        Skipped while a terminal session is live: the user may have just changed
        the model inside the PTY, and fetch_runner_config is cached for 15 s, so
        restoring here could overwrite the fresh file with stale content — which
        the session's own live-sync would then persist back as the truth.
        """
        if not agent_id or not self.persisted_config_files:
            return
        try:
            from pty_session import get_session
            if get_session(agent_id) is not None:
                return
        except ImportError:
            pass
        files = fetch_runner_config(self.name, agent_id)
        if not files:
            return
        home, uid, gid = resolve_agent_home(agent_user, agent_id)
        if not home:
            return
        written = []
        for rel in self.persisted_config_files:
            content = files.get(os.path.basename(rel))
            if not content:
                continue
            path = os.path.join(home, rel)
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
            except OSError as e:
                logger.warning(f"[{self.name} Config] failed to restore {path}: {e}")
                continue
            if uid is not None:
                eff_gid = gid if gid is not None else uid
                for target in (os.path.dirname(path), path):
                    try:
                        os.chown(target, uid, eff_gid)
                    except OSError:
                        pass
                try:
                    os.chmod(path, 0o600)
                except OSError:
                    pass
            written.append(os.path.basename(rel))
        if written:
            logger.info(
                f"[{self.name} Config] restored {', '.join(written)} "
                f"for agent {agent_id[:12]}"
            )

    def _config_persistence_extras(
        self, agent_id: Optional[str], agent_user: Optional[dict],
    ) -> dict:
        """The PtySession watcher hooks that persist `persisted_config_files`
        to team-api whenever the terminal changes them. Merge into the recipe
        returned by `prepare_interactive`."""
        paths = self._persisted_config_paths(agent_user, agent_id)
        if not paths:
            return {}
        runner = self.name
        captured_agent_id = agent_id

        def _persist(files: dict) -> None:
            clean = {}
            for name, raw in (files or {}).items():
                sanitized = self._sanitize_persisted_config(name, raw)
                if sanitized:
                    clean[name] = sanitized
            if not clean:
                return
            # Raise on failure so the watcher does NOT advance its signature and
            # retries the sync on the next poll tick.
            if not save_runner_config(runner, captured_agent_id, clean):
                raise RuntimeError(
                    f"save_runner_config failed for {runner} agent {captured_agent_id}"
                )

        return {"files_watch_paths": paths, "files_on_change": _persist}
