"""
Claude Code backend — Token persistence (global, per-agent, per-owner).
"""

import os
import re
import json
import time
import asyncio
import subprocess
from typing import Optional

from config import (
    DATA_DIR, USERS_DIR,
    TOKEN_FILE, TOKEN_JSON_FILE, CREDENTIALS_FILE,
    OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, OAUTH_SCOPES,
    logger,
)


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
        creds_dir = os.path.dirname(CREDENTIALS_FILE)
        os.makedirs(creds_dir, exist_ok=True)
        creds = {}
        try:
            with open(CREDENTIALS_FILE) as f:
                creds = json.load(f)
        except (OSError, FileNotFoundError, json.JSONDecodeError):
            pass
        creds["claudeAiOauth"] = oauth_data
        with open(CREDENTIALS_FILE, "w") as f:
            json.dump(creds, f, indent=2)
        logger.info("Restored credentials.json from persistent OAuth data")
    except Exception as e:
        logger.warning(f"Failed to restore credentials.json: {e}")


def load_saved_token() -> Optional[str]:
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if token:
        return token
    try:
        with open(TOKEN_JSON_FILE) as f:
            oauth_data = json.load(f)
        token = oauth_data.get("accessToken")
        if token:
            _restore_credentials_file(oauth_data)
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    try:
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
        if token:
            return token
    except (OSError, FileNotFoundError):
        pass
    try:
        with open(CREDENTIALS_FILE) as f:
            creds = json.load(f)
        token = creds.get("claudeAiOauth", {}).get("accessToken")
        if token:
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    return None


def save_token(token: str, refresh_token: Optional[str] = None, expires_in: int = 28800):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(TOKEN_FILE, "w") as f:
        f.write(token)
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    with open(TOKEN_JSON_FILE, "w") as f:
        json.dump(oauth_data, f, indent=2)
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token

    creds_dir = os.path.dirname(CREDENTIALS_FILE)
    os.makedirs(creds_dir, exist_ok=True)
    creds = {}
    try:
        with open(CREDENTIALS_FILE) as f:
            creds = json.load(f)
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    creds["claudeAiOauth"] = oauth_data
    with open(CREDENTIALS_FILE, "w") as f:
        json.dump(creds, f, indent=2)
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
    try:
        with open(TOKEN_JSON_FILE) as f:
            oauth_data = json.load(f)
        expires_at_ms = oauth_data.get("expiresAt", 0)
        if not expires_at_ms:
            return False
        return time.time() >= (expires_at_ms / 1000) - margin_seconds
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return True


def get_saved_refresh_token() -> Optional[str]:
    try:
        with open(TOKEN_JSON_FILE) as f:
            return json.load(f).get("refreshToken") or None
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


# =============================================================================
# Per-owner token storage
# =============================================================================

def _sanitize_owner_id(owner_id: str) -> str:
    return re.sub(r'[^a-zA-Z0-9_-]', '', owner_id)[:48] or "default"


def _owner_token_dir(owner_id: str) -> str:
    return os.path.join(USERS_DIR, _sanitize_owner_id(owner_id))


def load_owner_token(owner_id: str) -> Optional[str]:
    if not owner_id:
        return None
    token_json = os.path.join(_owner_token_dir(owner_id), "oauth_token.json")
    try:
        with open(token_json) as f:
            data = json.load(f)
        return data.get("accessToken") or None
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


def save_owner_token(owner_id: str, token: str, refresh_token: Optional[str] = None, expires_in: int = 28800):
    owner_dir = _owner_token_dir(owner_id)
    os.makedirs(owner_dir, exist_ok=True)
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    with open(os.path.join(owner_dir, "oauth_token.json"), "w") as f:
        json.dump(oauth_data, f, indent=2)
    logger.info(f"[Owner Auth] Saved OAuth token for owner {owner_id}")


def invalidate_owner_token(owner_id: str):
    if not owner_id:
        return
    token_file = os.path.join(_owner_token_dir(owner_id), "oauth_token.json")
    try:
        os.remove(token_file)
        logger.info(f"[Owner Auth] Cleared invalid token for owner {owner_id}")
    except OSError:
        pass


def is_owner_token_expired(owner_id: str, margin_seconds: int = 300) -> bool:
    if not owner_id:
        return False
    token_json = os.path.join(_owner_token_dir(owner_id), "oauth_token.json")
    try:
        with open(token_json) as f:
            data = json.load(f)
        expires_at_ms = data.get("expiresAt", 0)
        if not expires_at_ms:
            return False
        return time.time() >= (expires_at_ms / 1000) - margin_seconds
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return False


def get_owner_refresh_token(owner_id: str) -> Optional[str]:
    if not owner_id:
        return None
    token_json = os.path.join(_owner_token_dir(owner_id), "oauth_token.json")
    try:
        with open(token_json) as f:
            return json.load(f).get("refreshToken") or None
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


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
    try:
        with open(agent_token_json) as f:
            data = json.load(f)
        token = data.get("accessToken")
        if token:
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    agent_creds = os.path.join(home, ".claude", ".credentials.json")
    try:
        with open(agent_creds) as f:
            creds = json.load(f)
        token = creds.get("claudeAiOauth", {}).get("accessToken")
        if token:
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    return None


def save_agent_token(agent_user: dict, token: str, refresh_token: Optional[str] = None, expires_in: int = 28800):
    owner_id = agent_user.get("owner_id")
    if owner_id:
        save_owner_token(owner_id, token, refresh_token=refresh_token, expires_in=expires_in)
        return
    home = agent_user["home"]
    os.makedirs(home, exist_ok=True)
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    with open(os.path.join(home, "oauth_token.json"), "w") as f:
        json.dump(oauth_data, f, indent=2)
    agent_creds_file = os.path.join(home, ".claude", ".credentials.json")
    os.makedirs(os.path.dirname(agent_creds_file), exist_ok=True)
    creds = {}
    try:
        with open(agent_creds_file) as f:
            creds = json.load(f)
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    creds["claudeAiOauth"] = oauth_data
    with open(agent_creds_file, "w") as f:
        json.dump(creds, f, indent=2)
    logger.info(f"[Agent Auth] Saved OAuth token for agent {agent_user['username']}")


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
    try:
        with open(agent_token_json) as f:
            data = json.load(f)
        expires_at_ms = data.get("expiresAt", 0)
        if not expires_at_ms:
            return False
        return time.time() >= (expires_at_ms / 1000) - margin_seconds
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return False


def get_agent_refresh_token(agent_user: dict) -> Optional[str]:
    if not agent_user:
        return None
    agent_token_json = os.path.join(agent_user["home"], "oauth_token.json")
    try:
        with open(agent_token_json) as f:
            return json.load(f).get("refreshToken") or None
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


def resolve_token(agent_user: dict) -> Optional[str]:
    owner_id = agent_user.get("owner_id") if agent_user else None
    if owner_id:
        token = load_owner_token(owner_id)
        if token:
            return token
    return load_agent_token(agent_user)


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
                token_expired = is_owner_token_expired(agent_user["_owner_id"])
            elif agent_user:
                owner_id = agent_user.get("owner_id")
                token_expired = is_owner_token_expired(owner_id) if owner_id else is_agent_token_expired(agent_user)
            else:
                token_expired = is_token_expired()
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


async def refresh_owner_token(owner_id: str) -> bool:
    global _token_cooldown_until
    refresh_token = get_owner_refresh_token(owner_id)
    if not refresh_token:
        logger.warning(f"[Owner Auth] No refresh token for owner {owner_id}")
        return False
    payload = {
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    owner_check = {"_owner_id": owner_id}
    result = await token_http_request(payload, f"owner {owner_id} token refresh", agent_user=owner_check)
    if not result or result.get("_already_valid"):
        return bool(result)
    if result.get("_invalid_grant"):
        logger.error(f"[Owner Auth] Refresh token for owner {owner_id} is permanently invalid — clearing stored tokens")
        invalidate_owner_token(owner_id)
        _token_cooldown_until = time.time() + 60
        return False
    access_token = result.get("access_token")
    if not access_token:
        logger.error(f"[Owner Auth] Refresh response missing access_token for owner {owner_id}")
        return False
    new_refresh = result.get("refresh_token", refresh_token)
    expires_in = result.get("expires_in", 28800)
    save_owner_token(owner_id, access_token, refresh_token=new_refresh, expires_in=expires_in)
    logger.info(f"[Owner Auth] Token refreshed for owner {owner_id}")
    return True


async def refresh_agent_token(agent_user: dict) -> bool:
    global _token_cooldown_until
    owner_id = agent_user.get("owner_id") if agent_user else None
    if owner_id:
        return await refresh_owner_token(owner_id)
    refresh_token = get_agent_refresh_token(agent_user)
    if not refresh_token:
        logger.warning(f"[Agent Auth] No refresh token for {agent_user['username']}")
        return False
    payload = {
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    result = await token_http_request(payload, f"agent {agent_user['username']} token refresh", agent_user=agent_user)
    if not result or result.get("_already_valid"):
        return bool(result)
    if result.get("_invalid_grant"):
        logger.error(f"[Agent Auth] Refresh token for {agent_user['username']} is permanently invalid — clearing stored tokens")
        invalidate_agent_token(agent_user)
        _token_cooldown_until = time.time() + 60
        return False
    access_token = result.get("access_token")
    if not access_token:
        logger.error(f"[Agent Auth] Refresh response missing access_token for {agent_user['username']}")
        return False
    new_refresh = result.get("refresh_token", refresh_token)
    expires_in = result.get("expires_in", 28800)
    save_agent_token(agent_user, access_token, refresh_token=new_refresh, expires_in=expires_in)
    logger.info(f"[Agent Auth] Token refreshed for {agent_user['username']}")
    return True


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
        return env
    return get_claude_env()


def get_subprocess_kwargs(agent_user: dict = None) -> dict:
    return {}


def auth_method() -> str:
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or load_saved_token():
        return "oauth"
    if os.environ.get("ANTHROPIC_API_KEY"):
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
