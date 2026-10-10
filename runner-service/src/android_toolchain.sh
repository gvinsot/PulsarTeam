#!/bin/bash
# Provision the Flutter + Android toolchain into the shared `android-toolchain`
# volume (/opt/android).
#
# Same model as rust_toolchain.sh: the toolchain (~6.5 GB: JDK, Flutter SDK
# with Android engine artifacts, Android SDK + NDK) is deliberately NOT baked
# into the runner image. It lives on a per-node named volume mounted by every runner
# service, so it is downloaded once per node. Launched in the background by
# entrypoint.sh as root.
#
# Layout: /opt/android/<flutter version>/{jdk,flutter,sdk,bin} and
# /opt/android/current -> <flutter version>. JAVA_HOME, ANDROID_HOME and PATH
# point at `current` (see Dockerfile). The tree is
# filled under its final path (Flutter and Gradle record absolute paths) and
# only becomes visible when the `current` symlink is swapped, so an agent never
# sees a half-installed toolchain. flock serialises the runners of one node.
#
# Unlike Rust, this tree cannot be read-only for agents: flutter writes into
# its own SDK (bin/cache lockfile, version stamps) and Gradle installs missing
# SDK packages (platforms, build-tools, NDK) into ANDROID_HOME on demand. The
# tree is therefore owned by the shared `toolchain` group (TOOLCHAIN_GID, a
# supplementary group of every agent UID — see get_subprocess_kwargs), with
# setgid directories, and bin/{flutter,dart} wrap the real tools with umask
# 0002 so files they create stay usable by the other agents.
#
# Provisioning ends with a throwaway `flutter create` + debug and release
# `flutter build apk`: that pulls exactly the SDK packages and engine artifacts
# the Flutter Gradle plugin asks for into the shared SDK. Gradle's own caches
# stay per agent ($HOME/.gradle, ~1.5 GB fetched by an agent's first build):
# GRADLE_RO_DEP_CACHE was tried and breaks the Kotlin Gradle plugin's classpath
# (Gradle 9.3, "Unresolved reference 'JvmTarget'").
#
# ANDROID_TOOLCHAIN selects the Flutter release: "stable" (default, latest
# stable at provisioning time), an exact version like "3.35.4", or "none" to
# disable. "stable" is not refreshed by itself — pin a version to upgrade.
set -euo pipefail

ROOT=/opt/android
WANTED="${ANDROID_TOOLCHAIN:-stable}"
TOOLCHAIN_GID="${TOOLCHAIN_GID:-19999}"
JDK_MAJOR=17
# Bump to re-provision every node when the layout or warm-up changes.
LAYOUT_REV=1
FLUTTER_RELEASES=https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json
ANDROID_REPO=https://dl.google.com/android/repository

log() { echo "[android-toolchain] $*"; }

[ "$WANTED" = "none" ] && { log "disabled (ANDROID_TOOLCHAIN=none)"; exit 0; }
[ -d "$ROOT" ] || { log "$ROOT not mounted — skipping"; exit 0; }
# Google ships aapt2 and the SDK build tools for linux-x86_64 only.
[ "$(uname -m)" = "x86_64" ] || { log "$(uname -m) unsupported by the Android SDK — skipping"; exit 0; }

# The entrypoint runs under umask 0077; the tree must be group-writable.
umask 0002
chmod 0755 "$ROOT"

exec 9>"$ROOT/.provision.lock"
flock 9

MARKER="$ROOT/current/.provisioned"
if [ -f "$MARKER" ] && [ "$(cat "$MARKER")" = "$WANTED rev$LAYOUT_REV" ]; then
    log "ready ($WANTED) — Flutter $(readlink "$ROOT/current")"
    exit 0
fi

# ─── Resolve the Flutter release ────────────────────────────────────────────
RELEASES="$(curl -fsSL --retry 3 "$FLUTTER_RELEASES")"
if [ "$WANTED" = "stable" ]; then
    HASH="$(jq -r '.current_release.stable' <<<"$RELEASES")"
    RELEASE="$(jq -c --arg h "$HASH" '[.releases[] | select(.hash == $h and .channel == "stable")][0]' <<<"$RELEASES")"
else
    RELEASE="$(jq -c --arg v "$WANTED" '[.releases[] | select(.version == $v and .channel == "stable")][0]' <<<"$RELEASES")"
fi
[ "$RELEASE" != "null" ] || { log "no stable Flutter release matches '$WANTED'"; exit 1; }
VERSION="$(jq -r '.version' <<<"$RELEASE")"
ARCHIVE="$(jq -r '.archive' <<<"$RELEASE")"
BASE_URL="$(jq -r '.base_url' <<<"$RELEASES")"

DIR="$ROOT/$VERSION"
log "installing Flutter $VERSION into $DIR (one-time per node)…"
rm -rf "$DIR"
mkdir -p "$DIR/jdk" "$DIR/sdk/cmdline-tools" "$DIR/bin"
WORK="$(mktemp -d "$ROOT/.work.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
INSTALL_LOG="$ROOT/.install.log"
: > "$INSTALL_LOG"
fail() { tail -n 40 "$INSTALL_LOG"; log "FAILED: $*"; exit 1; }

# ─── JDK (Temurin) ──────────────────────────────────────────────────────────
curl -fsSL --retry 3 \
    "https://api.adoptium.net/v3/binary/latest/$JDK_MAJOR/ga/linux/x64/jdk/hotspot/normal/eclipse" \
    | tar -xz -C "$DIR/jdk" --strip-components=1

# ─── Flutter SDK ────────────────────────────────────────────────────────────
# --no-same-owner: the archive carries the builder's UID, and git refuses to
# work in a repository owned by somebody else ("dubious ownership").
curl -fsSL --retry 3 "$BASE_URL/$ARCHIVE" | tar -xJ --no-same-owner -C "$DIR"

# ─── Android command-line tools ─────────────────────────────────────────────
CMDLINE_ZIP="$(curl -fsSL --retry 3 "$ANDROID_REPO/repository2-3.xml" \
    | grep -o 'commandlinetools-linux-[0-9]*_latest\.zip' | sort -t- -k3 -n -u | tail -1)"
[ -n "$CMDLINE_ZIP" ] || fail "cannot find the command-line tools archive"
curl -fsSL --retry 3 "$ANDROID_REPO/$CMDLINE_ZIP" -o "$WORK/cmdline-tools.zip"
unzip -q "$WORK/cmdline-tools.zip" -d "$WORK"
mv "$WORK/cmdline-tools" "$DIR/sdk/cmdline-tools/latest"

# ─── Accept licenses, warm up with a throwaway app ──────────────────────────
export JAVA_HOME="$DIR/jdk"
export ANDROID_HOME="$DIR/sdk" ANDROID_SDK_ROOT="$DIR/sdk"
export PATH="$DIR/flutter/bin:$DIR/sdk/cmdline-tools/latest/bin:$DIR/sdk/platform-tools:$JAVA_HOME/bin:$PATH"
# Root's HOME/caches are throwaway: only the SDK tree is kept.
export HOME="$WORK/home" PUB_CACHE="$WORK/pub-cache" GRADLE_USER_HOME="$WORK/gradle"
export GRADLE_OPTS="-Dorg.gradle.daemon=false -Dorg.gradle.jvmargs=-Xmx3g"
mkdir -p "$HOME"
# Agents get safe.directory='*' from root's gitconfig (entrypoint.sh); this
# throwaway HOME does not.
git config --global --add safe.directory '*'

# Not a `{ …; } || fail` block: `||` would switch off `set -e` inside it and
# carry on past the first failure.
run() { "$@" >> "$INSTALL_LOG" 2>&1 || fail "$*"; }
# `yes` dies of SIGPIPE once sdkmanager is done — not a failure.
{ yes || true; } | run sdkmanager --licenses
run sdkmanager --install platform-tools
run flutter config --no-analytics --no-cli-animations
run flutter precache --android
run flutter create --org dev.pulsarteam --platforms android "$WORK/warmup"
cd "$WORK/warmup"
run flutter build apk --debug
run flutter build apk --release
cd /

# flutter/dart wrappers: group-writable files for the shared SDK.
for tool in flutter dart; do
    cat > "$DIR/bin/$tool" <<EOF
#!/bin/sh
umask 0002
exec "$DIR/flutter/bin/$tool" "\$@"
EOF
done

chgrp -R "$TOOLCHAIN_GID" "$DIR"
chmod -R g+rwX,o+rX "$DIR"
chmod 0755 "$DIR/bin/flutter" "$DIR/bin/dart"
find "$DIR" -type d -exec chmod g+s {} +
echo "$WANTED rev$LAYOUT_REV" > "$DIR/.provisioned"
rm -f "$INSTALL_LOG"

ln -sfn "$VERSION" "$ROOT/.current.new"
mv -T "$ROOT/.current.new" "$ROOT/current"
# Older versions go once nothing points at them any more.
for old in "$ROOT"/*; do
    case "$(basename "$old")" in "$VERSION"|current) continue ;; esac
    rm -rf "$old"
done
log "ready ($WANTED) — Flutter $VERSION, $(du -sh "$DIR" | cut -f1)"
