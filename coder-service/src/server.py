#!/usr/bin/env python3
"""
Coder Service - Claude Code Mapper
FastAPI proxy that invokes Claude Code CLI in headless mode.
Provides an autonomous AI agent with full access to dev tools via mounted volumes.
"""

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
            # Copy config files from the main coder user
            coder_home = os.path.expanduser("~")
            # 1. Credentials (OAuth token for CLI)
            if os.path.exists(CREDENTIALS_FILE):
                shutil.copy2(CREDENTIALS_FILE, os.path.join(agent_claude_dir, ".credentials.json"))
            # 2. Settings (MCP servers config)
            coder_settings = os.path.join(coder_home, ".claude", "settings.json")
            if os.path.exists(coder_settings):
                shutil.copy2(coder_settings, os.path.join(agent_claude_dir, "settings.json"))
            # 3. Onboarding bypass (.claude.json in home root)
            coder_claude_json = os.path.join(coder_home, ".claude.json")
            if os.path.exists(coder_claude_json):
                shutil.copy2(coder_claude_json, os.path.join(home_dir, ".claude.json"))
            user_info = {"username": username, "uid": os.getuid(), "gid": os.getgid(), "home": home_dir}
            _agent_users[agent_id] = user_info
            logger.info(f"[Agent User] Created isolated home for agent {agent_id[:12]} at {home_dir}")
            return user_info
        except Exception as e:
            logger.error(f"[Agent User] Failed to create home for agent {agent_id}: {e}")
            return None

def _get_agent_env(agent_user: dict = None) -> dict:
    env = _get_claude_env()
    if agent_user:
        env["HOME"] = agent_user["home"]
        env["USER"] = agent_user["username"]
        env["LOGNAME"] = agent_user["username"]
    return env

def _get_subprocess_kwargs(agent_user: dict = None) -> dict:
    """No-op: all agents run as the same coder user, isolated by HOME dir."""
    return {}


# ─── Authentication Management (OAuth PKCE) ───────────────────────────────────

DATA_DIR = os.getenv("DATA_DIR", "/app/data")
TOKEN_FILE = os.path.join(DATA_DIR, "oauth_token")
TOKEN_JSON_FILE = os.path.join(DATA_DIR, "oauth_token.json")
CREDENTIALS_FILE = os.path.expanduser("~/.claude/.credentials.json")

# OAuth configuration (public client, same as Claude Code CLI)
OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers"

# Pending OAuth flow state
_auth_url: Optional[str] = None
_oauth_code_verifier: Optional[str] = None
_oauth_state: Optional[str] = None

# Rate limiting: prevent concurrent token requests and enforce cooldowns
_token_request_lock = asyncio.Lock()
_token_cooldown_until: float = 0  # timestamp: no token request before this time


def _load_saved_token() -> Optional[str]:
    """Load persisted OAuth token (check env, persistent JSON, token file, then credentials file).

    When loading from the persistent JSON in /app/data, also restores
    ~/.claude/.credentials.json so the CLI subprocess can use it.
    """
    token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
    if token:
        return token
    # Try persistent JSON (has refresh token + expiry)
    try:
        with open(TOKEN_JSON_FILE) as f:
            oauth_data = json.load(f)
        token = oauth_data.get("accessToken")
        if token:
            # Restore credentials.json for CLI compatibility (lost on container restart)
            _restore_credentials_file(oauth_data)
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    # Fallback: plain text token file
    try:
        with open(TOKEN_FILE) as f:
            token = f.read().strip()
        if token:
            return token
    except (OSError, FileNotFoundError):
        pass
    # Fallback: CLI credentials file
    try:
        with open(CREDENTIALS_FILE) as f:
            creds = json.load(f)
        token = creds.get("claudeAiOauth", {}).get("accessToken")
        if token:
            return token
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        pass
    return None


def _restore_credentials_file(oauth_data: dict):
    """Restore ~/.claude/.credentials.json from persistent OAuth data."""
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


def _save_token(token: str, refresh_token: Optional[str] = None, expires_in: int = 28800):
    """Persist OAuth token to multiple locations for CLI compatibility."""
    os.makedirs(DATA_DIR, exist_ok=True)
    # Plain text token file (backward compat)
    with open(TOKEN_FILE, "w") as f:
        f.write(token)
    # Full OAuth data as JSON in persistent volume
    oauth_data = {
        "accessToken": token,
        "refreshToken": refresh_token or "",
        "expiresAt": int((time.time() + expires_in) * 1000),
        "scopes": OAUTH_SCOPES.split(),
    }
    with open(TOKEN_JSON_FILE, "w") as f:
        json.dump(oauth_data, f, indent=2)
    os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = token

    # Also save to ~/.claude/.credentials.json for CLI compatibility
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


def _is_token_expired(margin_seconds: int = 300) -> bool:
    """Return True if the saved OAuth token is expired (or expires within margin_seconds)."""
    try:
        with open(TOKEN_JSON_FILE) as f:
            oauth_data = json.load(f)
        expires_at_ms = oauth_data.get("expiresAt", 0)
        if not expires_at_ms:
            return False
        return time.time() >= (expires_at_ms / 1000) - margin_seconds
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return False


def _get_saved_refresh_token() -> Optional[str]:
    """Return the saved refresh token from persistent JSON, if any."""
    try:
        with open(TOKEN_JSON_FILE) as f:
            return json.load(f).get("refreshToken") or None
    except (OSError, FileNotFoundError, json.JSONDecodeError):
        return None


async def _token_http_request(payload: dict, description: str) -> Optional[dict]:
    """Make a rate-limited HTTP request to the OAuth token endpoint.

    Uses Node.js fetch (via subprocess) instead of Python urllib because
    Cloudflare blocks Python's TLS fingerprint with a fake 429 response.
    Node.js uses the same TLS stack as Claude Code CLI and passes Cloudflare.

    Holds _token_request_lock so only one token request is in flight at a time.
    Returns parsed JSON on success, None on failure.
    """
    import urllib.parse as urlparse

    async with _token_request_lock:
        # Check if token was refreshed by another coroutine while we waited
        if not _is_token_expired():
            logger.info("Token already valid (refreshed by another request)")
            return {"_already_valid": True}

        body_str = urlparse.urlencode(payload)
        # Use Node.js fetch to avoid Cloudflare blocking Python's TLS fingerprint
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
                return None

        except asyncio.TimeoutError:
            logger.error(f"{description}: node subprocess timed out")
            return None
        except Exception as e:
            logger.error(f"{description}: {e}", exc_info=True)
            return None


async def _refresh_oauth_token() -> bool:
    """Use the refresh token to obtain a new access token.

    Returns True on success, False on failure.
    """
    refresh_token = _get_saved_refresh_token()
    if not refresh_token:
        logger.warning("No refresh token available - cannot refresh, need full re-auth")
        return False

    payload = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
        "client_id": OAUTH_CLIENT_ID,
    }

    try:
        result = await _token_http_request(payload, "Refreshing OAuth token")
        if result is None:
            return False
        if result.get("_already_valid"):
            return True

        access_token = result.get("access_token")
        if not access_token:
            logger.error(f"Refresh response missing access_token: {result}")
            return False

        new_refresh = result.get("refresh_token") or refresh_token
        expires_in = result.get("expires_in", 28800)
        _save_token(access_token, refresh_token=new_refresh, expires_in=expires_in)
        logger.info("OAuth token refreshed successfully")
        return True

    except Exception as e:
        logger.error(f"Token refresh failed: {e}", exc_info=True)
        return False


def _get_claude_env() -> dict:
    """Build environment dict for Claude CLI subprocess, including saved token."""
    env = {**os.environ, "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"}
    if not env.get("CLAUDE_CODE_OAUTH_TOKEN"):
        saved = _load_saved_token()
        if saved:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = saved
    return env


def _auth_method() -> str:
    """Return current auth method: oauth, api_key, or none."""
    if os.environ.get("CLAUDE_CODE_OAUTH_TOKEN") or _load_saved_token():
        return "oauth"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "api_key"
    return "none"


def _claude_auth_status() -> dict:
    """Get auth status from `claude auth status` (returns JSON)."""
    try:
        result = subprocess.run(
            ["claude", "auth", "status"],
            capture_output=True, text=True, timeout=10,
            env=_get_claude_env(),
        )
        if result.returncode == 0 and result.stdout.strip():
            return json.loads(result.stdout.strip())
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError) as e:
        logger.debug(f"claude auth status failed: {e}")
    return {}


# Verification code pattern: auth_code#state (long alphanumeric with #, _, -)
_CODE_RE = re.compile(r'^[A-Za-z0-9_#-]{20,}$')


def _extract_code_from_prompt(prompt: str) -> Optional[str]:
    """Extract a verification code from a prompt (may be wrapped in conversation format).

    Handles:
    - Raw code: "oAb7X8p0ADm...#state..."
    - Single message: "User: oAb7X8p0ADm..."
    - Full conversation: "User: hello\\nAssistant: ...\\nUser: oAb7X8p0ADm..."
    Returns None if the last user message doesn't look like a code.
    """
    last_user_msg = prompt.strip()
    for line in reversed(prompt.strip().split('\n')):
        line = line.strip()
        if line.startswith("User: "):
            last_user_msg = line[6:].strip()
            break

    if _CODE_RE.match(last_user_msg):
        return last_user_msg
    return None


def _generate_pkce() -> tuple[str, str]:
    """Generate PKCE code_verifier and code_challenge (S256)."""
    code_verifier = secrets.token_urlsafe(64)[:128]
    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return code_verifier, code_challenge


def _build_auth_url() -> str:
    """Build OAuth authorization URL with PKCE and store state for later exchange."""
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


def requests_encode(value: str) -> str:
    """URL-encode a value (percent-encoding)."""
    import urllib.parse
    return urllib.parse.quote(value, safe="")


async def _exchange_auth_code(full_code: str) -> dict:
    """Exchange the authorization code for OAuth tokens.

    The code from the browser callback is formatted as: {auth_code}#{state}
    """
    global _oauth_code_verifier, _oauth_state, _auth_url

    if not _oauth_code_verifier:
        return {"status": "error", "message": "No login flow in progress. Start one first."}

    # Split code on # - format is auth_code#state
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
        result = await _token_http_request(payload, f"Exchanging auth code ({len(auth_code)} chars)")

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

        _save_token(access_token, refresh_token=refresh_token, expires_in=expires_in)

        email = result.get("account", {}).get("email", "")
        logger.info(f"OAuth token exchange successful: {email}")

        # Clear OAuth flow state
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


async def _get_login_url() -> str:
    """Generate an OAuth authorization URL with PKCE."""
    url = _build_auth_url()
    logger.info(f"Generated OAuth URL: {url[:80]}...")
    return url


def _build_claude_cmd(output_format: str = "json", system_prompt: Optional[str] = None) -> list[str]:
    """Build the claude CLI command with appropriate flags.

    The prompt is passed via stdin (not as a CLI argument) to avoid
    'Argument list too long' errors with large conversation histories.
    """
    cmd = [
        "claude",
        "-p",
        "--output-format", output_format,
        "--max-turns", str(CLAUDE_MAX_TURNS),
        "--model", CLAUDE_MODEL,
        # Headless mode: skip all permission prompts so the agent can run autonomously
        "--dangerously-skip-permissions",
        "--effort", "high",
    ]

    # Append to the default system prompt instead of replacing it, so Claude Code
    # retains its built-in tool knowledge and capabilities.
    sp = system_prompt or SYSTEM_PROMPT
    if sp:
        cmd.extend(["--append-system-prompt", sp])

    # --verbose is required for stream-json output format in print mode
    if VERBOSE or output_format == "stream-json":
        cmd.append("--verbose")

    if ALLOWED_TOOLS:
        for tool in ALLOWED_TOOLS.split(","):
            tool = tool.strip()
            if tool:
                cmd.extend(["--allowedTools", tool])

    # Give Claude Code access to the projects directory without using it as cwd.
    # This avoids loading stale CLAUDE.md files from mounted project volumes.
    if os.path.isdir(PROJECTS_DIR):
        cmd.extend(["--add-dir", PROJECTS_DIR])

    return cmd


# ─── Claude Code Execution ────────────────────────────────────────────────────

async def run_claude_sync(prompt: str, system_prompt: Optional[str] = None, agent_id: Optional[str] = None) -> dict:
    """Execute a prompt via Claude Code CLI and return parsed result.

    Uses asyncio.create_subprocess_exec instead of asyncio.to_thread to avoid
    dependency on the thread pool executor (which causes 'Executor shutdown has
    been called' errors during server restart/shutdown).
    """
    # If an OAuth flow is pending, check if the prompt contains a verification code
    if _oauth_code_verifier:
        code = _extract_code_from_prompt(prompt)
        if code:
            result = await _exchange_auth_code(code)
            if result.get("status") == "authenticated":
                return {
                    "status": "success",
                    "output": f"Authentication successful ({result.get('email', '')}). You can now send your request.",
                }
            return {
                "status": "auth_required",
                "output": "",
                "error": result.get("message", "Token exchange failed."),
                "login_url": _auth_url,
            }

    # Proactively refresh token if expired (skip if in cooldown from a recent 429)
    if _is_token_expired() and time.time() >= _token_cooldown_until:
        await _refresh_oauth_token()

    # Resolve agent-specific Linux user for isolation
    agent_user = await ensure_agent_user(agent_id) if agent_id else None

    cmd = _build_claude_cmd(output_format="json", system_prompt=system_prompt)

    agent_label = f" (user={agent_user['username']})" if agent_user else ""
    logger.info(f"Executing Claude Code{agent_label}: {prompt[:100]}...")
    logger.debug(f"Command: {' '.join(cmd)}")

    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=CLAUDE_CWD,
            env=_get_agent_env(agent_user),
            **_get_subprocess_kwargs(agent_user),
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(
            proc.communicate(input=prompt.encode("utf-8")),
            timeout=TIMEOUT,
        )
    except asyncio.TimeoutError:
        if proc and proc.returncode is None:
            proc.terminate()
            try:
                await asyncio.wait_for(proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                proc.kill()
        return {"status": "timeout", "output": "", "error": f"Execution timeout after {TIMEOUT}s"}
    except asyncio.CancelledError:
        if proc and proc.returncode is None:
            proc.terminate()
        raise

    stdout = stdout_bytes.decode("utf-8", errors="replace").strip()
    stderr = stderr_bytes.decode("utf-8", errors="replace").strip()

    # Detect auth errors — auto-trigger login flow or token refresh
    combined = f"{stdout} {stderr}".lower()
    if "token has expired" in combined or ("authentication_error" in combined and "401" in combined):
        logger.warning("Claude Code auth error: token expired, attempting refresh...")
        refreshed = await _refresh_oauth_token()
        if refreshed:
            logger.info("Token refreshed, retrying request...")
            return await run_claude_sync(prompt, system_prompt)
        login_url = await _get_login_url()
        return {
            "status": "auth_required",
            "output": "",
            "error": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
            "login_url": login_url,
        }

    if "not logged in" in combined:
        logger.warning("Claude Code auth error: not logged in, initiating login flow...")
        login_url = await _get_login_url()
        if login_url:
            return {
                "status": "auth_required",
                "output": "",
                "error": f"Not authenticated. Open this URL: {login_url} — then send the verification code as your next message.",
                "login_url": login_url,
            }
        return {
            "status": "auth_required",
            "output": "",
            "error": "Not authenticated. Call POST /auth/login to start, or POST a token to /auth/token.",
        }

    if proc.returncode != 0 and not stdout:
        error_msg = stderr if stderr else f"Claude Code exited with code {proc.returncode}"
        logger.error(f"Claude Code error: {error_msg}")
        return {"status": "error", "output": "", "error": error_msg}

    # Parse JSON output
    try:
        parsed = json.loads(stdout)
        output_text = parsed.get("result", stdout)
        cost = parsed.get("cost_usd", 0)
        duration = parsed.get("duration_ms", 0)
        total_tokens = parsed.get("total_tokens", 0)

        if VERBOSE:
            logger.info(f"Claude Code completed: cost=${cost:.4f}, duration={duration}ms, tokens={total_tokens}")

        return {
            "status": "success",
            "output": output_text,
            "cost_usd": cost,
            "duration_ms": duration,
            "total_tokens": total_tokens,
        }
    except json.JSONDecodeError:
        # If not valid JSON, treat raw stdout as the result
        return {"status": "success", "output": stdout}


async def stream_claude_events(prompt: str, system_prompt: Optional[str] = None, agent_id: Optional[str] = None):
    """Async generator - streams Claude Code events in real-time.

    Yields status updates as the agent works, then the final result.
    """
    # If an OAuth flow is pending, check if the prompt contains a verification code
    if _oauth_code_verifier:
        code = _extract_code_from_prompt(prompt)
        if code:
            result = await _exchange_auth_code(code)
            if result.get("status") == "authenticated":
                yield {
                    "type": "result",
                    "content": f"Authentication successful ({result.get('email', '')}). You can now send your request.",
                }
                return
            yield {
                "type": "error",
                "content": result.get("message", "Token exchange failed."),
                "login_url": _auth_url,
            }
            return

    # Proactively refresh token if expired (skip if in cooldown from a recent 429)
    if _is_token_expired() and time.time() >= _token_cooldown_until:
        refreshed = await _refresh_oauth_token()
        if not refreshed:
            login_url = await _get_login_url()
            yield {
                "type": "error",
                "content": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                "login_url": login_url,
            }
            return

    # Resolve agent-specific Linux user for isolation
    agent_user = await ensure_agent_user(agent_id) if agent_id else None

    cmd = _build_claude_cmd(output_format="stream-json", system_prompt=system_prompt)

    agent_label = f" (user={agent_user['username']})" if agent_user else ""
    logger.info(f"Streaming Claude Code{agent_label}: {prompt[:100]}...")

    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=CLAUDE_CWD,
        env=_get_agent_env(agent_user),
        limit=10 * 1024 * 1024,
        **_get_subprocess_kwargs(agent_user),  # 10MB readline buffer (default 64KB too small for large JSON events)
    )

    # Send prompt via stdin (avoids ARG_MAX limit) then close stdin
    proc.stdin.write(prompt.encode("utf-8"))
    await proc.stdin.drain()
    proc.stdin.close()
    await proc.stdin.wait_closed()

    try:
        async for line in proc.stdout:
            line = line.decode("utf-8", errors="replace").strip()
            if not line:
                continue

            # Detect auth errors in stream
            line_lower = line.lower()
            if "token has expired" in line_lower or ("authentication_error" in line_lower and "401" in line_lower):
                proc.terminate()
                logger.warning(f"Expired token detected in stream: {line[:120]}")
                refreshed = await _refresh_oauth_token()
                if refreshed:
                    yield {"type": "status", "content": "Token refreshed, retrying..."}
                    async for ev in stream_claude_events(prompt, system_prompt):
                        yield ev
                else:
                    login_url = await _get_login_url()
                    yield {
                        "type": "error",
                        "content": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                        "login_url": login_url,
                    }
                return

            if "not logged in" in line_lower:
                proc.terminate()
                login_url = await _get_login_url()
                if login_url:
                    yield {
                        "type": "error",
                        "content": f"Not authenticated. Open this URL: {login_url} — then send the verification code as your next message.",
                        "login_url": login_url,
                    }
                else:
                    yield {
                        "type": "error",
                        "content": "Not authenticated. Call POST /auth/login to start, or POST a token to /auth/token.",
                    }
                return

            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                # Non-JSON output, yield as-is
                yield {"type": "text", "content": line}
                continue

            event_type = event.get("type", "")

            if event_type == "assistant":
                # Assistant message content
                message = event.get("message", {})
                content = message.get("content", "")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            yield {"type": "text", "content": block.get("text", "")}
                        elif isinstance(block, dict) and block.get("type") == "tool_use":
                            tool_name = block.get("name", "unknown")
                            yield {"type": "status", "content": f"Using tool: {tool_name}"}
                elif isinstance(content, str) and content:
                    yield {"type": "text", "content": content}

            elif event_type == "tool_use":
                tool_name = event.get("name", "unknown")
                yield {"type": "status", "content": f"Using tool: {tool_name}"}

            elif event_type == "tool_result":
                # Tool execution result (skip in stream, agent processes it)
                pass

            elif event_type == "result":
                # Final result
                result_text = event.get("result", "")
                cost = event.get("cost_usd", 0)
                duration = event.get("duration_ms", 0)
                if result_text:
                    yield {"type": "result", "content": result_text, "cost_usd": cost, "duration_ms": duration}

            elif event_type == "error":
                error_msg = event.get("error", {})
                if isinstance(error_msg, dict):
                    error_msg = error_msg.get("message", str(error_msg))
                error_str = str(error_msg)
                # Auto-refresh on expired token error
                if "token has expired" in error_str.lower() or "oauth token" in error_str.lower():
                    proc.terminate()
                    logger.warning(f"Token expired mid-stream: {error_str}")
                    refreshed = await _refresh_oauth_token()
                    if refreshed:
                        yield {"type": "status", "content": "Token refreshed, retrying..."}
                        # Re-run the full request with the new token
                        async for ev in stream_claude_events(prompt, system_prompt):
                            yield ev
                    else:
                        login_url = await _get_login_url()
                        yield {
                            "type": "error",
                            "content": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                            "login_url": login_url,
                        }
                    return
                yield {"type": "error", "content": error_str}

            else:
                # Other event types - log but don't stream
                if VERBOSE:
                    logger.debug(f"Unhandled event type: {event_type}")

    except asyncio.CancelledError:
        proc.terminate()
        raise
    finally:
        await proc.wait()

    if proc.returncode != 0:
        stderr = await proc.stderr.read()
        stderr_text = stderr.decode("utf-8", errors="replace").strip()
        if stderr_text:
            yield {"type": "error", "content": stderr_text}


# ─── Direct Code Execution (bypass Claude) ────────────────────────────────────

MAX_OUTPUT = 2000


def execute_python(code: str) -> str:
    """Execute Python code and capture output."""
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, {"__builtins__": __builtins__})
        out = stdout_buf.getvalue()
        err = stderr_buf.getvalue()
        result = out
        if err:
            result += f"\n[stderr] {err}"
        return result[:MAX_OUTPUT] if result else "(no output)"
    except Exception:
        return traceback.format_exc()[:MAX_OUTPUT]


def execute_shell(code: str) -> str:
    """Execute shell commands and capture output."""
    try:
        result = subprocess.run(
            code,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=PROJECTS_DIR if os.path.isdir(PROJECTS_DIR) else None,
        )
        out = result.stdout
        if result.stderr:
            out += f"\n[stderr] {result.stderr}"
        if result.returncode != 0:
            out += f"\n[exit code: {result.returncode}]"
        return out[:MAX_OUTPUT] if out else "(no output)"
    except subprocess.TimeoutExpired:
        return "[error] Command timed out after 60s"
    except Exception:
        return traceback.format_exc()[:MAX_OUTPUT]


# ─── Security Helpers ─────────────────────────────────────────────────────────

def extract_api_key(x_api_key: Optional[str], authorization: Optional[str]) -> Optional[str]:
    if x_api_key:
        return x_api_key
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


def verify_api_key(api_key: Optional[str]):
    if not api_key:
        raise HTTPException(status_code=401, detail="Missing API key (X-API-Key or Authorization: Bearer)")
    if api_key != API_KEY:
        raise HTTPException(status_code=403, detail="Invalid API key")
    return api_key


# ─── Request/Response Models ──────────────────────────────────────────────────

class MessageRequest(BaseModel):
    content: str
    system_prompt: Optional[str] = None

class ExecutionResponse(BaseModel):
    status: str
    output: str
    cost_usd: Optional[float] = None
    duration_ms: Optional[int] = None
    total_tokens: Optional[int] = None
    error: Optional[str] = None
    login_url: Optional[str] = None

class CodeRequest(BaseModel):
    code: str
    language: str = "python"

class OpenAIChatMessage(BaseModel):
    role: str
    content: str

class OpenAIChatCompletionRequest(BaseModel):
    model: Optional[str] = None
    messages: list[OpenAIChatMessage]
    stream: bool = False
    system_prompt: Optional[str] = None

class OpenAICompletionRequest(BaseModel):
    model: Optional[str] = None
    prompt: str
    stream: bool = False
    system_prompt: Optional[str] = None

class TokenRequest(BaseModel):
    token: str


def chunk_text(text: str, size: int = 700):
    if not text:
        return
    for i in range(0, len(text), size):
        yield text[i:i + size]


def _messages_to_prompt(messages: list[OpenAIChatMessage]) -> tuple[str, Optional[str]]:
    """Convert OpenAI chat messages to a single prompt + optional system prompt.

    Returns (prompt, system_prompt).
    """
    system_parts = []
    conversation_parts = []

    for msg in messages:
        if msg.role == "system":
            system_parts.append(msg.content)
        elif msg.role == "user":
            conversation_parts.append(f"User: {msg.content}")
        elif msg.role == "assistant":
            conversation_parts.append(f"Assistant: {msg.content}")

    system_prompt = "\n\n".join(system_parts) if system_parts else None

    # If only one user message with no assistant context, pass it directly
    user_messages = [m for m in messages if m.role == "user"]
    if len(conversation_parts) == 1 and len(user_messages) == 1:
        prompt = user_messages[0].content
    else:
        prompt = "\n".join(conversation_parts)

    return prompt, system_prompt


# ─── Auth Routes ──────────────────────────────────────────────────────────────

@app.get("/auth/status")
async def auth_status(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Check current authentication status (uses `claude auth status`)."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    # Prefer CLI auth status for accurate info
    cli_status = _claude_auth_status()
    if cli_status.get("loggedIn"):
        return {
            "authenticated": True,
            "method": cli_status.get("authMethod", "unknown"),
            "email": cli_status.get("email"),
            "subscription": cli_status.get("subscriptionType"),
        }
    # Fallback to env-based check
    method = _auth_method()
    return {"authenticated": method != "none", "method": method}


@app.post("/auth/token")
async def set_auth_token(
    request: TokenRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Set OAuth token for subscription-based authentication.

    Generate a token on a machine with a browser: claude setup-token
    Then POST it here.
    """
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    token = request.token.strip()
    if not token:
        raise HTTPException(status_code=400, detail="Token cannot be empty")

    _save_token(token)
    return {
        "status": "success",
        "message": "OAuth token saved. Subscription plan will be used for subsequent requests.",
    }


@app.post("/auth/login")
async def auth_login(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Initiate OAuth PKCE login flow and return the authorization URL."""
    global _auth_url

    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    # Already authenticated?
    cli_status = _claude_auth_status()
    if cli_status.get("loggedIn"):
        return {"status": "authenticated", "method": cli_status.get("authMethod")}
    method = _auth_method()
    if method != "none":
        return {"status": "authenticated", "method": method}

    # Cached URL from a previous attempt?
    if _auth_url:
        return {
            "status": "pending",
            "login_url": _auth_url,
            "message": "Open this URL in your browser to authenticate with your Claude subscription.",
        }

    url = await _get_login_url()
    _auth_url = url
    return {
        "status": "pending",
        "login_url": url,
        "message": "Open this URL, then send the verification code as your next message.",
    }


# ─── Routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    # Check Claude Code CLI is available
    try:
        result = subprocess.run(
            ["claude", "--version"],
            capture_output=True, text=True, timeout=10,
        )
        claude_ok = result.returncode == 0
        claude_version = result.stdout.strip() if claude_ok else None
    except Exception:
        claude_ok = False
        claude_version = None

    return {
        "status": "healthy" if claude_ok else "degraded",
        "service": "coder-service",
        "agent_backend": "claude-code",
        "claude_version": claude_version,
        "claude_model": CLAUDE_MODEL,
    }


@app.get("/docs-openapi")
async def docs_openapi(x_api_key: str = Header(None)):
    return app.openapi()


@app.post("/execute", response_model=ExecutionResponse)
async def execute_message(
    request: MessageRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
):
    """Execute a natural language request via Claude Code CLI."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    result = await run_claude_sync(request.content, request.system_prompt, agent_id=x_agent_id)
    return ExecutionResponse(**result)


@app.post("/code/execute", response_model=ExecutionResponse)
async def execute_code(
    request: CodeRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Direct code execution endpoint (bypass Claude Code)."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    try:
        logger.info(f"Executing {request.language} code ({len(request.code)} chars)...")

        if request.language == "python":
            output = execute_python(request.code)
            return ExecutionResponse(status="success", output=output)
        elif request.language in ("shell", "bash"):
            output = execute_shell(request.code)
            return ExecutionResponse(status="success", output=output)
        else:
            return ExecutionResponse(
                status="error", output="",
                error=f"Unsupported language: {request.language}",
            )
    except Exception as e:
        logger.error(f"Code execution error: {str(e)}", exc_info=True)
        return ExecutionResponse(status="error", output="", error=str(e))


@app.post("/stream")
async def stream_execution(
    request: MessageRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
):
    """Stream execution results in real-time via SSE."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    async def event_generator():
        try:
            yield f"data: {json.dumps({'status': 'starting', 'message': 'Claude Code execution started'})}\n\n"

            has_streamed_text = False
            async for event in stream_claude_events(request.content, request.system_prompt, agent_id=x_agent_id):
                event_type = event.get("type", "")

                if event_type == "status":
                    yield f"data: {json.dumps({'status': 'working', 'output': event['content']}, ensure_ascii=False)}\n\n"
                elif event_type == "text":
                    yield f"data: {json.dumps({'status': 'streaming', 'output': event['content']}, ensure_ascii=False)}\n\n"
                    has_streamed_text = True
                elif event_type == "result":
                    # Send completion signal with metadata; only include output
                    # if nothing was streamed yet (avoids duplicating content).
                    output = "" if has_streamed_text else event["content"]
                    yield f"data: {json.dumps({'status': 'success', 'output': output, 'cost_usd': event.get('cost_usd'), 'duration_ms': event.get('duration_ms')}, ensure_ascii=False)}\n\n"
                elif event_type == "error":
                    yield f"data: {json.dumps({'status': 'error', 'error': event['content']}, ensure_ascii=False)}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@app.post("/reset")
async def reset_agent(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Reset agent state (no-op, Claude Code is stateless per invocation)."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return {"status": "success", "message": "Agent is stateless, no state to reset"}


@app.get("/v1/models")
async def openai_models(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return {
        "object": "list",
        "data": [
            {
                "id": CLAUDE_MODEL,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "anthropic",
            }
        ],
    }


@app.post("/v1/chat/completions")
async def openai_chat_completions(
    request: OpenAIChatCompletionRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not request.messages:
        raise HTTPException(status_code=400, detail="At least one message is required")

    prompt, system_prompt = _messages_to_prompt(request.messages)
    # Request-level system_prompt overrides messages-derived one
    if request.system_prompt:
        system_prompt = request.system_prompt

    model = request.model or CLAUDE_MODEL

    async def stream_openai_response():
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        # Send initial role delta
        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]})}\n\n"

        has_streamed_text = False
        async for event in stream_claude_events(prompt, system_prompt, agent_id=x_agent_id):
            event_type = event.get("type", "")

            if event_type == "text":
                content = event["content"]
                yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': content}, 'finish_reason': None}]})}\n\n"
                has_streamed_text = True
            elif event_type == "result":
                # Only send the final result if we haven't already streamed
                # text events (which contain the same content).
                if not has_streamed_text:
                    content = event["content"]
                    for piece in chunk_text(content):
                        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': piece}, 'finish_reason': None}]})}\n\n"
            elif event_type == "error":
                content = event["content"]
                yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': content}, 'finish_reason': None}]})}\n\n"

        # Send finish
        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})}\n\n"
        yield "data: [DONE]\n\n"

    if request.stream:
        return StreamingResponse(stream_openai_response(), media_type="text/event-stream")

    # Non-streaming: run synchronously
    result = await run_claude_sync(prompt, system_prompt, agent_id=x_agent_id)
    content = result.get("output", "") if result.get("status") == "success" else (result.get("error") or "Execution failed")

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": result.get("total_tokens", 0),
            "completion_tokens": 0,
            "total_tokens": result.get("total_tokens", 0),
        },
    }


@app.post("/v1/completions")
async def openai_completions(
    request: OpenAICompletionRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    model = request.model or CLAUDE_MODEL

    async def stream_openai_completion_response():
        completion_id = f"cmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        has_streamed_text = False
        async for event in stream_claude_events(request.prompt, request.system_prompt, agent_id=x_agent_id):
            event_type = event.get("type", "")

            if event_type == "text":
                content = event["content"]
                for piece in chunk_text(content):
                    yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': piece, 'finish_reason': None}]})}\n\n"
                has_streamed_text = True
            elif event_type == "result":
                if not has_streamed_text:
                    content = event["content"]
                    for piece in chunk_text(content):
                        yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': piece, 'finish_reason': None}]})}\n\n"
            elif event_type == "error":
                yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': event['content'], 'finish_reason': None}]})}\n\n"

        yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': '', 'finish_reason': 'stop'}]})}\n\n"
        yield "data: [DONE]\n\n"

    if request.stream:
        return StreamingResponse(stream_openai_completion_response(), media_type="text/event-stream")

    result = await run_claude_sync(request.prompt, request.system_prompt, agent_id=x_agent_id)
    content = result.get("output", "") if result.get("status") == "success" else (result.get("error") or "Execution failed")

    return {
        "id": f"cmpl-{uuid.uuid4().hex}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "text": content, "finish_reason": "stop"}],
        "usage": {
            "prompt_tokens": result.get("total_tokens", 0),
            "completion_tokens": 0,
            "total_tokens": result.get("total_tokens", 0),
        },
    }


# ─── Lifespan ─────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(application: FastAPI):
    """Startup/shutdown lifecycle for FastAPI."""
    logger.info("Coder Service starting (Claude Code backend)...")
    logger.info(f"  Model: {CLAUDE_MODEL}")
    logger.info(f"  Max turns: {CLAUDE_MAX_TURNS}")
    logger.info(f"  Timeout: {TIMEOUT}s")
    logger.info(f"  Projects dir: {PROJECTS_DIR}")

    # Check Claude Code CLI
    try:
        result = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=10)
        if result.returncode == 0:
            logger.info(f"  Claude Code CLI: {result.stdout.strip()}")
        else:
            logger.error(f"  Claude Code CLI error: {result.stderr.strip()}")
    except FileNotFoundError:
        logger.error("  Claude Code CLI not found! Install with: npm install -g @anthropic-ai/claude-code")
    except Exception as e:
        logger.error(f"  Claude Code CLI check failed: {e}")

    # Load saved token from persistent storage
    saved = _load_saved_token()
    if saved and not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
        os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = saved
        logger.info("  Loaded saved OAuth token from persistent storage")

    # Log authentication status (prefer CLI check for accuracy)
    cli_status = _claude_auth_status()
    if cli_status.get("loggedIn"):
        logger.info(f"  Auth: {cli_status.get('authMethod', 'unknown')} "
                     f"({cli_status.get('subscriptionType', 'unknown')} plan, "
                     f"{cli_status.get('email', 'no email')})")
    else:
        method = _auth_method()
        if method == "oauth":
            logger.info("  Auth: OAuth token (subscription plan)")
        elif method == "api_key":
            logger.info("  Auth: API key (API credits)")
        else:
            logger.warning("  No auth configured! Use POST /auth/login or /auth/token, or set CLAUDE_CODE_OAUTH_TOKEN env var.")

    yield

    logger.info("Coder Service shutting down...")

app.router.lifespan_context = lifespan

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
