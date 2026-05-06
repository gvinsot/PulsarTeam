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
mkdir -p /app/data
chmod 0700 /app/data

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

    # Configure Claude Code MCP servers
    JWT_SECRET_FILE=/run/secrets/JWT_SECRET
    if [ -n "$SWARM_API_BASE_URL" ] && [ -r "$JWT_SECRET_FILE" ]; then
        echo "Configuring Claude Code MCP servers..."

        SERVICE_TOKEN=$(JWT_SECRET_FILE="$JWT_SECRET_FILE" python3 -c "
import os, json, hmac, hashlib, base64, time

with open(os.environ['JWT_SECRET_FILE']) as f:
    secret = f.read().rstrip('\n').encode()

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
" 2>/dev/null)

        if [ -n "$SERVICE_TOKEN" ]; then
            MCP_SWARM_URL="${MCP_ENDPOINT:-http://swarm-manager:8000/ai/mcp}"
            CLAUDE_SETTINGS_DIR="$REF_HOME/.claude"
            mkdir -p "$CLAUDE_SETTINGS_DIR"
            chmod 0700 "$CLAUDE_SETTINGS_DIR"

            cat > "$CLAUDE_SETTINGS_DIR/settings.json" << SETTINGS_EOF
{
  "mcpServers": {
    "swarm-manager": {
      "type": "http",
      "url": "${MCP_SWARM_URL}"
    },
    "code-index": {
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
