"""
Codex backend — OAuth PKCE flow management.

Mirrors claude_oauth.py but targets OpenAI's auth endpoints. Builds the
same auth.json shape that the official `codex login` CLI produces so the
codex binary can pick it up transparently.

OAuth constants come from the official openai/codex CLI source:
  https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs
"""

import re
import json
import time
import base64
import hashlib
import secrets
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import httpx

from config import logger
from agent_user import ensure_agent_user
from .codex_token_store import (
    save_owner_blob, write_local_auth, read_local_auth,
)


# OpenAI's OAuth endpoints (public client used by the codex CLI).
CODEX_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
CODEX_OAUTH_AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize"
CODEX_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token"
CODEX_OAUTH_REDIRECT_URI = "http://localhost:1455/auth/callback"
CODEX_OAUTH_SCOPES = "openid profile email offline_access"

_HTTP_TIMEOUT = 10.0


# --- In-memory PKCE flow state -----------------------------------------------

_agent_oauth_flows: dict[str, dict] = {}
_owner_oauth_flows: dict[str, dict] = {}


_CODE_RE = re.compile(r'^[A-Za-z0-9_#\-\.]{20,}$')


def _generate_pkce() -> tuple[str, str]:
    """Generate (verifier, challenge) per the codex CLI: 64 random bytes,
    base64url-no-pad encoded; challenge = sha256(verifier)."""
    raw = secrets.token_bytes(64)
    verifier = base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def _build_authorize_url(code_challenge: str, state: str) -> str:
    params = {
        "response_type": "code",
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "redirect_uri": CODEX_OAUTH_REDIRECT_URI,
        "scope": CODEX_OAUTH_SCOPES,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": state,
    }
    return f"{CODEX_OAUTH_AUTHORIZE_URL}?" + urllib.parse.urlencode(params)


# --- JWT helpers --------------------------------------------------------------

def _decode_jwt_claims(jwt: str) -> dict:
    """Decode the payload section of a JWT without verifying the signature.
    Returns {} on any parsing failure — callers only use this to read the
    `exp`, `email`, `chatgpt_plan_type`, and `chatgpt_account_id` claims."""
    try:
        parts = jwt.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        # Re-add padding stripped during base64url encoding
        payload += "=" * (-len(payload) % 4)
        raw = base64.urlsafe_b64decode(payload.encode("ascii"))
        return json.loads(raw)
    except Exception:
        return {}


def access_token_expires_at(blob: dict) -> int:
    """Return unix-seconds expiry of the blob's access_token JWT (0 when
    unknown). Falls back to last_refresh + 8h if the JWT can't be parsed."""
    if not isinstance(blob, dict):
        return 0
    tokens = blob.get("tokens") or {}
    access_token = tokens.get("access_token") or ""
    if access_token:
        exp = _decode_jwt_claims(access_token).get("exp") or 0
        try:
            return int(exp)
        except (TypeError, ValueError):
            pass
    last_refresh = blob.get("last_refresh") or ""
    try:
        if last_refresh:
            dt = datetime.fromisoformat(last_refresh.replace("Z", "+00:00"))
            return int(dt.timestamp() + 8 * 3600)
    except (TypeError, ValueError):
        pass
    return 0


def is_blob_expired(blob: dict, margin_seconds: int = 300) -> bool:
    exp = access_token_expires_at(blob)
    if not exp:
        return False
    return time.time() >= (exp - margin_seconds)


def blob_account_email(blob: dict) -> str:
    if not isinstance(blob, dict):
        return ""
    tokens = blob.get("tokens") or {}
    id_token = tokens.get("id_token") or ""
    if not id_token:
        return ""
    return _decode_jwt_claims(id_token).get("email", "") or ""


def blob_plan_type(blob: dict) -> str:
    if not isinstance(blob, dict):
        return ""
    tokens = blob.get("tokens") or {}
    id_token = tokens.get("id_token") or ""
    if not id_token:
        return ""
    return _decode_jwt_claims(id_token).get("chatgpt_plan_type", "") or ""


# --- Build / refresh auth.json blob ------------------------------------------

def build_blob(access_token: str, refresh_token: str, id_token: str,
               account_id: Optional[str] = None,
               api_key: Optional[str] = None) -> dict:
    """Construct the auth.json shape produced by `codex login`.

    `account_id` is normally pulled from the id_token's `chatgpt_account_id`
    claim when not explicitly provided.
    """
    if not account_id and id_token:
        account_id = _decode_jwt_claims(id_token).get("chatgpt_account_id")
    return {
        "OPENAI_API_KEY": api_key,
        "tokens": {
            "id_token": id_token or "",
            "access_token": access_token or "",
            "refresh_token": refresh_token or "",
            "account_id": account_id or "",
        },
        "last_refresh": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def parse_blob_input(raw: str) -> dict:
    """Accept either a full auth.json JSON blob or just an access_token JWT.
    Returns the canonical blob shape (raises ValueError on bad input)."""
    raw = (raw or "").strip()
    if not raw:
        raise ValueError("empty token")
    # Try JSON first
    if raw.startswith("{"):
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            raise ValueError(f"invalid JSON blob: {e}")
        if "tokens" in data and isinstance(data["tokens"], dict):
            # Already in canonical shape — fill in last_refresh if missing.
            data.setdefault("OPENAI_API_KEY", None)
            data.setdefault("last_refresh",
                            datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"))
            return data
        # Flat shape {access_token, refresh_token, id_token, account_id}
        return build_blob(
            data.get("access_token", ""),
            data.get("refresh_token", ""),
            data.get("id_token", ""),
            account_id=data.get("account_id"),
            api_key=data.get("OPENAI_API_KEY"),
        )
    # Treat as a raw access_token JWT (no refresh capability in this mode)
    return build_blob(access_token=raw, refresh_token="", id_token="")


# --- OAuth PKCE flow ----------------------------------------------------------

def initiate_owner_login(owner_id: str) -> str:
    if owner_id in _owner_oauth_flows:
        return _owner_oauth_flows[owner_id]["auth_url"]
    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(32)
    url = _build_authorize_url(challenge, state)
    _owner_oauth_flows[owner_id] = {
        "code_verifier": verifier,
        "state": state,
        "auth_url": url,
    }
    logger.info(f"[Codex Owner Auth] Initiated login flow for owner {owner_id}: {url[:80]}...")
    return url


def initiate_agent_login(agent_id: str) -> str:
    if agent_id in _agent_oauth_flows:
        return _agent_oauth_flows[agent_id]["auth_url"]
    verifier, challenge = _generate_pkce()
    state = secrets.token_urlsafe(32)
    url = _build_authorize_url(challenge, state)
    _agent_oauth_flows[agent_id] = {
        "code_verifier": verifier,
        "state": state,
        "auth_url": url,
    }
    logger.info(f"[Codex Agent Auth] Initiated login flow for agent {agent_id[:12]}: {url[:80]}...")
    return url


def get_owner_oauth_flow(owner_id: str) -> Optional[dict]:
    return _owner_oauth_flows.get(owner_id)


def pop_owner_oauth_flow(owner_id: str) -> Optional[dict]:
    return _owner_oauth_flows.pop(owner_id, None)


def get_agent_oauth_flow(agent_id: str) -> Optional[dict]:
    return _agent_oauth_flows.get(agent_id)


def pop_agent_oauth_flow(agent_id: str) -> Optional[dict]:
    return _agent_oauth_flows.pop(agent_id, None)


def _normalize_code(raw: str) -> tuple[str, str]:
    """Accept either a bare code, `code#state`, or the full redirect URL the
    user pasted from the failed http://localhost:1455 navigation."""
    raw = (raw or "").strip()
    if raw.startswith("http://localhost:1455") or raw.startswith("https://localhost:1455"):
        try:
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(raw).query)
            code = (qs.get("code") or [""])[0]
            state = (qs.get("state") or [""])[0]
            return code, state
        except Exception:
            pass
    if "#" in raw:
        code, state = raw.split("#", 1)
        return code, state
    return raw, ""


async def _post_token(payload: dict, context: str) -> Optional[dict]:
    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            r = await client.post(
                CODEX_OAUTH_TOKEN_URL,
                data=payload,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
    except httpx.HTTPError as e:
        logger.error(f"[Codex OAuth] Network error during {context}: {e}")
        return None
    if r.status_code >= 400:
        logger.warning(f"[Codex OAuth] {context} → http {r.status_code}: {r.text[:300]}")
        return None
    try:
        return r.json()
    except ValueError:
        logger.warning(f"[Codex OAuth] {context} returned non-JSON: {r.text[:300]}")
        return None


async def _exchange_code(verifier: str, code: str) -> Optional[dict]:
    payload = {
        "grant_type": "authorization_code",
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "code": code,
        "redirect_uri": CODEX_OAUTH_REDIRECT_URI,
        "code_verifier": verifier,
    }
    return await _post_token(payload, "authorization_code exchange")


async def refresh_blob(blob: dict) -> Optional[dict]:
    """Refresh an auth.json blob using its refresh_token. Returns a new blob
    on success, or None when the refresh failed (caller should require
    re-login).
    """
    if not isinstance(blob, dict):
        return None
    tokens = blob.get("tokens") or {}
    refresh_token = tokens.get("refresh_token") or ""
    if not refresh_token:
        return None
    payload = {
        "grant_type": "refresh_token",
        "client_id": CODEX_OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
        "scope": CODEX_OAUTH_SCOPES,
    }
    resp = await _post_token(payload, "refresh_token grant")
    if not resp:
        return None
    new_access = resp.get("access_token") or ""
    new_refresh = resp.get("refresh_token") or refresh_token
    new_id = resp.get("id_token") or tokens.get("id_token") or ""
    if not new_access:
        logger.warning("[Codex OAuth] refresh response missing access_token")
        return None
    return build_blob(
        access_token=new_access,
        refresh_token=new_refresh,
        id_token=new_id,
        account_id=tokens.get("account_id"),
        api_key=blob.get("OPENAI_API_KEY"),
    )


async def exchange_owner_code(owner_id: str, code_or_url: str) -> dict:
    flow = _owner_oauth_flows.get(owner_id)
    if not flow:
        return {"status": "error", "message": "No pending OAuth flow for this owner."}
    code, _state = _normalize_code(code_or_url)
    if not code:
        return {"status": "error", "message": "Empty code."}
    resp = await _exchange_code(flow["code_verifier"], code)
    if not resp:
        _owner_oauth_flows.pop(owner_id, None)
        return {"status": "error", "message": "Token exchange failed (rate-limited, network, or bad code)."}
    access_token = resp.get("access_token") or ""
    if not access_token:
        _owner_oauth_flows.pop(owner_id, None)
        return {"status": "error", "message": "Token response missing access_token."}
    refresh_token = resp.get("refresh_token") or ""
    id_token = resp.get("id_token") or ""
    blob = build_blob(access_token, refresh_token, id_token)
    persisted = save_owner_blob(owner_id, blob)
    _owner_oauth_flows.pop(owner_id, None)
    if not persisted:
        return {"status": "error", "message": "OAuth succeeded but token persistence failed (team-api unreachable)."}
    email = blob_account_email(blob)
    plan = blob_plan_type(blob)
    logger.info(f"[Codex Owner Auth] OAuth exchange ok for owner {owner_id}: {email} ({plan})")
    return {"status": "authenticated", "email": email, "plan": plan}


async def exchange_agent_code(agent_id: str, code_or_url: str,
                              owner_id: Optional[str] = None) -> dict:
    flow = _agent_oauth_flows.get(agent_id)
    if not flow:
        return {"status": "error", "message": "No pending OAuth flow for this agent."}
    code, _state = _normalize_code(code_or_url)
    if not code:
        return {"status": "error", "message": "Empty code."}
    resp = await _exchange_code(flow["code_verifier"], code)
    if not resp:
        _agent_oauth_flows.pop(agent_id, None)
        return {"status": "error", "message": "Token exchange failed (rate-limited, network, or bad code)."}
    access_token = resp.get("access_token") or ""
    if not access_token:
        _agent_oauth_flows.pop(agent_id, None)
        return {"status": "error", "message": "Token response missing access_token."}
    refresh_token = resp.get("refresh_token") or ""
    id_token = resp.get("id_token") or ""
    blob = build_blob(access_token, refresh_token, id_token)
    agent_user = await ensure_agent_user(agent_id, owner_id=owner_id)
    persisted = False
    if agent_user:
        try:
            write_local_auth(agent_user, blob)
            persisted = True
        except OSError as e:
            logger.error(f"[Codex Agent Auth] write_local_auth failed for {agent_id[:12]}: {e}")
        # If the agent belongs to an owner, also share via the owner store so
        # every agent for that owner picks it up.
        if owner_id:
            save_owner_blob(owner_id, blob)
    _agent_oauth_flows.pop(agent_id, None)
    if not persisted:
        return {"status": "error", "message": "OAuth succeeded but token persistence failed."}
    email = blob_account_email(blob)
    plan = blob_plan_type(blob)
    logger.info(f"[Codex Agent Auth] OAuth exchange ok for agent {agent_id[:12]}: {email} ({plan})")
    return {"status": "authenticated", "email": email, "plan": plan}


# --- In-chat code exchange ----------------------------------------------------

def _extract_code_from_prompt(prompt: str) -> Optional[str]:
    """Pull a verification code out of the most recent user turn. Accepts
    either a bare code or the full localhost:1455 callback URL."""
    last_user_msg = prompt.strip()
    for line in reversed(prompt.strip().split("\n")):
        line = line.strip()
        if line.startswith("User: "):
            last_user_msg = line[6:].strip()
            break
    if last_user_msg.startswith("http://localhost:1455"):
        return last_user_msg
    if _CODE_RE.match(last_user_msg):
        return last_user_msg
    return None


async def try_exchange_code_from_prompt(prompt: str,
                                        agent_id: Optional[str] = None,
                                        owner_id: Optional[str] = None) -> Optional[dict]:
    code = _extract_code_from_prompt(prompt)
    if not code:
        return None
    if owner_id and owner_id in _owner_oauth_flows:
        return await exchange_owner_code(owner_id, code)
    if agent_id and agent_id in _agent_oauth_flows:
        return await exchange_agent_code(agent_id, code, owner_id=owner_id)
    return None
