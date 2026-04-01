"""#!/usr/bin/env python3
\"\"\"
Coder Service - Claude Code Mapper
FastAPI proxy that invokes Claude Code CLI in headless mode.
Provides an autonomous AI agent with full access to dev tools via mounted volumes.
\"\"\"

import os
import re
import asyncio
import logging
import json
import time
import uuid
import subprocess
import io
import hashlib
import base64
import secrets
import traceback
from typing import Optional
from contextlib import asynccontextmanager, redirect_stdout, redirect_stderr
from fastapi import FastAPI, HTTPException, Header
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import uvicorn

# Configure logging
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
if LOG_LEVEL not in {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"}:
    LOG_LEVEL = "INFO"
VERBOSE = os.getenv("VERBOSE", "false").lower() in ("true", "1", "yes")
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger(__name__)

if not VERBOSE:
    for noisy in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

app = FastAPI(
    title="Coder Service",
    description="AI agent powered by Claude Code CLI (headless mode)",
    version="4.0.0",
)

# Configuration
CLAUDE_MODEL = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514")
CLAUDE_MAX_TURNS = int(os.getenv("CLAUDE_MAX_TURNS", "50"))
TIMEOUT = int(os.getenv("TIMEOUT", "600"))
API_KEY = os.getenv("API_KEY", "change-me-in-production")
PROJECTS_DIR = os.getenv("PROJECTS_DIR", "/projects")
ALLOWED_TOOLS = os.getenv("CLAUDE_ALLOWED_TOOLS", "")
# Working directory for Claude Code CLI. Use /app (not PROJECTS_DIR) to avoid
# loading stale CLAUDE.md files from mounted project volumes.
CLAUDE_CWD = "/app"

# System prompt for Claude Code
SYSTEM_PROMPT = os.getenv("CLAUDE_SYSTEM_PROMPT", (
    "You are an autonomous code execution agent running inside a Docker container. "
    "You have full access to: Python 3.12, Node.js 22, bash, git, Docker CLI, "
    "PostgreSQL client, SQLite, and all standard Unix tools. "
    "Project files are mounted at /projects/. "
    "You can read, write, and execute code freely. "
    "Be concise and provide actionable results."
))

# ─── Per-Agent Linux User Isolation ──────────────────────────────────────────
import shutil

_agent_user_lock = None  # Lazily initialized (asyncio.Lock needs a running event loop)
_agent_users: dict[str, dict] = {}

def _sanitize_agent_id(agent_id: str) -> str:
    sanitized = re.sub(r'[^a-zA-Z0-9]', '', agent_id)[:24]
    return f"agent_{sanitized}" if sanitized else "agent_default"

async def ensure_agent_user(agent_id: str) -> dict:
    """Create an isolated home directory for the given agent ID.
    
    Instead of creating Linux users (requires root), we create separate
    home directories and override HOME/USER env vars. Claude Code CLI
    uses $HOME to find its config files, so this provides effective isolation.
    
    Each agent has its OWN OAuth credentials — we only copy settings and
    onboarding files from the main coder user, NOT credentials.
    """
    if not agent_id:
        return None
    if agent_id in _agent_users:
        return _agent_users[agent_id]
    global _agent_user_lock
    if _agent_user_lock is None:
        _agent_user_lock = asyncio.Lock()
    async with _agent_user_lock:
        if agent_id in _agent_users:
            return _agent_users[agent_id]
        username = _sanitize_agent_id(agent_id)
        # Use /app/data/agents/ for persistent storage (mounted volume)
        home_dir = os.path.join(DATA_DIR, "agents", username)
        try:
            agent_claude_dir = os.path.join(home_dir, ".claude")
            os.makedirs(agent_claude_dir, exist_ok=True)
            # Copy NON-credential config files from the main coder user
            coder_home = os.path.expanduser("~")
            # 1. Settings (MCP servers config) — shared across agents
            coder_settings = os.path.join(coder_home, ".claude", "settings.json")
            if os.path.exists(coder_settings):
                shutil.copy2(coder_settings, os.path.join(agent_claude_dir, "settings.json"))
            # 2. Onboarding bypass (.claude.json in home root)
            coder_claude_json = os.path.join(coder_home, ".claude.json")
            if os.path.exists(coder_claude_json):
                shutil.copy2(coder_claude_json, os.path.join(home_dir, ".claude.json"))
            # NOTE: Credentials are NOT copied. Each agent authenticates
            # independently via /auth/agent/{agent_id}/login.
            user_info = {"username": username, "uid": os.getuid(), "gid": os.getgid(), "home": home_dir}
            _agent_users[agent_id] = user_info
            logger.info(f"[Agent User] Created isolated home for agent {agent_id[:12]} at {home_dir}")
            return user_info
        except Exception as e:
            logger.error(f"[Agent User] Failed to create home for agent {agent_id}: {e}")
            return None


def _load_agent_token(agent_user: dict) -> Optional[str]:
    """Load the OAuth token specific to an agent from its isolated home dir."""
    if not agent_user:
        return None
    home = agent_user["home"]
    # 1. Agent-specific token JSON (written by per-agent auth flow)
    agent_token_json = os.path.join(home, "oauth_token.json")
    try:
        with open(agent_token_json) as f:
            data = json.load(f)
        token = data.get("accessToken")
        if token:
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    # 2. Agent credentials.json
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


def _save_agent_token(agent_user: dict, token: str, refresh_token: Optional[str] = None, expires_in: int = 28800):
    """Save an OAuth token for a specific agent in its isolated home."""
    home = agent_user["home"]
    os.makedirs(home, exist_ok=True)
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    # Save agent token JSON
    with open(os.path.join(home, "oauth_token.json"), "w") as f:
        json.dump(oauth_data, f, indent=2)
    # Also write credentials.json for CLI compatibility
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


def _is_agent_token_expired(agent_user: dict, margin_seconds: int = 300) -> bool:
    """Check if an agent's OAuth token is expired."""
    if not agent_user:
        return False
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


def _get_agent_refresh_token(agent_user: dict) -> Optional[str]:
    """Get the refresh token for an agent."""
    if not agent_user:
        return None
    agent_token_json = os.path.join(agent_user["home"], "oauth_token.json")
    try:
        with open(agent_token_json) as f:
            return json.load(f).get("refreshToken") or None
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


async def _refresh_agent_token(agent_user: dict) -> bool:
    """Refresh an agent's OAuth token using its own refresh token."""
    refresh_token = _get_agent_refresh_token(agent_user)
    if not refresh_token:
        logger.warning(f"[Agent Auth] No refresh token for {agent_user['username']}")
        return False
    payload = {
        "grant_type": "refresh_token",
        "client_id": OAUTH_CLIENT_ID,
        "refresh_token": refresh_token,
    }
    result = await _token_http_request(payload, f"agent {agent_user['username']} token refresh")
    if not result or result.get("_already_valid"):
        return bool(result)
    access_token = result.get("access_token")
    if not access_token:
        logger.error(f"[Agent Auth] Refresh response missing access_token for {agent_user['username']}")
        return False
    new_refresh = result.get("refresh_token", refresh_token)
    expires_in = result.get("expires_in", 28800)
    _save_agent_token(agent_user, access_token, refresh_token=new_refresh, expires_in=expires_in)
    logger.info(f"[Agent Auth] Token refreshed for {agent_user['username']}")
    return True


def _get_agent_env(agent_user: dict = None) -> dict:
    """Build env for agent subprocess. Uses agent's own OAuth token if available."""
    if agent_user:
        # Build env with agent-specific token (don't use global token