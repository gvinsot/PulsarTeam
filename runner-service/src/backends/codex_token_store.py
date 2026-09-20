"""
Codex backend — Token persistence (per-owner) via team-api.

Mirrors claude_token_store.py but simplified: Codex auth.json has a complex
shape (multi-field, no simple access/refresh/expires triplet), so we
serialise the WHOLE blob and send it as the accessToken string. The api
stores it encrypted at rest.
"""

import os
import json
import time
from datetime import datetime
from typing import Optional, Tuple

import httpx

from config import logger
from swarm_secrets import read as read_secret
from .claude_token_store import run_blocking


_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_OWNER_TOKEN_PATH = "/api/internal/codex-tokens"
_HTTP_TIMEOUT = 3.0
_PERSIST_MAX_ATTEMPTS = 3
_PERSIST_BACKOFF = (0.5, 1.0)

_owner_blob_cache: dict = {}
_OWNER_BLOB_CACHE_TTL = 30


def _owner_headers() -> dict:
    return {"X-Api-Key": _API_KEY, "Content-Type": "application/json"}


def _fetch_owner_record(owner_id: str) -> Optional[dict]:
    cached = _owner_blob_cache.get(owner_id)
    if cached and time.time() - cached["fetched_at"] < _OWNER_BLOB_CACHE_TTL:
        return cached["blob"]
    url = f"{_API_BASE}{_OWNER_TOKEN_PATH}/{owner_id}"
    try:
        r = httpx.get(url, headers=_owner_headers(), timeout=_HTTP_TIMEOUT)
    except httpx.HTTPError as e:
        logger.warning(f"[Codex Owner Auth] api unreachable for {owner_id}: {e}")
        return None
    if r.status_code == 404:
        blob = None
    elif r.status_code >= 400:
        logger.warning(f"[Codex Owner Auth] api {r.status_code} fetching token for {owner_id}: {r.text[:200]}")
        return None
    else:
        try:
            payload = r.json()
        except ValueError:
            logger.warning(f"[Codex Owner Auth] non-JSON response for {owner_id}")
            return None
        raw = payload.get("accessToken") or ""
        try:
            blob = json.loads(raw) if raw else None
        except json.JSONDecodeError:
            logger.warning(f"[Codex Owner Auth] stored blob not valid JSON for {owner_id}")
            blob = None
    _owner_blob_cache[owner_id] = {"fetched_at": time.time(), "blob": blob}
    return blob


def _invalidate_owner_cache(owner_id: str):
    _owner_blob_cache.pop(owner_id, None)


def load_owner_blob(owner_id: str) -> Optional[dict]:
    if not owner_id:
        return None
    return _fetch_owner_record(owner_id)


def save_owner_blob(owner_id: str, blob: dict) -> bool:
    if not owner_id or not isinstance(blob, dict):
        return False
    payload = {"accessToken": json.dumps(blob, separators=(",", ":"))}
    url = f"{_API_BASE}{_OWNER_TOKEN_PATH}/{owner_id}"
    last_err = ""
    for attempt in range(_PERSIST_MAX_ATTEMPTS):
        try:
            r = httpx.post(url, json=payload, headers=_owner_headers(), timeout=_HTTP_TIMEOUT)
        except httpx.HTTPError as e:
            last_err = f"network: {e}"
        else:
            if r.status_code < 300:
                _invalidate_owner_cache(owner_id)
                logger.info(f"[Codex Owner Auth] Saved auth blob for owner {owner_id}")
                return True
            if r.status_code in (400, 401, 403):
                logger.error(f"[Codex Owner Auth] api {r.status_code} persisting token for {owner_id}: {r.text[:200]}")
                return False
            last_err = f"http {r.status_code}: {r.text[:200]}"
        if attempt < _PERSIST_MAX_ATTEMPTS - 1:
            time.sleep(_PERSIST_BACKOFF[attempt])
    logger.error(f"[Codex Owner Auth] Failed to persist token for {owner_id}: {last_err}")
    return False


def _blob_freshness(blob: Optional[dict]) -> float:
    """How recent a given auth.json blob is, as unix-seconds. Used to decide
    which of two copies of the SAME account's credentials wins.

    OpenAI rotates the refresh_token on every grant and revokes the one it
    replaces, so "newest wins" is not a nicety: handing a CLI an older copy
    hands it a token the rotation already killed, and the CLI reports
    "your refresh token was revoked".

    The access_token's `exp` claim is the authoritative ordering (it moves
    forward on every refresh); `last_refresh` is the fallback for blobs whose
    JWT can't be parsed. Returns 0.0 when neither is readable — an API-key
    blob has no ordering, so it never wins a comparison."""
    if not isinstance(blob, dict):
        return 0.0
    # Deferred: codex_oauth imports this module, so this can't be top-level.
    from .codex_oauth import access_token_expires_at

    try:
        exp = float(access_token_expires_at(blob))
    except Exception:
        exp = 0.0
    if exp:
        return exp
    last_refresh = blob.get("last_refresh") or ""
    try:
        return datetime.fromisoformat(last_refresh.replace("Z", "+00:00")).timestamp()
    except (AttributeError, TypeError, ValueError):
        return 0.0


def save_owner_blob_if_newer(owner_id: str, blob: dict) -> bool:
    """Persist `blob` only when the store doesn't already hold a fresher copy.

    The mirroring paths (terminal creds watcher, post-exec push-back,
    hydration) can each be holding a stale local auth.json — a replica that
    spawned before someone else's refresh, say. Pushing that back would
    replace a live refresh_token with a revoked one for every other consumer,
    so the store is kept monotonic and only explicit user actions (upload,
    OAuth login) may move it backwards via `save_owner_blob`.

    Returns True when the store ends up holding `blob` or something newer.
    """
    if not owner_id or not isinstance(blob, dict):
        return False
    _invalidate_owner_cache(owner_id)
    stored = _fetch_owner_record(owner_id)
    if isinstance(stored, dict):
        if stored == blob:
            return True
        if _blob_freshness(stored) > _blob_freshness(blob):
            logger.info(
                f"[Codex Owner Auth] Skipped push for owner {owner_id}: "
                f"the store already holds a fresher token"
            )
            return True
    return save_owner_blob(owner_id, blob)


def invalidate_owner_blob(owner_id: str):
    if not owner_id:
        return
    url = f"{_API_BASE}{_OWNER_TOKEN_PATH}/{owner_id}"
    try:
        r = httpx.delete(url, headers=_owner_headers(), timeout=_HTTP_TIMEOUT)
        if r.status_code >= 400 and r.status_code != 404:
            logger.warning(f"[Codex Owner Auth] api {r.status_code} deleting token for {owner_id}")
    except httpx.HTTPError as e:
        logger.warning(f"[Codex Owner Auth] api unreachable while deleting token for {owner_id}: {e}")
    _invalidate_owner_cache(owner_id)


_AUTH_FILE_MODE = 0o600
_AUTH_DIR_MODE = 0o700


def _resolve_codex_home(agent_user: Optional[dict]) -> str:
    codex_home = os.getenv("CODEX_HOME")
    if codex_home:
        return codex_home
    if agent_user:
        return os.path.join(agent_user["home"], ".codex")
    return os.path.expanduser("~/.codex")


def _ensure_dir(path: str, uid: Optional[int] = None, gid: Optional[int] = None):
    os.makedirs(path, mode=_AUTH_DIR_MODE, exist_ok=True)
    try:
        os.chmod(path, _AUTH_DIR_MODE)
    except OSError:
        pass
    if uid is not None and gid is not None:
        try:
            os.chown(path, uid, gid)
        except OSError:
            pass


def auth_file_path(agent_user: Optional[dict]) -> str:
    return os.path.join(_resolve_codex_home(agent_user), "auth.json")


def read_local_auth(agent_user: Optional[dict]) -> Tuple[Optional[dict], Optional[float]]:
    path = auth_file_path(agent_user)
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return None, None
    except OSError as e:
        logger.warning(f"[Codex Auth] cannot stat {path}: {e}")
        return None, None
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as e:
        logger.warning(f"[Codex Auth] cannot read {path}: {e}")
        return None, st.st_mtime
    return data, st.st_mtime


def write_local_auth(agent_user: Optional[dict], blob: dict) -> Optional[float]:
    path = auth_file_path(agent_user)
    uid = agent_user.get("uid") if agent_user else None
    gid = agent_user.get("gid") if agent_user else None
    _ensure_dir(os.path.dirname(path), uid=uid, gid=gid)
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _AUTH_FILE_MODE)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(blob, f, indent=2)
    except Exception:
        try: os.remove(tmp)
        except OSError: pass
        raise
    os.replace(tmp, path)
    try:
        os.chmod(path, _AUTH_FILE_MODE)
    except OSError:
        pass
    if uid is not None and gid is not None:
        try:
            os.chown(path, uid, gid)
        except OSError:
            pass
    try:
        return os.stat(path).st_mtime
    except OSError:
        return None


async def hydrate_agent_auth(agent_user: Optional[dict], owner_id: Optional[str]) -> bool:
    if not owner_id:
        return os.path.isfile(auth_file_path(agent_user))
    blob = await run_blocking(load_owner_blob, owner_id)
    if not blob:
        return os.path.isfile(auth_file_path(agent_user))
    current, _ = read_local_auth(agent_user)
    if current == blob:
        return True
    # Never hand the CLI an older copy than the one already on disk: the
    # local file may hold a refresh_token the CLI rotated after this replica
    # last pushed, and the rotation revoked the stored one. Mirror it up
    # instead — this is the path that catches a rotation the terminal's creds
    # watcher missed (container churn, watcher-less window).
    if isinstance(current, dict) and _blob_freshness(current) > _blob_freshness(blob):
        logger.info(
            f"[Codex Auth] Local auth.json is newer than the stored one for owner "
            f"{owner_id} — pushing the rotated token up instead of overwriting"
        )
        await run_blocking(save_owner_blob_if_newer, owner_id, current)
        return True
    try:
        await run_blocking(write_local_auth, agent_user, blob)
        logger.info(f"[Codex Auth] Hydrated auth.json for owner {owner_id}")
        return True
    except OSError as e:
        logger.error(f"[Codex Auth] Failed to write auth.json for {owner_id}: {e}")
        return False


async def push_agent_auth_if_changed(agent_user: Optional[dict], owner_id: Optional[str], baseline_mtime: Optional[float]) -> bool:
    if not owner_id:
        return False
    current, mtime = read_local_auth(agent_user)
    if current is None or mtime is None:
        return False
    if baseline_mtime is not None and mtime <= baseline_mtime:
        return False
    return await run_blocking(save_owner_blob_if_newer, owner_id, current)


# --- Auth status helpers (used by the backend's auth_status endpoints) -------

def auth_method_for_blob(blob: Optional[dict]) -> str:
    """Return 'oauth' if a ChatGPT-plan OAuth token is present in the blob,
    'api_key' if only an OPENAI_API_KEY is set, 'none' otherwise."""
    if not isinstance(blob, dict):
        return "none"
    tokens = blob.get("tokens") or {}
    if isinstance(tokens, dict) and tokens.get("access_token"):
        return "oauth"
    if blob.get("OPENAI_API_KEY"):
        return "api_key"
    return "none"


def global_auth_method() -> str:
    """Detect the global codex auth method by inspecting ~/.codex/auth.json
    and the OPENAI_API_KEY env var."""
    blob, _ = read_local_auth(None)
    method = auth_method_for_blob(blob)
    if method != "none":
        return method
    if os.getenv("OPENAI_API_KEY"):
        return "api_key"
    return "none"


async def hydrate_owner_blob_async(owner_id: str) -> Optional[dict]:
    """Async wrapper over `load_owner_blob` so route handlers don't block
    on the team-api HTTP call."""
    return await run_blocking(load_owner_blob, owner_id)

