#!/bin/bash
set -e

echo "=== Runner Service Entrypoint (backend=${RUNNER_TYPE:-claude-code}) ==="

# Restrictive umask so any file created by this script (or its children)
# defaults to 0600 / dirs to 0700 — protects tokens/credentials at rest.
umask 0077

# Secrets are NOT loaded into env vars — application code reads them directly
# from /run/secrets/<NAME> via the secrets helper module. This keeps them out
# of /proc/<pid>/environ and out of `docker inspect` output.

# ─── Filesystem prep (server runs as root, agents get dedicated UIDs at runtime) ─
PUID=${PUID:-1000}
PGID=${PGID:-1000}

# DATA_DIR holds per-agent HOMEs (chowned by the server to per-agent UIDs).
# Mode 0711 (traverse-only): per-agent UIDs need x to reach their own HOME,
# but cannot list /app/data contents. Each per-agent HOME stays 0700.
mkdir -p /app/data
chmod 0711 /app/data
mkdir -p /app/data/agents
chmod 0711 /app/data/agents

# Reference HOME for the root server process — agent_user.ensure_agent_user
# copies $HOME/.claude/settings.json and $HOME/.claude.json into each agent
# HOME, so we set up the templates here under /root.
REF_HOME=/root

# Trust all git repos in /projects (mounted from host with various uids).
git config --global --add safe.directory '*'

# ─── Backend-specific setup (Claude Code only) ─────────────────────────────
if [ "${RUNNER_TYPE:-claude-code}" = "claude-code" ]; then
    echo "Claude Code version: $(claude --version 2>&1 || echo 'NOT FOUND')"

    if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
        echo "Auth: OAuth token (subscription plan)"
        CLAUDE_JSON="$REF_HOME/.claude.json"
        if [ ! -f "$CLAUDE_JSON" ]; then
            echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_JSON"
            chmod 0600 "$CLAUDE_JSON"
            echo "Created $CLAUDE_JSON (onboarding bypass)"
        fi
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "Auth: API key (API credits)"
    else
        echo "WARNING: No auth configured for claude-code backend!"
    fi

    # Configure Claude Code MCP servers. The JWT secret is read file-first
    # with an env-var fallback (same order as swarm_secrets.py) so plain
    # docker compose deployments — which pass JWT_SECRET as env only, with
    # no /run/secrets mount — still get the baseline MCP config.
    JWT_SECRET_FILE=/run/secrets/JWT_SECRET
    if [ -n "$SWARM_API_BASE_URL" ] && { [ -r "$JWT_SECRET_FILE" ] || [ -n "$JWT_SECRET" ]; }; then
        echo "Configuring Claude Code MCP servers..."

        # The `|| { ...; }` keeps a python failure (unreadable/non-UTF-8 secret,
        # interpreter error) from killing the entrypoint under `set -e`, and
        # stderr is NOT suppressed so the traceback lands in container logs.
        SERVICE_TOKEN=$(JWT_SECRET_FILE="$JWT_SECRET_FILE" python3 -c "
import os, json, hmac, hashlib, base64, time

secret = b''
try:
    with open(os.environ['JWT_SECRET_FILE']) as f:
        secret = f.read().rstrip('\n').encode()
except OSError:
    secret = (os.environ.get('JWT_SECRET') or '').rstrip('\n').encode()
if not secret:
    raise SystemExit('no JWT secret available (secret file unreadable and JWT_SECRET env empty)')

def b64url(data):
    if isinstance(data, (dict, list)):
        data = json.dumps(data, separators=(',', ':')).encode()
    elif isinstance(data, str):
        data = data.encode()
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode()

header = b64url({'alg': 'HS256', 'typ': 'JWT'})
payload = b64url({'username': 'runner-service', 'role': 'service', 'iat': int(time.time()), 'exp': 9999999999})
signing_input = f'{header}.{payload}'
sig = hmac.new(secret, signing_input.encode(), hashlib.sha256).digest()
print(f'{signing_input}.{b64url(sig)}', end='')
") || { echo "WARNING: service-token mint failed — skipping baseline MCP config (see error above)" >&2; SERVICE_TOKEN=""; }

        if [ -n "$SERVICE_TOKEN" ]; then
            CLAUDE_SETTINGS_DIR="$REF_HOME/.claude"
            mkdir -p "$CLAUDE_SETTINGS_DIR"
            chmod 0700 "$CLAUDE_SETTINGS_DIR"

            # The swarm-manager entry is only emitted when MCP_ENDPOINT is set
            # (the Swarm stack always sets it): plain compose defines no
            # swarm-manager service, and a hard-coded default would give every
            # agent an MCP server on an unresolvable host.
            if [ -n "$MCP_ENDPOINT" ]; then
                SWARM_MANAGER_ENTRY="\"swarm-manager\": {
      \"type\": \"http\",
      \"url\": \"${MCP_ENDPOINT}\"
    },
    "
            else
                SWARM_MANAGER_ENTRY=""
            fi

            cat > "$CLAUDE_SETTINGS_DIR/settings.json" << SETTINGS_EOF
{
  "mcpServers": {
    ${SWARM_MANAGER_ENTRY}"code-index": {
      "type": "http",
      "url": "${SWARM_API_BASE_URL}/api/code-index/mcp",
      "headers": {
        "Authorization": "Bearer ${SERVICE_TOKEN}"
      }
    },
    "onedrive": {
      "type": "http",
      "url": "${SWARM_API_BASE_URL}/api/onedrive/mcp",
      "headers": {
        "Authorization": "Bearer ${SERVICE_TOKEN}"
      }
    }
  }
}
SETTINGS_EOF
            chmod 0600 "$CLAUDE_SETTINGS_DIR/settings.json"
            echo "Claude Code MCP servers configured"
        fi
    else
        echo "WARNING: baseline Claude MCP config skipped — SWARM_API_BASE_URL unset, or no JWT secret available (neither $JWT_SECRET_FILE nor JWT_SECRET env)" >&2
    fi
fi

echo "Configuration:"
echo "  Backend: ${RUNNER_TYPE:-claude-code}"
echo "  Server runs as: root (cap_drop=ALL + minimal cap_add — see compose)"
echo "  Per-agent CLI subprocesses run under deterministic UIDs (20000+) from agent_user.py"
echo "  Model: ${RUNNER_MODEL:-${CLAUDE_MODEL:-claude-sonnet-4-20250514}}"
echo "  Projects dir: ${PROJECTS_DIR:-/projects}"

# The server stays root so it can:
#   - chown per-agent HOME directories to dedicated UIDs (CAP_CHOWN)
#   - spawn CLI subprocesses under those UIDs via subprocess.Popen(user=...)
#     (CAP_SETUID/CAP_SETGID)
#   - read/write across agent HOMEs to manage credentials (CAP_DAC_OVERRIDE)
#
# `no-new-privileges:true` (set in the compose) is compatible with this
# because we are NOT trying to elevate privileges via exec — we are dropping
# privileges per-subprocess via setresuid. The container itself has cap_drop
# ALL plus a small allowlist, so "root" inside has no real escape paths.
echo "Starting FastAPI server on port ${PORT:-8000}..."
exec python server.py
