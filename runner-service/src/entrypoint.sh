#!/bin/bash
set -e

echo "=== Runner Service Entrypoint (backend=${RUNNER_TYPE:-claude-code}) ==="

# ─── Create runtime user from host UID/GID ─────────────────────────────────
PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "Setting up user runner ($PUID:$PGID)..."

getent group "$PGID" >/dev/null 2>&1 || groupadd -g "$PGID" runner
getent passwd "$PUID" >/dev/null 2>&1 || useradd -u "$PUID" -g "$PGID" -m -d /home/runner -s /bin/bash runner

RUNNER_USER=$(getent passwd "$PUID" | cut -d: -f1)
RUNNER_HOME=$(getent passwd "$PUID" | cut -d: -f6)

mkdir -p /app/data
chown -R "$PUID:$PGID" /app /opt/venv /app/data
chown -R "$PUID:$PGID" "$RUNNER_HOME"

# Copy SSH keys if mounted at /root/.ssh
if [ -d /root/.ssh ]; then
    mkdir -p "$RUNNER_HOME/.ssh"
    cp -a /root/.ssh/* "$RUNNER_HOME/.ssh/" 2>/dev/null || true
    chown -R "$PUID:$PGID" "$RUNNER_HOME/.ssh"
    chmod 700 "$RUNNER_HOME/.ssh"
    chmod 600 "$RUNNER_HOME/.ssh/"* 2>/dev/null || true
fi

# Trust all git repos in /projects (mounted from host, different uid)
gosu "$RUNNER_USER" git config --global --add safe.directory '*'

# ─── Backend-specific setup (Claude Code only) ─────────────────────────────
if [ "${RUNNER_TYPE:-claude-code}" = "claude-code" ]; then
    echo "Claude Code version: $(gosu "$RUNNER_USER" claude --version 2>&1 || echo 'NOT FOUND')"

    if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
        echo "Auth: OAuth token (subscription plan)"
        CLAUDE_JSON="$RUNNER_HOME/.claude.json"
        if [ ! -f "$CLAUDE_JSON" ]; then
            echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_JSON"
            chown "$PUID:$PGID" "$CLAUDE_JSON"
            echo "Created $CLAUDE_JSON (onboarding bypass)"
        fi
    elif [ -n "$ANTHROPIC_API_KEY" ]; then
        echo "Auth: API key (API credits)"
    else
        echo "WARNING: No auth configured for claude-code backend!"
    fi

    # Configure Claude Code MCP servers
    if [ -n "$SWARM_API_BASE_URL" ] && [ -n "$JWT_SECRET" ]; then
        echo "Configuring Claude Code MCP servers..."

        SERVICE_TOKEN=$(JWT_SECRET="$JWT_SECRET" python3 -c "
import os, json, hmac, hashlib, base64, time

secret = os.environ['JWT_SECRET'].encode()

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
            CLAUDE_SETTINGS_DIR="$RUNNER_HOME/.claude"
            mkdir -p "$CLAUDE_SETTINGS_DIR"

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
            chown -R "$PUID:$PGID" "$CLAUDE_SETTINGS_DIR"
            echo "Claude Code MCP servers configured"
        fi
    fi
fi

echo "Configuration:"
echo "  Backend: ${RUNNER_TYPE:-claude-code}"
echo "  User: $RUNNER_USER ($PUID:$PGID)"
echo "  Model: ${RUNNER_MODEL:-${CLAUDE_MODEL:-claude-sonnet-4-20250514}}"
echo "  Projects dir: ${PROJECTS_DIR:-/projects}"

echo "Starting FastAPI server on port ${PORT:-8000}..."
exec gosu "$RUNNER_USER" python server.py
