#!/bin/bash
# Provision the Azure CLI into the shared `azure-cli` volume (/opt/azure-cli).
#
# Same model as rust_toolchain.sh: `az` (~700 MB of Python packages) is
# deliberately NOT baked into the runner image. It lives on a per-node named
# volume mounted by every runner service, so it is downloaded once per node.
# Launched in the background by entrypoint.sh as root; agents (UIDs 20000+)
# only ever read it.
#
# Layout: /opt/azure-cli/current/{venv,bin/az}. Only bin/ is on PATH (see
# Dockerfile) — the venv's own bin/ also holds python/pip, which must not
# shadow the image's. The install goes to a staging dir and is swapped in
# with mv, so an agent never sees a half-installed CLI. flock serialises the
# runners of one node: the first installs, the others find the marker and exit.
#
# Extensions: `az extension add` writes to AZURE_EXTENSION_DIR, which defaults
# to $HOME/.azure/cliextensions — per agent and writable, so this tree stays
# read-only at runtime.
#
# Authentication is NOT handled here: the Azure CLI plugin's service principal
# is logged in per agent at spawn (backends/runner_azure_config.py).
#
# AZURE_CLI_VERSION selects the release (default: latest at first install;
# pin e.g. "2.91.0" to upgrade/downgrade); "none" disables provisioning. The
# venv is tied to the image's python, so a python upgrade re-provisions too.
set -euo pipefail

# AZURE_CLI_ROOT only exists for tests; the Dockerfile PATH expects /opt/azure-cli.
ROOT="${AZURE_CLI_ROOT:-/opt/azure-cli}"
WANTED="${AZURE_CLI_VERSION:-latest}"
PYTHON=/usr/local/bin/python3.12
MARKER="$ROOT/current/.provisioned"

log() { echo "[azure-cli] $*"; }

[ "$WANTED" = "none" ] && { log "disabled (AZURE_CLI_VERSION=none)"; exit 0; }
[ -d "$ROOT" ] || { log "$ROOT not mounted — skipping"; exit 0; }
[ -x "$PYTHON" ] || { log "$PYTHON not found — skipping"; exit 0; }

PY_VERSION="$("$PYTHON" -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
STAMP="$WANTED py$PY_VERSION"

# The entrypoint runs under umask 0077; the tree must be world-readable.
umask 0022
chmod 0755 "$ROOT"

exec 9>"$ROOT/.provision.lock"
flock 9

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$STAMP" ]; then
    log "ready ($STAMP)"
    exit 0
fi

log "installing azure-cli $WANTED into $ROOT (one-time per node)…"
STAGING="$ROOT/.staging"
rm -rf "$STAGING" "$ROOT/.old"
mkdir -p "$STAGING/bin"

SPEC="azure-cli"
[ "$WANTED" != "latest" ] && SPEC="azure-cli==$WANTED"

# pip is chatty; keep its output out of the runner logs unless it fails.
if ! { "$PYTHON" -m venv "$STAGING/venv" \
        && "$STAGING/venv/bin/pip" install --no-cache-dir --disable-pip-version-check -q "$SPEC"; } \
        > "$ROOT/.install.log" 2>&1; then
    tail -n 30 "$ROOT/.install.log"
    exit 1
fi
rm -f "$ROOT/.install.log"
# Byte-compile once as root: agents cannot write __pycache__ here, and az
# would otherwise recompile its modules on every invocation.
"$STAGING/venv/bin/python" -m compileall -q "$STAGING/venv/lib" > /dev/null 2>&1 || true

# The venv's console script hard-codes the staging interpreter path in its
# shebang, which the swap below would break: call the final location instead.
cat > "$STAGING/bin/az" <<EOF
#!/bin/sh
exec $ROOT/current/venv/bin/python -Im azure.cli "\$@"
EOF
chmod -R a+rX "$STAGING"
chmod 0755 "$STAGING/bin/az"
echo "$STAMP" > "$STAGING/.provisioned"

[ -d "$ROOT/current" ] && mv "$ROOT/current" "$ROOT/.old"
mv "$STAGING" "$ROOT/current"
rm -rf "$ROOT/.old"
log "ready ($STAMP) — $("$ROOT/current/bin/az" version --query '"azure-cli"' -o tsv 2>/dev/null || echo '?')"
