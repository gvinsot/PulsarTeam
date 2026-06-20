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

    # NOTE: No baseline MCP config is written here on purpose. Claude Code
    # ignores `mcpServers` in settings.json, so a baseline written there never
    # loaded. Per-agent MCP wiring (the Pulsar Gateway, which carries task
    # control + the dynamic list_mcps/call_mcp_tool proxy) is materialized at
    # spawn by configure_claude_mcp → ~/.claude/pulsar-mcp.json and loaded via
    # `--mcp-config <file> --strict-mcp-config` (see ClaudeCodeBackend._build_cmd).
fi

echo "Configuration:"
echo "  Backend: ${RUNNER_TYPE:-claude-code}"
echo "  Server runs as: root (cap_drop=ALL + minimal cap_add — see compose)"
echo "  Per-agent CLI subprocesses run under deterministic UIDs (20000+) from agent_user.py"
echo "  Model: ${RUNNER_MODEL:-claude-sonnet-4-20250514}"
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
