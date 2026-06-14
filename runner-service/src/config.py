"""
Runner Service — Configuration, logging, and shared constants.

The service is generic: a single binary that can act as different agent
runners by selecting RUNNER_TYPE at startup (claude-code, openclaw,
hermes, opencode, sandbox).
"""

import os
import logging
from swarm_secrets import read as read_secret

# --- Runner selection ---------------------------------------------------------

RUNNER_TYPE = os.getenv("RUNNER_TYPE", "claude-code").lower().strip()
VALID_RUNNERS = {"claude-code", "openclaw", "hermes", "opencode", "aider", "codex", "sandbox", "mock"}
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

API_KEY = read_secret("CODER_API_KEY", default="")

# Known placeholder values shipped in docker-compose.yml / .env.example for local
# dev. Their presence in production means the operator forgot to override the
# secret — refuse to start rather than expose a publicly-known key.
_KNOWN_DEFAULT_VALUES = {
    "change-me-to-a-random-string",
    "change-me-in-production",
    "changeme",
    "change-me",
    "pulsarteam",
    "swarm2026",
    "admin",
    "password",
    "secret",
}

_IS_PRODUCTION = os.getenv("NODE_ENV", "").lower() == "production" or os.getenv(
    "RUNNER_ENV", ""
).lower() == "production"


def _is_weak(value: str, min_length: int) -> bool:
    if not value or len(value) < min_length:
        return True
    return value.lower() in _KNOWN_DEFAULT_VALUES


if _is_weak(API_KEY, 16):
    if _IS_PRODUCTION:
        logger.error("=" * 72)
        logger.error(
            "FATAL: CODER_API_KEY is missing, too short (<16 chars), "
            "or set to a known default placeholder."
        )
        logger.error(
            "Set CODER_API_KEY as a Docker secret with a strong random value "
            "(e.g. `openssl rand -hex 32`) before deploying."
        )
        logger.error("=" * 72)
        raise SystemExit(1)
    logger.warning(
        "CODER_API_KEY is weak or unset — runner accepts requests "
        "with the placeholder. OK for local dev only."
    )
    if not API_KEY:
        # Provide *some* value so dev clients hitting the placeholder still work.
        API_KEY = "change-me-in-production"


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

# --- Interactive (no -p) mode ------------------------------------------------
#
# Anthropic has announced that Claude Code headless mode (`-p` / `--print`) is
# moving to API-rate pricing, while the interactive TUI mode keeps subscription
# pricing. Default to the interactive driver and let operators opt back into
# print-mode via env var if they need it (CI shells, integration tests, etc.).
#
# CLAUDE_USE_PRINT_MODE=true  → spawn with `-p` (legacy/expensive path)
# CLAUDE_USE_PRINT_MODE=false → drive the CLI via a PTY (default)
CLAUDE_USE_PRINT_MODE = os.getenv("CLAUDE_USE_PRINT_MODE", "false").lower() in ("true", "1", "yes")

# Silence window (seconds) used to detect "the CLI is done answering" when
# driving the TUI through a PTY. The previous default of 4 s was too tight
# for Claude Opus on high effort — the TUI can pause mid-turn between tool
# uses for several seconds without producing visible output, and the driver
# would prematurely send `/exit`. Bumped to 15 s; operator-tunable.
CLAUDE_INTERACTIVE_IDLE_SECS = float(os.getenv("CLAUDE_INTERACTIVE_IDLE_SECS", "15.0"))

# Hard cap on how long a single interactive turn may run end-to-end.
CLAUDE_INTERACTIVE_TIMEOUT = int(os.getenv("CLAUDE_INTERACTIVE_TIMEOUT", str(TIMEOUT)))

# When the TUI shows an interactive prompt we don't have a hardcoded answer
# for, consult a configured OpenAI-compatible LLM. All three vars are required
# for the fallback to activate; if any is missing we default to "1" (= the
# first / safest option) for selection prompts and "y" for Y/N prompts.
CLAUDE_FALLBACK_LLM_URL = os.getenv("CLAUDE_FALLBACK_LLM_URL", "").strip()
CLAUDE_FALLBACK_LLM_KEY = read_secret("CLAUDE_FALLBACK_LLM_KEY", default=os.getenv("CLAUDE_FALLBACK_LLM_KEY", "")).strip()
CLAUDE_FALLBACK_LLM_MODEL = os.getenv("CLAUDE_FALLBACK_LLM_MODEL", "gpt-4o-mini").strip()

# Backwards-compat aliases (so we don't have to update every file at once)
CLAUDE_MODEL = RUNNER_MODEL
CLAUDE_MAX_TURNS = RUNNER_MAX_TURNS
CLAUDE_CWD = CLI_CWD
