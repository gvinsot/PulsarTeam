#!/bin/bash
# Provision the Rust toolchain into the shared `rust-toolchain` volume (/opt/rust).
#
# The toolchain (~760 MB) is deliberately NOT baked into the runner image: it
# lives on a per-node named volume mounted by every runner service, so it is
# downloaded once per node and only where runners actually run. Launched in the
# background by entrypoint.sh as root; agents (UIDs 20000+) only ever read it.
#
# Layout: /opt/rust/current/{rustup,cargo} — RUSTUP_HOME and the proxies' bin
# dir point there (see Dockerfile). The install goes to a staging dir and is
# swapped in with mv, so an agent never sees a half-installed toolchain.
# Several runners of one node start together: flock serialises them, the first
# installs, the others find the marker and exit.
#
# CARGO_HOME is only set for the install: at runtime cargo falls back to
# $HOME/.cargo, so each agent keeps its own registry cache and `cargo install`
# output instead of writing into this root-owned tree. Components agents need
# are preinstalled because `rustup component add` cannot write here at runtime.
#
# RUST_TOOLCHAIN selects the toolchain (default: stable); "none" disables
# provisioning. Changing it re-provisions on the next start. A floating channel
# like "stable" is not refreshed by itself — pin a version to upgrade.
set -euo pipefail

ROOT=/opt/rust
WANTED="${RUST_TOOLCHAIN:-stable}"
COMPONENTS="rustfmt,clippy,rust-src,rust-analyzer"
MARKER="$ROOT/current/.provisioned"

log() { echo "[rust-toolchain] $*"; }

[ "$WANTED" = "none" ] && { log "disabled (RUST_TOOLCHAIN=none)"; exit 0; }
[ -d "$ROOT" ] || { log "$ROOT not mounted — skipping"; exit 0; }

# The entrypoint runs under umask 0077; the tree must be world-readable.
umask 0022
chmod 0755 "$ROOT"

exec 9>"$ROOT/.provision.lock"
flock 9

if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$WANTED $COMPONENTS" ]; then
    log "ready ($WANTED) — $("$ROOT/current/cargo/bin/rustc" --version 2>/dev/null || echo '?')"
    exit 0
fi

log "installing $WANTED into $ROOT (one-time per node)…"
STAGING="$ROOT/.staging"
rm -rf "$STAGING" "$ROOT/.old"
mkdir -p "$STAGING"
curl -fsSL --retry 3 https://sh.rustup.rs -o "$STAGING/rustup-init.sh"
# rustup-init is chatty even with -q; keep its output out of the runner logs
# unless it fails.
if ! RUSTUP_HOME="$STAGING/rustup" CARGO_HOME="$STAGING/cargo" \
    sh "$STAGING/rustup-init.sh" -y -q --no-modify-path --profile minimal \
        --default-toolchain "$WANTED" --component "$COMPONENTS" \
        > "$ROOT/.install.log" 2>&1; then
    tail -n 30 "$ROOT/.install.log"
    exit 1
fi
rm -f "$STAGING/rustup-init.sh" "$ROOT/.install.log"
rm -rf "$STAGING/cargo/registry" "$STAGING/cargo/git" "$STAGING/rustup/downloads" "$STAGING/rustup/tmp"
chmod -R a+rX "$STAGING"
echo "$WANTED $COMPONENTS" > "$STAGING/.provisioned"

[ -d "$ROOT/current" ] && mv "$ROOT/current" "$ROOT/.old"
mv "$STAGING" "$ROOT/current"
rm -rf "$ROOT/.old"
log "ready ($WANTED) — $("$ROOT/current/cargo/bin/rustc" --version)"
