"""
Claude Code backend — OAuth PKCE flow management.
"""

import re
import hashlib
import base64
import secrets
from typing import Optional

from config import (
    OAUTH_CLIENT_ID, OAUTH_AUTHORIZE_URL, OAUTH_REDIRECT_URI, OAUTH_SCOPES,
    logger,
)
from agent_user import ensure_agent_user
from .claude_token_store import (
    token_http_request,
    save_token, save_owner_token, save_agent_token,
)


# --- Global OAuth flow state --------------------------------------------------

_auth_url: Optional[str] = None
_oauth_code_verifier: Optional[str] = None
_oauth_state: Optional[str] = None

_agent_oauth_flows: dict[str, dict] = {}
_owner_oauth_flows: dict[str, dict] = {}


# --- Helpers ------------------------------------------------------------------

_CODE_RE = re.compile(r'^[A-Za-z0-9_#-]{20,}$')


def _extract_code_from_prompt(prompt: str) -> Optional[str]:
    last_user_msg = prompt.strip()
    for line in reversed(prompt.strip().split('\n')):
        line = line.strip()
        if line.startswith("User: "):
            last_user_msg = line[6:].strip()
            break

    if _CODE_RE.match(last_user_msg):
        return last_user_msg
    return None


def requests_encode(value: str) -> str:
    import urllib.parse
    return urllib.parse.quote(value, safe="")


def _generate_pkce() -> tuple[str, str]:
    code_verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


# --- Global OAuth flow --------------------------------------------------------

def _build_auth_url() -> str:
    global _oauth_code_verifier, _oauth_state

    _oauth_code_verifier, code_challenge = _generate_pkce()
    _oauth_state = secrets.token_urlsafe(32)

    params = {
        "code": "true",
        "client_id": OAUTH_CLIENT_ID,
        "response_type": "code",
        "redirect_uri": OAUTH_REDIRECT_URI,
        "scope": OAUTH_SCOPES,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
        "state": _oauth_state,
    }
    query = "&".join(f"{k}={requests_encode(v)}" for k, v in params.items())
    return f"{OAUTH_AUTHORIZE_URL}?{query}"


async def get_login_url() -> str:
    url = _build_auth_url()
    logger.info(f"Generated OAuth URL: {url[:80]}...")
    return url


async def exchange_auth_code(full_code: str) -> dict:
    global _oauth_code_verifier, _oauth_state, _auth_url

    if not _oauth_code_verifier:
        return {"status": "error", "message": "No login flow in progress. Start one first."}

    if "#" in full_code:
        auth_code, state = full_code.split("#", 1)
    else:
        auth_code = full_code
        state = _oauth_state or ""

    payload = {
        "grant_type": "authorization_code",
        "code": auth_code,
        "state": state,
        "client_id": OAUTH_CLIENT_ID,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "code_verifier": _oauth_code_verifier,
    }

    try:
        result = await token_http_request(payload, f"Exchanging auth code ({len(auth_code)} chars)")

        if result is None:
            _oauth_code_verifier = None
            _oauth_state = None
            _auth_url = None
            return {"status": "error", "message": "Token exchange failed: rate-limited. Please wait 2 minutes and try again."}

        if result.get("_already_valid"):
            _oauth_code_verifier = None
            _oauth_state = None
            _auth_url = None
            return {"status": "authenticated", "method": "oauth", "email": "", "subscription": ""}

        access_token = result.get("access_token")
        refresh_token = result.get("refresh_token")
        expires_in = result.get("expires_in", 28800)

        if not access_token:
            logger.error(f"Token exchange returned no access_token: {result}")
            return {"status": "error", "message": "Token exchange failed: no access_token in response"}

        save_token(access_token, refresh_token=refresh_token, expires_in=expires_in)

        email = result.get("account", {}).get("email", "")
        logger.info(f"OAuth token exchange successful: {email}")

        _oauth_code_verifier = None
        _oauth_state = None
        _auth_url = None

        return {
            "status": "authenticated",
            "method": "oauth",
            "email": email,
            "subscription": result.get("account", {}).get("subscription_type", ""),
        }

    except Exception as e:
        logger.error(f"Token exchange error: {e}", exc_info=True)
        _oauth_code_verifier = None
        _oauth_state = None
        _auth_url = None
        return {"status": "error", "message": f"Token exchange failed: {e}"}


def get_auth_url() -> Optional[str]:
    return _auth_url


def set_auth_url(url: Optional[str]):
    global _auth_url
    _auth_url = url


# --- Per-agent / per-owner OAuth flows ----------------------------------------

def _authorize_url(code_challenge: str, state: str) -> str:
    """Authorize URL for the per-agent/per-owner flows.

    Deliberately NOT _build_auth_url: that global-flow variant adds
    code=true as first param, percent-encodes redirect_uri/scope, and
    mutates the global verifier/state — reusing it would corrupt the
    global flow and change the wire format of these URLs."""
    return (
        f"{OAUTH_AUTHORIZE_URL}?"
        f"client_id={OAUTH_CLIENT_ID}&"
        f"response_type=code&"
        f"redirect_uri={OAUTH_REDIRECT_URI}&"
        f"scope={OAUTH_SCOPES.replace(' ', '+')}&"
        f"code_challenge={code_challenge}&"
        f"code_challenge_method=S256&"
        f"state={state}"
    )


def _initiate_login(flows: dict, key: str, label: str) -> str:
    """Return (and cache) the auth URL for a pending owner/agent OAuth flow,
    minting the PKCE verifier/state pair on first call."""
    if key in flows:
        return flows[key]["auth_url"]
    code_verifier, code_challenge = _generate_pkce()
    state = secrets.token_urlsafe(32)
    auth_url = _authorize_url(code_challenge, state)
    flows[key] = {
        "code_verifier": code_verifier,
        "state": state,
        "auth_url": auth_url,
    }
    logger.info(f"[{label} Auth] Initiated login flow for {label.lower()} {key}: {auth_url[:80]}...")
    return auth_url


def initiate_agent_login(agent_id: str) -> str:
    return _initiate_login(_agent_oauth_flows, agent_id, "Agent")


def get_agent_oauth_flow(agent_id: str) -> Optional[dict]:
    return _agent_oauth_flows.get(agent_id)


def pop_agent_oauth_flow(agent_id: str) -> Optional[dict]:
    return _agent_oauth_flows.pop(agent_id, None)


def initiate_owner_login(owner_id: str) -> str:
    return _initiate_login(_owner_oauth_flows, owner_id, "Owner")


def get_owner_oauth_flow(owner_id: str) -> Optional[dict]:
    return _owner_oauth_flows.get(owner_id)


def pop_owner_oauth_flow(owner_id: str) -> Optional[dict]:
    return _owner_oauth_flows.pop(owner_id, None)


# --- In-chat code exchange (tries all pending flows) --------------------------

async def _exchange_pending(
    flows: dict,
    key: str,
    auth_code: str,
    state: str,
    persist,
    label: str,
    display_id: str,
) -> dict:
    """Exchange a pending flow's verification code and persist the token.

    One copy of the owner/agent in-chat exchange algorithm. `persist` is an
    async callable receiving (access_token, refresh_token, expires_in) and
    returning whether the token was saved; it runs inside the try block so
    its exceptions hit the same pop+generic-error path. Every error path
    pops the pending flow before returning; on success the flow is popped
    only after persistence ran.
    """
    flow = flows[key]
    payload = {
        "grant_type": "authorization_code",
        "client_id": OAUTH_CLIENT_ID,
        "code": auth_code,
        "state": state,
        "redirect_uri": OAUTH_REDIRECT_URI,
        "code_verifier": flow["code_verifier"],
    }
    who = f"{label.lower()} {display_id}"
    logger.info(f"[{label} Auth] Exchanging code for {who}")
    try:
        result = await token_http_request(payload, f"{who} in-chat code exchange")
        if not result:
            flows.pop(key, None)
            return {"status": "error", "message": "Token exchange failed (rate-limited or network error). Try again in 2 minutes."}
        if result.get("_already_valid"):
            flows.pop(key, None)
            return {"status": "authenticated", "email": ""}
        if result.get("_invalid_grant"):
            flows.pop(key, None)
            return {"status": "error", "message": "The verification code was rejected. Please start a new login flow."}
        access_token = result.get("access_token")
        if not access_token:
            logger.error(f"[{label} Auth] Token response missing access_token: {result}")
            flows.pop(key, None)
            return {"status": "error", "message": "Token exchange returned no access token."}
        refresh_token = result.get("refresh_token")
        expires_in = result.get("expires_in", 28800)
        persisted = await persist(access_token, refresh_token, expires_in)
        flows.pop(key, None)
        if not persisted:
            logger.error(f"[{label} Auth] OAuth exchange succeeded but token persistence failed for {who}")
            return {
                "status": "error",
                "message": "Authentication succeeded with Claude but the token could not be saved (team-api unreachable or rejecting). Check runner logs and retry.",
            }
        email = result.get("account", {}).get("email", "")
        logger.info(f"[{label} Auth] In-chat OAuth exchange successful for {who}: {email}")
        return {"status": "authenticated", "email": email}
    except Exception as e:
        logger.error(f"[{label} Auth] In-chat code exchange error: {e}", exc_info=True)
        flows.pop(key, None)
        return {"status": "error", "message": f"Token exchange failed: {e}"}


async def try_exchange_code_from_prompt(prompt: str, agent_id: Optional[str] = None, owner_id: Optional[str] = None) -> Optional[dict]:
    code = _extract_code_from_prompt(prompt)
    if not code:
        return None

    # Anthropic's `code=true` display flow yields `code#state`. Require that
    # form and only treat the message as a verification code when its embedded
    # state matches the pending flow's state — otherwise any 20+ char
    # single-line message (a git SHA, a UUID, a token) sent while a login flow
    # lingers would be consumed as a code, fail the exchange, drop the user's
    # message AND invalidate the pending login flow.
    if "#" not in code:
        return None
    auth_code, state = code.split("#", 1)
    if not auth_code or not state:
        return None

    if owner_id and owner_id in _owner_oauth_flows \
            and state == _owner_oauth_flows[owner_id].get("state"):
        async def _persist_owner(access_token, refresh_token, expires_in) -> bool:
            return save_owner_token(owner_id, access_token, refresh_token=refresh_token, expires_in=expires_in)
        return await _exchange_pending(
            _owner_oauth_flows, owner_id, auth_code, state,
            _persist_owner, "Owner", owner_id,
        )

    if agent_id and agent_id in _agent_oauth_flows \
            and state == _agent_oauth_flows[agent_id].get("state"):
        async def _persist_agent(access_token, refresh_token, expires_in) -> bool:
            agent_user = await ensure_agent_user(agent_id, owner_id=owner_id)
            if not agent_user:
                return False
            return save_agent_token(agent_user, access_token, refresh_token=refresh_token, expires_in=expires_in)
        return await _exchange_pending(
            _agent_oauth_flows, agent_id, auth_code, state,
            _persist_agent, "Agent", agent_id[:12],
        )

    global _oauth_code_verifier
    if _oauth_code_verifier and state == _oauth_state:
        return await exchange_auth_code(code)

    return None
