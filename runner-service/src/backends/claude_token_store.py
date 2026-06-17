"""
Claude Code backend — Token persistence (global, per-agent, per-owner).
"""

import os
import re
import json
import stat
import time
import asyncio
import functools
import subprocess
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

from config import (
    DATA_DIR, USERS_DIR,
    TOKEN_FILE, TOKEN_JSON_FILE, CREDENTIALS_FILE,
    OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, OAUTH_SCOPES,
    logger,
)
from swarm_secrets import read as read_secret
from .crypto import encrypt_text, decrypt_text


# --- Off-loop execution helper --------------------------------------------------
#
# Several helpers in this module (and the sibling runner_* config modules) make
# blocking httpx calls to team-api, with retry sleeps. They stay synchronous
# because threaded callers (e.g. PtySession's creds_on_change) invoke them
# directly — async code must instead run them off the event loop via
# run_blocking, otherwise every other agent's stream stalls while team-api is
# slow. A dedicated pool is used (not the default executor) because the default
# one is parked by long-lived PTY driver threads (run_interactive holds one
# thread per interactive session for its whole duration).

_io_executor = ThreadPoolExecutor(max_workers=8, thread_name_prefix="runner-io")


async def run_blocking(func, *args, **kwargs):
    """Run a short blocking helper on the dedicated I/O thread pool."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_io_executor, functools.partial(func, *args, **kwargs))


# --- Filesystem helpers -------------------------------------------------------

_FILE_MODE = 0o600
_DIR_MODE = 0o700
# Shared parent dirs that per-agent UIDs must be able to traverse (but not
# list) to reach their own HOME. Keys are absolute paths.
_TRAVERSE_DIRS = frozenset({"/app/data", "/app/data/agents"})


def _secure_makedirs(path: str):
    # Per-agent UIDs need traverse (x) on shared parent dirs to reach their
    # own HOME; otherwise the spawned CLI dies with EACCES on every fs op.
    if path in _TRAVERSE_DIRS:
        os.makedirs(path, mode=0o711, exist_ok=True)
        try:
            os.chmod(path, 0o711)
        except OSError:
            pass
        return
    os.makedirs(path, mode=_DIR_MODE, exist_ok=True)
    try:
        os.chmod(path, _DIR_MODE)
    except OSError:
        pass


def _atomic_write_secret(path: str, content: str, encrypt: bool = True):
    """Write `content` to `path` atomically with mode 0600.

    If `encrypt` is True (default) the content is AES-GCM-encrypted before
    being written. Set `encrypt=False` for files that are consumed by
    third-party tools (e.g. ~/.claude/.credentials.json read directly by the
    Claude Code CLI), where the on-disk format is fixed.
    """
    _secure_makedirs(os.path.dirname(path))
    payload = encrypt_text(content) if encrypt else content
    tmp = f"{path}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, _FILE_MODE)
    try:
        with os.fdopen(fd, "w") as f:
            f.write(payload)
    except Exception:
        try: os.remove(tmp)
        except OSError: pass
        raise
    os.replace(tmp, path)
    try:
        os.chmod(path, _FILE_MODE)
    except OSError:
        pass


def _read_secret(path: str) -> Optional[str]:
    """Read and decrypt the AES-GCM envelope at `path`. Returns the plaintext
    content, or None if the file doesn't exist or cannot be decrypted (not an
    envelope, rotated/unmounted ENCRYPTION_KEY, corrupted file)."""
    try:
        with open(path) as f:
            raw = f.read()
    except (OSError, FileNotFoundError):
        return None
    try:
        return decrypt_text(raw)
    except Exception as e:
        # Treat an undecryptable file as a missing token so callers fall back
        # to the re-auth flow instead of crashing the runner. If ENCRYPTION_KEY
        # is merely unmounted, remount it rather than re-logging-in (a re-login
        # while the key is absent rewrites tokens in plaintext).
        logger.error(f"[Crypto] Cannot decrypt {path} — treating as missing: {e}")
        return None


def _read_secret_json(path: str) -> Optional[dict]:
    raw = _read_secret(path)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def _read_plain_json(path: str) -> Optional[dict]:
    """Read a plaintext JSON file — one written with encrypt=False because it
    is consumed directly by the Claude Code CLI (.credentials.json)."""
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


# --- Rate limiting ------------------------------------------------------------

_token_request_lock = asyncio.Lock()
_token_cooldown_until: float = 0


def get_token_cooldown_until() -> float:
    return _token_cooldown_until


def set_token_cooldown_until(value: float):
    global _token_cooldown_until
    _token_cooldown_until = value


# =============================================================================
# Global token storage
# =============================================================================

def _restore_credentials_file(oauth_data: dict):
    try:
        creds = _read_plain_json(CREDENTIALS_FILE) or {}
        creds["claudeAiOauth"] = oauth_data
        # NOT encrypted: this file is consumed directly by the Claude Code CLI.
        _atomic_write_secret(CREDENTIALS_FILE, json.dumps(creds, indent=2), encrypt=False)
        logger.info("Restored credentials.json from persistent OAuth data")
    except Exception as e:
        logger.warning(f"Failed to restore credentials.json: {e}")


def load_saved_token() -> Optional[str]:
    token = read_secret("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if token:
        return token
    oauth_data = _read_secret_json(TOKEN_JSON_FILE)
    if oauth_data:
        token = oauth_data.get("accessToken")
        if token:
            _restore_credentials_file(oauth_data)
            return token
    raw = _read_secret(TOKEN_FILE)
    if raw and raw.strip():
        return raw.strip()
    creds = _read_plain_json(CREDENTIALS_FILE)
    if creds:
        token = creds.get("claudeAiOauth", {}).get("accessToken")
        if token:
            return token
    return None


def save_token(token: str, refresh_token: Optional[str] = None, expires_in: int = 28800):
    _secure_makedirs(DATA_DIR)
    _atomic_write_secret(TOKEN_FILE, token)
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    _atomic_write_secret(TOKEN_JSON_FILE, json.dumps(oauth_data, indent=2))
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token

    creds = _read_plain_json(CREDENTIALS_FILE) or {}
    creds["claudeAiOauth"] = oauth_data
    # NOT encrypted: this file is consumed directly by the Claude Code CLI.
    _atomic_write_secret(CREDENTIALS_FILE, json.dumps(creds, indent=2), encrypt=False)
    logger.info("OAuth token saved (token file + token.json + credentials.json)")


def invalidate_global_token():
    for path in (TOKEN_FILE, TOKEN_JSON_FILE, CREDENTIALS_FILE):
        try:
            os.remove(path)
        except OSError:
            pass
    os.environ.pop("CLAUDE_CODE_OAUTH_TOKEN", None)
    logger.info("[Auth] Cleared invalid global OAuth tokens")


def is_token_expired(margin_seconds: int = 300) -> bool:
    oauth_data = _read_secret_json(TOKEN_JSON_FILE)
    if not oauth_data:
        return True
    expires_at_ms = oauth_data.get("expiresAt", 0)
    if not expires_at_ms:
        return False
    return time.time() >= (expires_at_ms / 1000) - margin_seconds


def get_saved_refresh_token() -> Optional[str]:
    oauth_data = _read_secret_json(TOKEN_JSON_FILE)
    return (oauth_data or {}).get("refreshToken") or None


# =============================================================================
# Per-owner token storage (DB-backed via team-api)
# =============================================================================
#
# Tokens are stored centrally in the api's `oauth_tokens` table (encrypted at
# rest by api/src/lib/crypto.ts). The runner talks to the api over HTTP using
# the shared CODER_API_KEY. This lets prod and QA stacks share the same token
# pool when they point at the same database.

import httpx

_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
# Runner and team-api share the same CODER_API_KEY (Docker secret mounted at
# /run/secrets/CODER_API_KEY). The runner uses it both to verify incoming
# requests from team-api (see security.py) and to authenticate its own calls
# back to team-api for owner-token persistence.
_API_KEY = read_secret("CODER_API_KEY", default="")
_OWNER_TOKEN_PATH = "/api/internal/claude-tokens"
_HTTP_TIMEOUT = 3.0
_PERSIST_MAX_ATTEMPTS = 3
_PERSIST_BACKOFF = (0.5, 1.0)  # delays AFTER attempts 1 and 2

# Short-lived cache so repeated calls within one exec don't all hit the api.
# Accessed from both the event loop and run_blocking's executor threads —
# restricted to single dict get/set/pop operations, which are GIL-atomic.
_owner_token_cache: dict = {}
_OWNER_TOKEN_CACHE_TTL = 30  # seconds


def _owner_headers() -> dict:
    return {"X-Api-Key": _API_KEY, "Content-Type": "application/json"}


def _fetch_owner_record(owner_id: str, force: bool = False) -> Optional[dict]:
    """Fetch `{accessToken, refreshToken, expiresAt}` from the api or None on 404.

    Uses a 30s in-process cache to avoid round-trips during a single exec.
    Pass `force=True` to bypass that cache — used by credential seeding to
    survive a stale cache / transient team-api hiccup during a restart window.
    Network/server errors return None so callers fall back to the login flow.
    """
    cached = _owner_token_cache.get(owner_id)
    if not force and cached and time.time() - cached["fetched_at"] < _OWNER_TOKEN_CACHE_TTL:
        return cached["record"]
    url = f"{_API_BASE}{_OWNER_TOKEN_PATH}/{owner_id}"
    try:
        r = httpx.get(url, headers=_owner_headers(), timeout=_HTTP_TIMEOUT)
    except httpx.HTTPError as e:
        logger.warning(f"[Owner Auth] api unreachable for owner {owner_id}: {e}")
        return None
    if r.status_code == 404:
        record = None
    elif r.status_code >= 400:
        logger.warning(f"[Owner Auth] api {r.status_code} fetching token for {owner_id}: {r.text[:200]}")
        return None
    else:
        try:
            record = r.json()
        except ValueError:
            logger.warning(f"[Owner Auth] api returned non-JSON for owner {owner_id}")
            return None
    _owner_token_cache[owner_id] = {"fetched_at": time.time(), "record": record}
    return record


def _invalidate_owner_cache(owner_id: str):
    _owner_token_cache.pop(owner_id, None)


def load_owner_token(owner_id: str) -> Optional[str]:
    if not owner_id:
        return None
    record = _fetch_owner_record(owner_id)
    return (record or {}).get("accessToken") or None


def save_owner_token(owner_id: str, token: str, refresh_token: Optional[str] = None, expires_in: int = 28800) -> bool:
    """Persist owner OAuth token via team-api. Returns True on success.

    Retries on transient failures (network errors, 5xx, 404 during a rolling
    team-api update, 408/429 rate-limit). Does NOT retry on 400/401/403 — those
    indicate a definitive client-side issue (bad key, malformed payload).
    """
    if not owner_id:
        return False
    payload = {
        "accessToken": token,
        "refreshToken": refresh_token or None,
        "expiresIn": expires_in,
    }
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
                logger.info(f"[Owner Auth] Saved OAuth token for owner {owner_id}")
                return True
            if r.status_code in (400, 401, 403):
                logger.error(
                    f"[Owner Auth] api {r.status_code} persisting token for {owner_id} "
                    f"(not retrying — fix CODER_API_KEY / payload): {r.text[:200]}"
                )
                return False
            last_err = f"http {r.status_code}: {r.text[:200]}"
        if attempt < _PERSIST_MAX_ATTEMPTS - 1:
            delay = _PERSIST_BACKOFF[attempt]
            logger.warning(
                f"[Owner Auth] Persist attempt {attempt+1}/{_PERSIST_MAX_ATTEMPTS} failed for "
                f"{owner_id} ({last_err}); retrying in {delay}s"
            )
            time.sleep(delay)
    logger.error(
        f"[Owner Auth] Failed to persist token for owner {owner_id} after "
        f"{_PERSIST_MAX_ATTEMPTS} attempts: {last_err}"
    )
    return False


def invalidate_owner_token(owner_id: str):
    if not owner_id:
        return
    url = f"{_API_BASE}{_OWNER_TOKEN_PATH}/{owner_id}"
    try:
        r = httpx.delete(url, headers=_owner_headers(), timeout=_HTTP_TIMEOUT)
        if r.status_code >= 400 and r.status_code != 404:
            logger.warning(f"[Owner Auth] api {r.status_code} deleting token for {owner_id}")
    except httpx.HTTPError as e:
        logger.warning(f"[Owner Auth] api unreachable while deleting token for {owner_id}: {e}")
    _invalidate_owner_cache(owner_id)
    logger.info(f"[Owner Auth] Cleared invalid token for owner {owner_id}")


def is_owner_token_expired(owner_id: str, margin_seconds: int = 300) -> bool:
    if not owner_id:
        return False
    record = _fetch_owner_record(owner_id)
    if not record:
        return False
    expires_at_ms = record.get("expiresAt") or 0
    if not expires_at_ms:
        return False
    return time.time() >= (expires_at_ms / 1000) - margin_seconds


def get_owner_refresh_token(owner_id: str) -> Optional[str]:
    if not owner_id:
        return None
    record = _fetch_owner_record(owner_id)
    return (record or {}).get("refreshToken") or None


# =============================================================================
# Per-agent token storage
# =============================================================================

def load_agent_token(agent_user: dict) -> Optional[str]:
    if not agent_user:
        return None
    owner_id = agent_user.get("owner_id")
    if owner_id:
        token = load_owner_token(owner_id)
        if token:
            return token
    home = agent_user["home"]
    agent_token_json = os.path.join(home, "oauth_token.json")
    data = _read_secret_json(agent_token_json)
    if data:
        token = data.get("accessToken")
        if token:
            return token
    # `.credentials.json` is consumed by the Claude Code CLI directly — leave it plaintext.
    agent_creds = os.path.join(home, ".claude", ".credentials.json")
    creds = _read_plain_json(agent_creds)
    if creds:
        token = creds.get("claudeAiOauth", {}).get("accessToken")
        if token:
            return token
    return None


def save_agent_token(agent_user: dict, token: str, refresh_token: Optional[str] = None, expires_in: int = 28800) -> bool:
    """Persist agent token. Forwards to owner DB store when owner_id is set,
    otherwise writes to per-agent files. Returns True on success."""
    owner_id = agent_user.get("owner_id")
    if owner_id:
        return save_owner_token(owner_id, token, refresh_token=refresh_token, expires_in=expires_in)
    home = agent_user["home"]
    _secure_makedirs(home)
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    _atomic_write_secret(os.path.join(home, "oauth_token.json"), json.dumps(oauth_data, indent=2))
    agent_creds_file = os.path.join(home, ".claude", ".credentials.json")
    creds = _read_plain_json(agent_creds_file) or {}
    creds["claudeAiOauth"] = oauth_data
    # NOT encrypted: this file is consumed directly by the Claude Code CLI.
    _atomic_write_secret(agent_creds_file, json.dumps(creds, indent=2), encrypt=False)
    logger.info(f"[Agent Auth] Saved OAuth token for agent {agent_user['username']}")
    return True


def invalidate_agent_token(agent_user: dict):
    if not agent_user:
        return
    owner_id = agent_user.get("owner_id")
    if owner_id:
        invalidate_owner_token(owner_id)
        return
    home = agent_user.get("home")
    if not home:
        return
    token_file = os.path.join(home, "oauth_token.json")
    try:
        os.remove(token_file)
        logger.info(f"[Agent Auth] Cleared invalid token for {agent_user['username']}")
    except OSError:
        pass
    creds_file = os.path.join(home, ".claude", ".credentials.json")
    try:
        os.remove(creds_file)
    except OSError:
        pass


def is_agent_token_expired(agent_user: dict, margin_seconds: int = 300) -> bool:
    if not agent_user:
        return False
    owner_id = agent_user.get("owner_id")
    if owner_id:
        return is_owner_token_expired(owner_id, margin_seconds)
    agent_token_json = os.path.join(agent_user["home"], "oauth_token.json")
    data = _read_secret_json(agent_token_json)
    if not data:
        # Legacy / direct-CLI login fallback: Claude writes this plaintext file
        # itself, and older sessions may not have the encrypted oauth_token.json
        # mirror yet. Use its expiry so proactive refresh still works.
        creds = _read_plain_json(os.path.join(agent_user["home"], ".claude", ".credentials.json"))
        data = (creds or {}).get("claudeAiOauth") or {}
    if not data:
        return False
    expires_at_ms = data.get("expiresAt", 0)
    if not expires_at_ms:
        return False
    return time.time() >= (expires_at_ms / 1000) - margin_seconds


def get_agent_refresh_token(agent_user: dict) -> Optional[str]:
    if not agent_user:
        return None
    agent_token_json = os.path.join(agent_user["home"], "oauth_token.json")
    data = _read_secret_json(agent_token_json)
    refresh = (data or {}).get("refreshToken")
    if refresh:
        return refresh
    # Same fallback as is_agent_token_expired: direct `claude /login` writes the
    # refresh token to the CLI credentials file first; mirror/watchdog sync can
    # lag or be absent for legacy homes.
    creds = _read_plain_json(os.path.join(agent_user["home"], ".claude", ".credentials.json"))
    return ((creds or {}).get("claudeAiOauth") or {}).get("refreshToken") or None


def resolve_token(agent_user: dict) -> Optional[str]:
    owner_id = agent_user.get("owner_id") if agent_user else None
    if owner_id:
        token = load_owner_token(owner_id)
        if token:
            return token
    return load_agent_token(agent_user)


def seed_onboarding_state(agent_user: dict) -> bool:
    """Pre-populate `~/.claude.json` with the flags the Claude Code CLI 2.1+
    normally writes after a successful first-run OAuth login. Without these
    flags the TUI shows its onboarding sequence (theme picker → "Select
    login method" → OAuth browser flow) that the PTY driver can't satisfy
    even with a valid token in env vars.

    Flags seeded:
      - hasCompletedOnboarding=true   → skips theme picker + login-method
                                        picker + OAuth flow
      - hasAvailableSubscription=true → confirms the subscription tier
                                        without re-validating

    Idempotent.
    """
    if not agent_user:
        return False
    home = agent_user.get("home")
    if not home:
        return False
    path = os.path.join(home, ".claude.json")
    try:
        with open(path) as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        data = {}
    changed = False
    if not data.get("hasCompletedOnboarding"):
        data["hasCompletedOnboarding"] = True
        changed = True
    if not data.get("hasAvailableSubscription"):
        data["hasAvailableSubscription"] = True
        changed = True
    if not changed:
        return True
    try:
        # NOT encrypted — consumed directly by the Claude Code CLI.
        _atomic_write_secret(path, json.dumps(data, indent=2), encrypt=False)
    except OSError as e:
        logger.warning(f"[Agent Auth] Failed to write {path}: {e}")
        return False
    uid = agent_user.get("uid")
    gid = agent_user.get("gid", uid)
    if uid is not None:
        try:
            os.chown(path, uid, gid)
            os.chmod(path, 0o600)
        except OSError:
            pass
    logger.info(f"[Agent Auth] Seeded {path} (hasCompletedOnboarding=true)")
    return True


def seed_credentials_file(agent_user: dict) -> bool:
    """Write `~/.claude/.credentials.json` in the agent's HOME from the token
    currently in storage (owner DB record or local files).

    Defense-in-depth alongside [[seed_onboarding_state]] and the env-var
    token injection: some auth code paths inside the CLI prefer the on-disk
    credentials file. Idempotent: call at every spawn so the file always
    reflects the latest (possibly refreshed) token.
    """
    if not agent_user:
        return False
    home = agent_user.get("home")
    if not home:
        return False

    # Build a full oauth_data block. Prefer the owner DB record because it
    # carries the real expiresAt; fall back to local agent files / a
    # generous default when only the access token is known.
    owner_id = agent_user.get("owner_id")
    access_token = None
    refresh_token = ""
    expires_at = 0
    if owner_id:
        record = _fetch_owner_record(owner_id)
        if not (record and record.get("accessToken")):
            # A stale 30s cache or a transient team-api hiccup during the
            # restart window can hide a token that actually exists in the DB.
            # Force one uncached retry before falling back / failing — this is
            # the difference between a clean restart and a spurious 401.
            record = _fetch_owner_record(owner_id, force=True)
        if record:
            access_token = record.get("accessToken")
            refresh_token = record.get("refreshToken") or ""
            expires_at = record.get("expiresAt") or 0
    if not access_token:
        access_token = load_agent_token(agent_user)
        if access_token:
            refresh_token = get_agent_refresh_token(agent_user) or refresh_token
    if not access_token:
        # Loud, not silent: this is exactly the state that makes the CLI start
        # unauthenticated and report "Please run /login" / 401 after a restart.
        logger.error(
            "[Agent Auth] No OAuth token to seed credentials for %s (owner_id=%s) — "
            "the Claude Code CLI will start UNAUTHENTICATED and report 401 / "
            "'Please run /login'. No persisted token in team-api and no local "
            "agent token found.",
            agent_user.get("username"), owner_id or "none",
        )
        return False
    if not expires_at:
        # Unknown expiry — use 8 h from now (matches the default elsewhere).
        expires_at = int((time.time() + 28800) * 1000)

    oauth_data = {
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": expires_at,
        "scopes": OAUTH_SCOPES.split(),
    }

    creds_path = os.path.join(home, ".claude", ".credentials.json")
    try:
        # NOT encrypted — the Claude Code CLI reads this file directly.
        _atomic_write_secret(creds_path, json.dumps({"claudeAiOauth": oauth_data}, indent=2), encrypt=False)
    except OSError as e:
        logger.warning(f"[Agent Auth] Failed to write {creds_path}: {e}")
        return False
    uid = agent_user.get("uid")
    gid = agent_user.get("gid", uid)
    if uid is not None:
        # Chown the .claude dir too, in case _secure_makedirs created it as root.
        claude_dir = os.path.dirname(creds_path)
        for path in (claude_dir, creds_path):
            try:
                os.chown(path, uid, gid)
            except OSError:
                pass
        try:
            os.chmod(creds_path, 0o600)
        except OSError:
            pass
    logger.info(f"[Agent Auth] Seeded {creds_path} (owner_id={owner_id or 'none'})")
    return True


# =============================================================================
# Token HTTP request (shared by all refresh flows)
# =============================================================================

async def token_http_request(payload: dict, description: str, agent_user: dict = None) -> Optional[dict]:
    """Make a rate-limited HTTP request to the OAuth token endpoint.

    Uses Node.js fetch (via subprocess) instead of Python urllib because
    Cloudflare blocks Python's TLS fingerprint with a fake 429 response.
    """
    async with _token_request_lock:
        is_code_exchange = payload.get("grant_type") == "authorization_code"

        if not is_code_exchange:
            if agent_user and agent_user.get("_owner_id"):
                token_expired = await run_blocking(is_owner_token_expired, agent_user["_owner_id"])
            elif agent_user:
                owner_id = agent_user.get("owner_id")
                if owner_id:
                    token_expired = await run_blocking(is_owner_token_expired, owner_id)
                else:
                    token_expired = await run_blocking(is_agent_token_expired, agent_user)
            else:
                token_expired = await run_blocking(is_token_expired)
            if not token_expired:
                logger.info("Token already valid (refreshed by another request)")
                return {"_already_valid": True}

        node_script = f"""
        const params = new URLSearchParams({json.dumps(payload)});
        try {{
            const resp = await fetch("{OAUTH_TOKEN_URL}", {{
                method: "POST",
                headers: {{ "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json" }},
                body: params.toString(),
            }});
            const text = await resp.text();
            console.log(JSON.stringify({{ status: resp.status, body: text }}));
        }} catch (e) {{
            console.log(JSON.stringify({{ status: 0, body: e.message }}));
        }}
        """

        logger.info(f"{description}...")
        try:
            proc = await asyncio.create_subprocess_exec(
                "node", "-e", node_script,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=30)
            stdout = stdout_bytes.decode("utf-8", errors="replace").strip()

            if not stdout:
                logger.error(f"{description}: node subprocess produced no output. stderr={stderr_bytes.decode()[:200]}")
                return None

            result = json.loads(stdout)
            status = result.get("status", 0)
            body = result.get("body", "")

            if status == 200:
                return json.loads(body)
            elif status == 429:
                logger.warning(f"{description}: rate-limited (429), body={body[:300]}")
                return None
            else:
                logger.error(f"{description}: HTTP {status}, body={body[:500]}")
                try:
                    err_body = json.loads(body)
                    if err_body.get("error") == "invalid_grant":
                        return {"_invalid_grant": True}
                except (json.JSONDecodeError, TypeError):
                    pass
                return None

        except asyncio.TimeoutError:
            logger.error(f"{description}: node subprocess timed out")
            return None
        except Exception as e:
            logger.error(f"{description}: {e}", exc_info=True)
            return None


# =============================================================================
# Refresh flows
# =============================================================================

async def refresh_oauth_token() -> bool:
    global _token_cooldown_until
    refresh_token = get_saved_refresh_token()
    if not refresh_token:
        logger.warning("No refresh token available - cannot refresh, need full re-auth")
        return False

    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": OAUTH_CLIENT_ID,
    }

    try:
        result = await token_http_request(payload, "Refreshing OAuth token")
        if result is None:
            return False
        if result.get("_already_valid"):
            return True
        if result.get("_invalid_grant"):
            logger.error("Global refresh token is permanently invalid — clearing stored tokens")
            invalidate_global_token()
            _token_cooldown_until = time.time() + 60
            return False

        access_token = result.get("access_token")
        if not access_token:
            logger.error(f"Refresh response missing access_token: {result}")
            return False

        new_refresh = result.get("refresh_token") or refresh_token
        expires_in = result.get("expires_in", 28800)
        save_token(access_token, refresh_token=new_refresh, expires_in=expires_in)
        logger.info("OAuth token refreshed successfully")
        return True

    except Exception as e:
        logger.error(f"Token refresh failed: {e}", exc_info=True)
        return False


async def _refresh_with(
    refresh_token: Optional[str],
    expiry_probe: Optional[dict],
    invalidate,
    persist,
    label: str,
    who: str,
    desc: str,
) -> bool:
    """Shared owner/agent refresh-token skeleton.

    `invalidate` and `persist` are async callables (callers wrap their sync
    variants); `persist(access, refresh, expires_in)` returns whether the
    token was saved. `expiry_probe` is forwarded to token_http_request as its
    agent_user argument for the under-lock already-valid re-probe (the owner
    path passes the load-bearing `{"_owner_id": ...}` synthetic dict). `who`
    is the display id used in log lines, `desc` the token_http_request
    context string.

    NOTE: refresh_oauth_token (the global variant above) deliberately stays
    separate — it swallows exceptions, treats an empty refresh_token in the
    response differently (`or` vs `.get` default), and never checks the
    save_token return value.
    """
    global _token_cooldown_until
    if not refresh_token:
        logger.warning(f"[{label} Auth] No refresh token for {who}")
        return False
    payload = {
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    result = await token_http_request(payload, desc, agent_user=expiry_probe)
    if not result or result.get("_already_valid"):
        return bool(result)
    if result.get("_invalid_grant"):
        logger.error(f"[{label} Auth] Refresh token for {who} is permanently invalid — clearing stored tokens")
        await invalidate()
        _token_cooldown_until = time.time() + 60
        return False
    access_token = result.get("access_token")
    if not access_token:
        logger.error(f"[{label} Auth] Refresh response missing access_token for {who}")
        return False
    new_refresh = result.get("refresh_token", refresh_token)
    expires_in = result.get("expires_in", 28800)
    if not await persist(access_token, new_refresh, expires_in):
        logger.error(f"[{label} Auth] Refreshed token for {who} could not be persisted — caller will treat as failed refresh")
        return False
    logger.info(f"[{label} Auth] Token refreshed for {who}")
    return True


async def refresh_owner_token(owner_id: str) -> bool:
    async def _invalidate() -> None:
        await run_blocking(invalidate_owner_token, owner_id)

    async def _persist(access_token, refresh_token, expires_in) -> bool:
        return await run_blocking(
            save_owner_token, owner_id, access_token,
            refresh_token=refresh_token, expires_in=expires_in,
        )

    return await _refresh_with(
        await run_blocking(get_owner_refresh_token, owner_id),
        {"_owner_id": owner_id},
        _invalidate,
        _persist,
        "Owner",
        f"owner {owner_id}",
        f"owner {owner_id} token refresh",
    )


async def refresh_agent_token(agent_user: dict) -> bool:
    owner_id = agent_user.get("owner_id") if agent_user else None
    if owner_id:
        return await refresh_owner_token(owner_id)

    async def _invalidate() -> None:
        invalidate_agent_token(agent_user)

    async def _persist(access_token, refresh_token, expires_in) -> bool:
        return save_agent_token(
            agent_user, access_token,
            refresh_token=refresh_token, expires_in=expires_in,
        )

    return await _refresh_with(
        get_agent_refresh_token(agent_user),
        agent_user,
        _invalidate,
        _persist,
        "Agent",
        agent_user["username"],
        f"agent {agent_user['username']} token refresh",
    )


# =============================================================================
# Environment helpers
# =============================================================================

def get_claude_env() -> dict:
    from command_security import sanitize_env
    env = sanitize_env(os.environ)
    env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
    if not env.get("CLAUDE_CODE_OAUTH_TOKEN"):
        saved = load_saved_token()
        if saved:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = saved
    return env


def get_agent_env(agent_user: dict = None) -> dict:
    from command_security import sanitize_env
    if agent_user:
        env = sanitize_env(os.environ, agent_user)
        env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] = "1"
        token = resolve_token(agent_user)
        if token:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = token
        elif env.get("CLAUDE_CODE_OAUTH_TOKEN"):
            del env["CLAUDE_CODE_OAUTH_TOKEN"]
        # GitHub plugin token mirror — see agent_user.apply_github_token_env:
        # the credential helper covers `git`, but `gh` and SDK-based tools need
        # GITHUB_TOKEN/GH_TOKEN in the environment.
        from agent_user import apply_github_token_env
        apply_github_token_env(env, agent_user.get("home") if agent_user else None)
        return env
    return get_claude_env()


def get_subprocess_kwargs(agent_user: dict = None) -> dict:
    """Return Popen kwargs that drop the spawned CLI to the agent's dedicated UID/GID.

    Requires the parent process to have ambient CAP_SETUID/CAP_SETGID — granted
    by the entrypoint via setpriv. If the agent record doesn't carry a dedicated
    UID (e.g. legacy code path) we return an empty dict and the subprocess runs
    as the parent's UID.

    Note: uses ``preexec_fn`` rather than ``user``/``group`` because uvloop's
    ``subprocess_exec`` (used by FastAPI/uvicorn) does not accept those kwargs
    even though stdlib asyncio supports them since Python 3.9.
    """
    if not agent_user:
        return {}
    uid = agent_user.get("uid")
    gid = agent_user.get("gid")
    parent_uid = os.getuid()
    if uid is None or uid == parent_uid:
        return {}
    target_gid = gid if gid is not None else uid

    def _drop_privs() -> None:
        # Runs in the forked child before exec().
        try:
            os.setgroups([target_gid])
        except (PermissionError, OSError):
            # Best-effort; supplementary groups require CAP_SETGID.
            pass
        os.setgid(target_gid)
        os.setuid(uid)

    return {"preexec_fn": _drop_privs}


def auth_method() -> str:
    if read_secret("CLAUDE_CODE_OAUTH_TOKEN") or os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or load_saved_token():
        return "oauth"
    if read_secret("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_API_KEY"):
        return "api_key"
    return "none"


def claude_auth_status() -> dict:
    try:
        result = subprocess.run(
            ["claude", "auth", "status"],
            capture_output=True, text=True, timeout=10,
            env=get_claude_env(),
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        logger.debug(f"claude auth status failed: {e}")
    return {}
