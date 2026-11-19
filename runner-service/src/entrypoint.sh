#!/bin/bash
set -e

echo "=== Runner Service Entrypoint (backend=${RUNNER_TYPE:-claude-code}) ==="

# Restrictive umask so any file created by this script (or its children)
# defaults to 0600 / dirs to 0700 — protects tokens/credentials at rest.
umask 0077

# Secrets are NOT loaded into env vars — application code reads them directly
# from /run/secrets/<NAME> via the secrets helper module. This keeps them out
# of /proc/<pid>/environ and out of `docker inspect` output.

# ─── Lock down /run/secrets ────────────────────────────────────────────────
# Swarm mounts every secret 0444 root:root — world-readable INSIDE the
# container. That is the wrong default here: this is the one container where
# agent CLIs execute arbitrary, prompt-influenceable shell, and they do so
# under dedicated non-root UIDs (see agent_user.py). At 0444 any agent could
# simply `cat /run/secrets/ENCRYPTION_KEY` and walk off with the key that
# protects every stored OAuth token.
#
# Only this entrypoint and the server it execs (both root) ever read these,
# so 0400 root:root costs nothing and removes the whole class. The directory
# itself is dropped to 0700 so an agent cannot even enumerate the names.
#
# Best-effort: a bind-mounted secrets dir may be read-only, in which case the
# chmod fails and the container still starts — the deployment's own file mode
# then governs. Failures are logged, never fatal (`set -e` is suspended).
if [ -d /run/secrets ]; then
    set +e
    # Swarm mounts the secret FILES on a read-only tmpfs, so their chmod
    # always fails there, while the directory chmod succeeds. A 0700 dir
    # already denies non-root UIDs any path to the files, so a file chmod
    # failure is only a real exposure when the directory lock failed too.
    # Warn in that case only. (QA logged one bogus WARNING per secret on every
    # start before this.)
    _dir_locked=0
    if chmod 0700 /run/secrets 2>/dev/null; then
        _dir_locked=1
    else
        echo "WARNING: could not chmod /run/secrets (read-only mount?)"
    fi
    _files_ro=0
    for _secret in /run/secrets/*; do
        [ -f "$_secret" ] || continue
        chown root:root "$_secret" 2>/dev/null
        if ! chmod 0400 "$_secret" 2>/dev/null; then
            if [ "$_dir_locked" = 1 ]; then
                _files_ro=$((_files_ro + 1))
            else
                echo "WARNING: could not chmod $_secret and /run/secrets is not locked: readable by agent UIDs"
            fi
        fi
    done
    if [ "$_dir_locked" = 1 ]; then
        if [ "$_files_ro" -gt 0 ]; then
            echo "Secrets: /run/secrets locked to root-only (0700 dir; $_files_ro read-only secret file(s) left as mounted)"
        else
            echo "Secrets: /run/secrets locked to root-only (0700 dir / 0400 files)"
        fi
    fi
    unset _secret _dir_locked _files_ro
    set -e
fi

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
# ─── Rust toolchain (shared per-node volume) ──────────────────────────────
# Provisioned in the background so a first-time download on a fresh node never
# delays the server. Double fork: the provisioner is orphaned to tini (`-s`)
# instead of becoming an un-waited child of the python process exec'd below.
# Failures only cost Rust support, never the runner — see rust_toolchain.sh.
( ( ./rust_toolchain.sh || echo "[rust-toolchain] WARNING: provisioning failed — Rust unavailable" ) & )
# Same for Flutter/Android (android_toolchain.sh) — a much longer first run.
( ( ./android_toolchain.sh || echo "[android-toolchain] WARNING: provisioning failed — Flutter/Android unavailable" ) & )
# Same for the Azure CLI (azure_cli.sh) — `az` is too big for the image.
( ( ./azure_cli.sh || echo "[azure-cli] WARNING: provisioning failed — az unavailable" ) & )

echo "Starting FastAPI server on port ${PORT:-8000}..."
exec python server.py
