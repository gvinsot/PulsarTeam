"""
Runner Service — Configuration, logging, and shared constants.

The service is generic: a single binary that can act as different agent
runners by selecting RUNNER_TYPE at startup (claude-code, openclaw,
hermes, opencode, sandbox).
"""

import os
import logging

# --- Runner selection ---------------------------------------------------------

RUNNER_TYPE = os.getenv("RUNNER_TYPE", "claude-code").lower().strip()
VALID_RUNNERS = {"claude-code", "openclaw", "hermes", "opencode", "sandbox"}
if RUNNER_TYPE not in VALID_RUNNERS:
    raise RuntimeError(
        f"Invalid RUNNER_TYPE={RUNNER_TYPE!r}. Must be one of: {sorted(VALID_RUNNERS)}"
    )

# --- Logging ------------------------------------------------------------------

LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
if LOG_LEVEL not in {"CRITICAL", "ERROR", "WARNING", "INFO", "DEBUG", "NOTSET"}:
    LOG_LEVEL = "INFO"
VERBOSE = os.getenv("VERBOSE", "false").lower() in ("true", "1", "yes")
logging.basicConfig(level=LOG_LEVEL)
logger = logging.getLogger(f"runner_service[{RUNNER_TYPE}]")

if not VERBOSE:
    for noisy in ("httpx", "httpcore", "urllib3"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


class HealthCheckFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        if "GET /health" in message and "200" in message:
            return False
        return True


logging.getLogger("uvicorn.access").addFilter(HealthCheckFilter())

# --- Shared constants ---------------------------------------------------------

API_KEY = os.getenv("API_KEY", "change-me-in-production")
PROJECTS_DIR = os.getenv("PROJECTS_DIR", "/projects")
DATA_DIR = os.getenv("DATA_DIR", "/app/data")
TIMEOUT = int(os.getenv("TIMEOUT", "600"))
ALLOWED_TOOLS = os.getenv("RUNNER_ALLOWED_TOOLS", os.getenv("CLAUDE_ALLOWED_TOOLS", ""))

# Working directory for the CLI subprocess. Use /app (not PROJECTS_DIR) to
# avoid loading stale config files from mounted project volumes.
CLI_CWD = "/app"

# --- Agent-specific constants -------------------------------------------------

# Generic max-turns / model — each backend may interpret these differently.
RUNNER_MODEL = os.getenv("RUNNER_MODEL", os.getenv("CLAUDE_MODEL", "claude-sonnet-4-20250514"))
RUNNER_MAX_TURNS = int(os.getenv("RUNNER_MAX_TURNS", os.getenv("CLAUDE_MAX_TURNS", "50")))

SYSTEM_PROMPT = os.getenv("RUNNER_SYSTEM_PROMPT", os.getenv("CLAUDE_SYSTEM_PROMPT", (
    "You are an autonomous code execution agent running inside a Docker container. "
    "You have full access to: Python 3.12, Node.js 22, bash, git, Docker CLI, "
    "PostgreSQL client, SQLite, and all standard Unix tools. "
    "Your working directory IS the project git repository. "
    "You can read, write, and execute code freely. Use git to commit and push your changes. "
    "Be concise and provide actionable results."
)))

# --- Claude Code OAuth constants (only used by claude-code backend) -----------

TOKEN_FILE = os.path.join(DATA_DIR, "oauth_token")
TOKEN_JSON_FILE = os.path.join(DATA_DIR, "oauth_token.json")
CREDENTIALS_FILE = os.path.expanduser("~/.claude/.credentials.json")

OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
OAUTH_AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token"
OAUTH_REDIRECT_URI = "https://platform.claude.com/oauth/code/callback"
OAUTH_SCOPES = "user:profile user:inference user:sessions:claude_code user:mcp_servers"

USERS_DIR = os.path.join(DATA_DIR, "users")

# Backwards-compat aliases (so we don't have to update every file at once)
CLAUDE_MODEL = RUNNER_MODEL
CLAUDE_MAX_TURNS = RUNNER_MAX_TURNS
CLAUDE_CWD = CLI_CWD
