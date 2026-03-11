#!/bin/bash
set -e

echo "=== Coder Service Entrypoint (Claude Code backend) ==="

# ─── Create runtime user from host UID/GID ─────────────────────────────────
# Required: --dangerously-skip-permissions refuses to run as root.
# PUID/PGID should match the host user that owns /projects.
PUID=${PUID:-1000}
PGID=${PGID:-1000}

echo "Setting up user coder ($PUID:$PGID)..."

# Create group/user if they don't exist
getent group "$PGID" >/dev/null 2>&1 || groupadd -g "$PGID" coder
getent passwd "$PUID" >/dev/null 2>&1 || useradd -u "$PUID" -g "$PGID" -m -d /home/coder -s /bin/bash coder

CODER_USER=$(getent passwd "$PUID" | cut -d: -f1)
CODER_HOME=$(getent passwd "$PUID" | cut -d: -f6)

# Ensure ownership of app, venv, and data directories
mkdir -p /app/data
chown -R "$PUID:$PGID" /app /opt/venv /app/data
chown -R "$PUID:$PGID" "$CODER_HOME"

# Copy SSH keys if mounted at /root/.ssh (legacy mount point)
if [ -d /root/.ssh ]; then
    mkdir -p "$CODER_HOME/.ssh"
    cp -a /root/.ssh/* "$CODER_HOME/.ssh/" 2>/dev/null || true
    chown -R "$PUID:$PGID" "$CODER_HOME/.ssh"
    chmod 700 "$CODER_HOME/.ssh"
    chmod 600 "$CODER_HOME/.ssh/"* 2>/dev/null || true
fi

# Trust all git repos in /projects (mounted from host, different uid)
gosu "$CODER_USER" git config --global --add safe.directory '*'

# ─── Verify Claude Code CLI ────────────────────────────────────────────────
echo "Claude Code version: $(gosu "$CODER_USER" claude --version 2>&1 || echo 'NOT FOUND')"

# ─── Authentication check ─────────────────────────────────────────────────
if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ]; then
    echo "Auth: OAuth token (subscription plan)"

    # Create onboarding bypass so Claude Code skips the interactive wizard
    CLAUDE_JSON="$CODER_HOME/.claude.json"
    if [ ! -f "$CLAUDE_JSON" ]; then
        echo '{"hasCompletedOnboarding": true}' > "$CLAUDE_JSON"
        chown "$PUID:$PGID" "$CLAUDE_JSON"
        echo "Created $CLAUDE_JSON (onboarding bypass)"
    fi
elif [ -n "$ANTHROPIC_API_KEY" ]; then
    echo "Auth: API key (API credits)"
else
    echo "WARNING: No auth configured! Set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY (API credits)."
fi

echo "Configuration:"
echo "  User: $CODER_USER ($PUID:$PGID)"
echo "  Model: ${CLAUDE_MODEL:-claude-sonnet-4-20250514}"
echo "  Max turns: ${CLAUDE_MAX_TURNS:-50}"
echo "  Projects dir: ${PROJECTS_DIR:-/projects}"

echo "Starting FastAPI server on port ${PORT:-8000}..."
exec gosu "$CODER_USER" python server.py
