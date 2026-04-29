"""
Runner Service — Authentication HTTP routes (delegates to BACKEND).

Routes return 501 when the active backend doesn't support the operation
(e.g. OpenClaw doesn't have OAuth login).
"""

from typing import Optional
from fastapi import APIRouter, HTTPException, Header

from models import TokenRequest, AgentAuthCallback, OwnerAuthCallback
from security import extract_api_key, verify_api_key
from backends import BACKEND

router = APIRouter()


def _require_oauth():
    if not BACKEND.supports_oauth_login:
        raise HTTPException(
            status_code=501,
            detail=f"Backend '{BACKEND.name}' does not support OAuth login.",
        )


def _require_token_set():
    if not BACKEND.supports_token_set:
        raise HTTPException(
            status_code=501,
            detail=f"Backend '{BACKEND.name}' does not support token-based auth.",
        )


# =============================================================================
# Global auth routes
# =============================================================================

@router.get("/auth/status")
async def auth_status(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return await BACKEND.auth_status()


@router.post("/auth/token")
async def set_auth_token(
    request: TokenRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_token_set()

    token = request.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token cannot be empty")

    await BACKEND.auth_set_token(token)
    return {"status": "success", "message": "Token saved."}


@router.post("/auth/login")
async def auth_login(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_oauth()

    status = await BACKEND.auth_status()
    if status.get("authenticated"):
        return {"status": "authenticated", "method": status.get("method")}

    url = await BACKEND.auth_login_url()
    return {
        "status": "pending",
        "login_url": url,
        "message": "Open this URL, then send the verification code as your next message.",
    }


# =============================================================================
# Per-agent auth routes
# =============================================================================

@router.get("/auth/agent/{agent_id}/status")
async def agent_auth_status(
    agent_id: str,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return await BACKEND.agent_auth_status(agent_id)


@router.post("/auth/agent/{agent_id}/login")
async def agent_auth_login(
    agent_id: str,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_oauth()

    status = await BACKEND.agent_auth_status(agent_id)
    if status.get("authenticated") and not status.get("expired"):
        return {"status": "authenticated", "agent_id": agent_id}

    url = await BACKEND.agent_auth_login_url(agent_id)
    if not url:
        raise HTTPException(status_code=500, detail="Failed to generate login URL")
    return {
        "status": "pending",
        "agent_id": agent_id,
        "login_url": url,
        "message": "Open this URL in your browser, then POST the verification code to /auth/agent/{agent_id}/callback.",
    }


@router.post("/auth/agent/{agent_id}/callback")
async def agent_auth_callback(
    agent_id: str,
    request: AgentAuthCallback,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_oauth()

    code = request.code.strip()
    if not code:
        raise HTTPException(status_code=400, detail="Code cannot be empty")

    result = await BACKEND.agent_auth_callback(agent_id, code)
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("message"))
    return result


@router.post("/auth/agent/{agent_id}/token")
async def agent_set_token(
    agent_id: str,
    request: TokenRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_token_set()

    token = request.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token cannot be empty")

    await BACKEND.agent_set_token(agent_id, token)
    return {"status": "success", "agent_id": agent_id, "message": "Token saved for this agent."}


# =============================================================================
# Per-owner auth routes
# =============================================================================

@router.get("/auth/owner/{owner_id}/status")
async def owner_auth_status(
    owner_id: str,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return await BACKEND.owner_auth_status(owner_id)


@router.post("/auth/owner/{owner_id}/login")
async def owner_auth_login(
    owner_id: str,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_oauth()

    status = await BACKEND.owner_auth_status(owner_id)
    if status.get("authenticated") and not status.get("expired"):
        return {"status": "authenticated", "owner_id": owner_id}

    url = await BACKEND.owner_auth_login_url(owner_id)
    if not url:
        raise HTTPException(status_code=500, detail="Failed to generate login URL")
    return {
        "status": "pending",
        "owner_id": owner_id,
        "login_url": url,
        "message": "Open this URL in your browser, then POST the verification code to /auth/owner/{owner_id}/callback.",
    }


@router.post("/auth/owner/{owner_id}/callback")
async def owner_auth_callback(
    owner_id: str,
    request: OwnerAuthCallback,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_oauth()

    code = request.code.strip()
    if not code:
        raise HTTPException(status_code=400, detail="Code cannot be empty")

    result = await BACKEND.owner_auth_callback(owner_id, code)
    if result.get("status") == "error":
        raise HTTPException(status_code=400, detail=result.get("message"))
    return result


@router.post("/auth/owner/{owner_id}/token")
async def owner_set_token(
    owner_id: str,
    request: TokenRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    _require_token_set()

    token = request.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token cannot be empty")

    await BACKEND.owner_set_token(owner_id, token)
    return {"status": "success", "owner_id": owner_id, "message": "Token saved for this owner."}
