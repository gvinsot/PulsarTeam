# Runner Service — generic agent runtime.
#
# A single image that ships every supported CLI; the active backend is
# selected at startup via RUNNER_TYPE (claude-code, codex, openclaw, hermes,
# opencode, aider, vibe, sandbox).
FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    git \
    curl \
    wget \
    ca-certificates \
    jq \
    netcat-openbsd \
    dnsutils \
    postgresql-client \
    sqlite3 \
    gettext-base \
    chromium \
    chromium-driver \
    fonts-liberation \
    fonts-noto-color-emoji \
    pandoc \
    util-linux \
    openssh-client \
    bubblewrap \
    tmux \
    tini \
    && rm -rf /var/lib/apt/lists/*

# Chromium headless environment
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_FLAGS="--no-sandbox --headless --disable-gpu --disable-dev-shm-usage"

# OpenClaw >=2026.9 requires Node >=24.16.0; all CLI runners share this runtime.
# NodeSource 24.x supplies the current Node 24 LTS patch release. The build
# fails if the repo (or a stale mirror/cache) serves anything older than
# 24.22.1, the 2026-10-21 security release (CVE-2026-111497 Brotli RCE,
# CVE-2026-105481/105483/106069/106070/106071/106072/106074).
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node -e 'const [a,b,c]=process.versions.node.split(".").map(Number); \
        if (a<24 || (a===24 && (b<22 || (b===22 && c<1)))) { \
          console.error("Node "+process.version+" < 24.22.1 (security release 2026-10-21)"); process.exit(1); }'

# Hermes may put its launcher under ~/.hermes/bin (installed with the agent
# CLIs below). Every later `ENV PATH` prepends, so this line must stay ABOVE
# them: placed after the venv's, its /usr/local/bin would shadow
# /opt/venv/bin/python and `python server.py` would start without the runner's
# dependencies.
ENV PATH="/root/.hermes/bin:/usr/local/bin:${PATH}"

# Install Go (dev tool inside agent workspaces)
RUN curl -fsSL https://go.dev/dl/go1.24.1.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/root/go/bin:$PATH"
RUN CGO_ENABLED=0 go install golang.org/x/tools/gopls@latest && \
    CGO_ENABLED=0 go install github.com/go-delve/delve/cmd/dlv@latest && \
    CGO_ENABLED=0 go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Rust (dev tool inside agent workspaces)
# The toolchain is NOT in the image (~760 MB): rust_toolchain.sh provisions it
# at startup into the per-node `rust-toolchain` volume mounted at /opt/rust,
# once per node. Until that finishes (or without the volume) cargo is simply
# absent from PATH. Only the system deps -sys crates need (openssl) live here.
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/rust && chmod 0755 /opt/rust
ENV RUSTUP_HOME=/opt/rust/current/rustup
ENV PATH="/opt/rust/current/cargo/bin:$PATH"

# Flutter + Android (dev tool inside agent workspaces)
# Same model as Rust: JDK, Flutter SDK and Android SDK/NDK (~6.5 GB) are
# provisioned by android_toolchain.sh into the per-node
# `android-toolchain` volume at /opt/android, never baked in here. Only the
# tools flutter shells out to (unzip/zip) and the `toolchain` group that owns
# the shared, agent-writable tree (agent_user.TOOLCHAIN_GID) live in the image.
# GRADLE_OPTS caps the daemon heap: Flutter's template asks for -Xmx8G, the
# whole runner limit.
RUN apt-get update && apt-get install -y --no-install-recommends unzip zip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 19999 toolchain \
    && mkdir -p /opt/android && chmod 0755 /opt/android
ENV JAVA_HOME=/opt/android/current/jdk \
    ANDROID_HOME=/opt/android/current/sdk \
    ANDROID_SDK_ROOT=/opt/android/current/sdk \
    GRADLE_OPTS="-Dorg.gradle.jvmargs=-Xmx3g -Dorg.gradle.daemon.idletimeout=600000"
ENV PATH="/opt/android/current/bin:/opt/android/current/sdk/platform-tools:/opt/android/current/jdk/bin:$PATH"

# Azure CLI (dev tool inside agent workspaces, used by the Azure CLI plugin)
# Same model as Rust: `az` (~700 MB of Python packages) is provisioned by
# azure_cli.sh into the per-node `azure-cli` volume at /opt/azure-cli, never
# baked in here. Only its bin/ (a single `az` wrapper) goes on PATH.
RUN mkdir -p /opt/azure-cli && chmod 0755 /opt/azure-cli
ENV AZURE_CORE_COLLECT_TELEMETRY=false
ENV PATH="/opt/azure-cli/current/bin:$PATH"

# Install Docker CLI (for agents that manage containers)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Python virtual environment (PEP 668)
RUN python3.12 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy and install Python dependencies
COPY runner-service/requirements.txt .
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Make dev tools available globally
RUN pip install --break-system-packages pytest black

# RTK (Rust Token Killer)
# Pinned instead of resolving releases/latest at build time: the v1.2.0
# x86_64 musl asset answers 504 on every download (it broke the 1.0.1301 and
# 1.0.1302 builds), and api.github.com rate-limits/504s the build host. A
# pinned version plus a checksum keeps builds reproducible. To upgrade, bump
# RTK_VERSION and RTK_SHA256_X86_64 (from the release's asset list).
# The image is amd64-only (see devops/docker-compose.swarm.yml); the aarch64
# branch exists for local builds and is not checksum-pinned.
ARG RTK_VERSION=v1.1.0
ARG RTK_SHA256_X86_64=9454ad1b9489daa57ab0a9f4ebe2faaf4dc82b8a0f26c9e5135151abd7c9378d
RUN case "$(uname -m)" in \
      x86_64)  RTK_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz ;; \
      aarch64) RTK_ASSET=rtk-aarch64-unknown-linux-gnu.tar.gz ;; \
      *) echo "rtk: unsupported arch $(uname -m)" >&2; exit 1 ;; \
    esac && \
    curl -fsSL --retry 5 --retry-all-errors --retry-delay 5 -o /tmp/rtk.tar.gz \
      "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/${RTK_ASSET}" && \
    if [ "$(uname -m)" = x86_64 ]; then echo "${RTK_SHA256_X86_64}  /tmp/rtk.tar.gz" | sha256sum -c -; fi && \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin/ rtk && \
    rm /tmp/rtk.tar.gz && \
    chmod +x /usr/local/bin/rtk && \
    rtk --version

# gosu for runtime user switching
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# ─── Agent CLIs: the latest upstream release, on every build ──────────────
# Each runner backend invokes its own CLI binary. We install all of them
# unconditionally so the same image can act as any backend at runtime.
#
# How a build stays on the latest release WITHOUT a manual bump: every CLI
# layer starts with a remote `ADD` of its registry's "latest" metadata (npm
# `<pkg>/latest`, PyPI `<pkg>/json`, GitHub `releases.atom`). BuildKit
# re-downloads that document on every build and keys the layer on its
# content, so the layer re-runs exactly when upstream has published a new
# release and is reused from cache otherwise, when it already holds the latest.
# The RUN then installs the exact version that document names, so the build
# log and /opt/runner-cli-versions.txt say what shipped.
#
# These layers sit after the stable tooling (so a CLI release does not rebuild
# Go/Docker/the venv) and before the runner's source (so a code commit does not
# reinstall every CLI). Least to most frequently released, top to bottom: a
# release re-runs its own layer and every CLI layer below it.
#
# Never pin a version or add a per-CLI cache-bust argument here; that is how the
# runners used to fall weeks behind (see docs/cli-updates.md). The one knob is
# RUNNER_CLI_CACHE_BUST: change it to reinstall every CLI at the same versions
# (a broken install, not a new release).
#
# Claude Code and Codex must install, so a build fails instead of shipping a
# stub. The optional CLIs fall back to a stub that reports "install failed"
# (`<cli> --version` → "<cli>-stub 0.0.0"), visible in the build log and in
# /opt/runner-cli-versions.txt. A registry that cannot be reached fails the
# build at its ADD, which also never ships a stale CLI.
ARG RUNNER_CLI_CACHE_BUST=2026-11-21

# Aider CLI (https://aider.chat), from PyPI.
# Installed in its own virtualenv so aider's (large) dependency tree never
# conflicts with the runner-service venv. The launcher is symlinked onto PATH
# and the tree is made world-readable so the per-agent UIDs (20000+) the runner
# drops to can exec it.
ADD https://pypi.org/pypi/aider-chat/json /tmp/aider-chat-pypi.json
RUN echo "Agent CLI refresh key: ${RUNNER_CLI_CACHE_BUST}" \
    && (AIDER_VERSION="$(jq -er '.info.version | select(type == "string" and length > 0)' /tmp/aider-chat-pypi.json)" \
     && echo "Resolved aider-chat latest to ${AIDER_VERSION}" \
     && /usr/local/bin/python3.12 -m venv /opt/aider \
     && /opt/aider/bin/pip install --no-cache-dir --upgrade pip \
     && /opt/aider/bin/pip install --no-cache-dir "aider-chat==${AIDER_VERSION}" \
     && ln -sf /opt/aider/bin/aider /usr/local/bin/aider \
     && chmod -R a+rX /opt/aider) \
    || (echo "WARN: aider-chat install failed — installing stub" \
        && printf '#!/bin/sh\necho "aider-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/aider \
        && chmod +x /usr/local/bin/aider); \
    rm -f /tmp/aider-chat-pypi.json

# Mistral Vibe Code CLI (https://github.com/mistralai/mistral-vibe), from PyPI.
# Same layout as aider: its own virtualenv, launcher symlinked onto PATH, tree
# world-readable for the per-agent UIDs.
ADD https://pypi.org/pypi/mistral-vibe/json /tmp/mistral-vibe-pypi.json
RUN (VIBE_VERSION="$(jq -er '.info.version | select(type == "string" and length > 0)' /tmp/mistral-vibe-pypi.json)" \
     && echo "Resolved mistral-vibe latest to ${VIBE_VERSION}" \
     && /usr/local/bin/python3.12 -m venv /opt/vibe \
     && /opt/vibe/bin/pip install --no-cache-dir --upgrade pip \
     && /opt/vibe/bin/pip install --no-cache-dir "mistral-vibe==${VIBE_VERSION}" \
     && ln -sf /opt/vibe/bin/vibe /usr/local/bin/vibe \
     && chmod -R a+rX /opt/vibe) \
    || (echo "WARN: mistral-vibe install failed — installing stub" \
        && printf '#!/bin/sh\necho "vibe-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/vibe \
        && chmod +x /usr/local/bin/vibe); \
    rm -f /tmp/mistral-vibe-pypi.json

# Hermes Agent (https://github.com/NousResearch/hermes-agent)
# The official installer resolves the latest published release itself (its
# default "stable" channel); the releases feed only keys this layer, so it
# re-runs when Hermes publishes a release.
# Their installer is interactive in some paths; we run it non-interactively
# and fall back to a stub if it fails.
#
# The installer relies on `uv`, which by default puts its managed Python
# under $HOME/.local/share/uv/python. Built as root that lands in
# /root/.local — unreadable by the per-agent UIDs (20000+) the runner
# drops to before spawning the CLI, which makes /usr/local/bin/hermes
# fail with "bad interpreter: Permission denied" and leaves the chat
# terminal empty. Pin uv's install dirs to a world-readable location and
# chmod the resulting trees a+rX so every UID can exec the shim.
#
# A failed install leaves ~3 GB under /root/.hermes (installer v0.23 layout).
# Nothing runs from there once the stub replaces the launcher, so the failure
# branch deletes it in the same layer instead of shipping it to every node.
ADD https://github.com/NousResearch/hermes-agent/releases.atom /tmp/hermes-releases.atom
RUN rm -f /tmp/hermes-releases.atom \
    && curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o /tmp/hermes-install.sh \
    && UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
       UV_PYTHON_BIN_DIR=/usr/local/share/uv/python-bin \
       bash /tmp/hermes-install.sh < /dev/null \
    && chmod -R a+rX /usr/local/share/uv /usr/local/lib/hermes-agent 2>/dev/null \
    ; rm -f /tmp/hermes-install.sh \
    ; [ -x /usr/local/bin/hermes ] && /usr/local/bin/hermes --version >/dev/null 2>&1 \
    || (echo "WARN: hermes install failed — installing stub and removing the partial install" \
        && rm -rf /root/.hermes /root/.local/bin/hermes /usr/local/share/uv \
        && printf '#!/bin/sh\necho "hermes-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/hermes \
        && chmod +x /usr/local/bin/hermes)

# OpenClaw CLI (https://openclaw.ai), from npm.
ADD https://registry.npmjs.org/openclaw/latest /tmp/openclaw-latest.json
RUN (OPENCLAW_VERSION="$(jq -er '.version | select(type == "string" and length > 0)' /tmp/openclaw-latest.json)" \
     && echo "Resolved openclaw@latest to ${OPENCLAW_VERSION}" \
     && npm install -g --prefer-online "openclaw@${OPENCLAW_VERSION}") \
    || (echo "WARN: openclaw npm install failed — installing stub" \
        && printf '#!/bin/sh\necho "openclaw-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/openclaw \
        && chmod +x /usr/local/bin/openclaw); \
    rm -f /tmp/openclaw-latest.json

# OpenCode CLI (https://opencode.ai), from npm.
ADD https://registry.npmjs.org/opencode-ai/latest /tmp/opencode-latest.json
RUN (OPENCODE_VERSION="$(jq -er '.version | select(type == "string" and length > 0)' /tmp/opencode-latest.json)" \
     && echo "Resolved opencode-ai@latest to ${OPENCODE_VERSION}" \
     && npm install -g --prefer-online "opencode-ai@${OPENCODE_VERSION}") \
    || echo "WARN: opencode-ai install failed — backend will be unavailable"; \
    rm -f /tmp/opencode-latest.json

# OpenAI Codex CLI (https://github.com/openai/codex), from npm. Must install.
# The chmods let per-agent UIDs (20000+) traverse the install tree and execute
# the platform-specific native binary, including stripped exec bits. Runners
# never update Codex themselves: the per-agent UID cannot write the global npm
# prefix (see configure_codex_permissions, which turns the in-app update check
# off).
ADD https://registry.npmjs.org/@openai/codex/latest /tmp/codex-latest.json
RUN CODEX_RESOLVED_VERSION="$(jq -er '.version | select(type == "string" and length > 0)' /tmp/codex-latest.json)" \
    && echo "Resolved @openai/codex@latest to ${CODEX_RESOLVED_VERSION}" \
    && npm install -g --prefer-online "@openai/codex@${CODEX_RESOLVED_VERSION}" \
    && CODEX_NPM_ROOT="$(npm root -g)" \
    && chmod -R a+rX "${CODEX_NPM_ROOT}/@openai" \
    && find "${CODEX_NPM_ROOT}/@openai" -type f -path "*/vendor/*" -exec chmod +x {} \; \
    && codex --version \
    && rm /tmp/codex-latest.json

# Claude Code CLI (Anthropic), from npm. Must install. Last: it releases most
# often, and a release only re-runs this layer.
ADD https://registry.npmjs.org/@anthropic-ai/claude-code/latest /tmp/claude-code-latest.json
RUN CLAUDE_CODE_VERSION="$(jq -er '.version | select(type == "string" and length > 0)' /tmp/claude-code-latest.json)" \
    && echo "Resolved @anthropic-ai/claude-code@latest to ${CLAUDE_CODE_VERSION}" \
    && npm install -g --prefer-online "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
    && claude --version \
    && rm /tmp/claude-code-latest.json

# Copy server code (modular Python files) and entrypoint
COPY runner-service/src/*.py .
COPY runner-service/src/backends/*.py ./backends/
COPY runner-service/src/entrypoint.sh runner-service/src/rust_toolchain.sh runner-service/src/android_toolchain.sh runner-service/src/azure_cli.sh ./
RUN chmod +x entrypoint.sh rust_toolchain.sh android_toolchain.sh azure_cli.sh

# Verify installations, and record the agent CLI versions this image ships
# (read it on a live runner: `docker exec <runner> cat /opt/runner-cli-versions.txt`).
RUN echo "=== Python ===" && python --version && \
    echo "=== tini ===" && /usr/bin/tini --version && \
    echo "=== Node.js ===" && node --version && \
    echo "=== Git ===" && git --version && \
    echo "=== Docker ===" && docker --version && \
    echo "=== Chromium ===" && chromium --version && \
    echo "=== Go ===" && go version && \
    claude --version >/dev/null && codex --version >/dev/null && \
    for cli in claude codex opencode openclaw hermes aider vibe; do \
      v="$("$cli" --version 2>/dev/null | head -n 1)"; \
      printf '%s: %s\n' "$cli" "${v:-not installed}"; \
    done > /opt/runner-cli-versions.txt && \
    echo "=== Agent CLIs ===" && cat /opt/runner-cli-versions.txt

# ─── No USER directive: this is deliberate ────────────────────────────────
# Every other image in this repo drops to an unprivileged UID. This one cannot,
# and the omission must not be "fixed" by adding `USER` here.
#
# The runner's isolation model is per-agent, not per-container: agent_user.py
# assigns each agent a deterministic UID in 20000..60000, chowns its HOME to
# that UID at 0700, and launches the CLI subprocess under it via setresuid.
# Both operations require CAP_CHOWN / CAP_SETUID / CAP_SETGID in the parent, so
# the server process has to start privileged. Adding `USER` collapses every
# agent onto one shared UID and silently removes the isolation between them
# (os.chown and Popen(user=...) start failing with EPERM).
#
# What contains this image instead: cap_drop ALL plus that minimal cap_add, and
# no-new-privileges:true — see the runner services in docker-compose.yml. Deploy
# it with an equivalent capability allowlist or not at all.

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -sf http://localhost:8000/health || exit 1

# ─── Init process: reap the CLIs' orphans ─────────────────────────────────
# The agent CLIs daemonise. `tmux new-session -d` forks a server that detaches
# from its caller, and the CLI processes inside it outlive the client that
# spawned them — every one of those is reparented to PID 1 when its parent
# goes. `python server.py` as PID 1 only wait()s the children it spawned
# itself, so the reparented ones pile up as [tmux: server] / [claude]
# <defunct> until the container hits its pid limit.
#
# tini reaps them. `-s` registers it as a child subreaper so it still collects
# orphans when it is NOT PID 1 — which is the case under `init: true` (set on
# every runner service in docker-compose.yml and devops/docker-compose.swarm.yml),
# where Docker's own init takes PID 1. Baking it in means a plain `docker run`
# of this image, or an orchestrator that ignores `init`, is covered too.
#
# Signals still reach the server: tini forwards them to its direct child, the
# entrypoint execs python, and uvicorn's lifespan tears the PTY sessions down.
ENTRYPOINT ["/usr/bin/tini", "-s", "--"]
CMD ["./entrypoint.sh"]
