# Runner Service — generic agent runtime.
#
# A single image that ships every supported CLI; the active backend is
# selected at startup via RUNNER_TYPE (claude-code, codex, openclaw, hermes,
# opencode, sandbox).
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
    && rm -rf /var/lib/apt/lists/*

# Chromium headless environment
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_FLAGS="--no-sandbox --headless --disable-gpu --disable-dev-shm-usage"

# Install Node.js 22 LTS (required by Claude Code CLI and several other runners)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ─── Agent CLIs ────────────────────────────────────────────────────────────
# Each runner backend invokes its own CLI binary. We install all of them
# unconditionally so the same image can act as any backend at runtime.
# A failed install does NOT abort the image build — the backend will
# return a clear error from /health if its CLI is missing at runtime.

# Claude Code CLI (Anthropic)
RUN npm install -g @anthropic-ai/claude-code

# OpenCode CLI (https://opencode.ai)
# Resolve npm's latest tag during the image build by default. Set
# OPENCODE_CLI_VERSION to a concrete version to pin a deployment, and bump
# OPENCODE_CLI_CACHE_BUST (or build with --no-cache) when rebuilding an
# unchanged Dockerfile so Docker re-runs this layer and re-checks npm.
ARG OPENCODE_CLI_VERSION=latest
ARG OPENCODE_CLI_CACHE_BUST=1
RUN (echo "OpenCode CLI refresh key: ${OPENCODE_CLI_CACHE_BUST}" \
     && if [ "${OPENCODE_CLI_VERSION}" = "latest" ]; then \
          OPENCODE_RESOLVED_VERSION="$(npm view opencode-ai@latest version)" \
          && echo "Resolved opencode-ai@latest to ${OPENCODE_RESOLVED_VERSION}" \
          && npm install -g "opencode-ai@${OPENCODE_RESOLVED_VERSION}"; \
        else \
          npm install -g "opencode-ai@${OPENCODE_CLI_VERSION}"; \
        fi) \
    || echo "WARN: opencode-ai install failed — backend will be unavailable"

# OpenAI Codex CLI (https://github.com/openai/codex)
# Lets the runner act as a "codex" backend that taps into the operator's
# ChatGPT plan via `codex login` (OAuth) — exactly like claude-code does
# with a Claude Pro/Max plan.
#
# The npm package ships a platform-specific native binary under
# node_modules/@openai/codex-<platform>/vendor/.../codex/codex. Some npm
# tarball extractions strip the exec bit, and even when they don't, the
# per-agent UIDs (20000+) the runner drops to before spawning need every
# parent dir to be world-traversable. Chmod the install tree the same
# way the hermes line does, then force +x on the vendored binaries.
# By default, resolve npm's latest tag during the image build. Set
# CODEX_CLI_VERSION to a concrete version to pin a deployment, and bump
# CODEX_CLI_CACHE_BUST (or build with --no-cache) when rebuilding an unchanged
# Dockerfile so Docker re-runs this layer and re-checks npm.
ARG CODEX_CLI_VERSION=latest
ARG CODEX_CLI_CACHE_BUST=1
RUN (echo "Codex CLI refresh key: ${CODEX_CLI_CACHE_BUST}" \
     && if [ "${CODEX_CLI_VERSION}" = "latest" ]; then \
          CODEX_RESOLVED_VERSION="$(npm view @openai/codex@latest version)" \
          && echo "Resolved @openai/codex@latest to ${CODEX_RESOLVED_VERSION}" \
          && npm install -g "@openai/codex@${CODEX_RESOLVED_VERSION}"; \
        else \
          npm install -g "@openai/codex@${CODEX_CLI_VERSION}"; \
        fi \
     && chmod -R a+rX /usr/lib/node_modules/@openai \
     && find /usr/lib/node_modules/@openai -type f -path "*/vendor/*" -exec chmod +x {} \; \
    ) || (echo "WARN: @openai/codex install failed — installing stub" \
        && printf '#!/bin/sh\necho "codex-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/codex \
        && chmod +x /usr/local/bin/codex)

# OpenClaw CLI (https://openclaw.ai)
RUN npm install -g openclaw \
    || (echo "WARN: openclaw npm install failed — installing stub" \
        && printf '#!/bin/sh\necho "openclaw-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/openclaw \
        && chmod +x /usr/local/bin/openclaw)

# Hermes Agent (https://github.com/NousResearch/hermes-agent)
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
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh -o /tmp/hermes-install.sh \
    && UV_PYTHON_INSTALL_DIR=/usr/local/share/uv/python \
       UV_PYTHON_BIN_DIR=/usr/local/share/uv/python-bin \
       bash /tmp/hermes-install.sh < /dev/null \
    && chmod -R a+rX /usr/local/share/uv /usr/local/lib/hermes-agent 2>/dev/null \
    ; [ -x /usr/local/bin/hermes ] && /usr/local/bin/hermes --version >/dev/null 2>&1 \
    || (echo "WARN: hermes install failed — installing stub" \
        && printf '#!/bin/sh\necho "hermes-stub 0.0.0 (install failed)"\nexit 0\n' > /usr/local/bin/hermes \
        && chmod +x /usr/local/bin/hermes)
# Make sure hermes is on PATH (installer may put it under ~/.hermes/bin)
ENV PATH="/root/.hermes/bin:/usr/local/bin:${PATH}"

# Install Go (dev tool inside agent workspaces)
RUN curl -fsSL https://go.dev/dl/go1.24.1.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/root/go/bin:$PATH"
RUN CGO_ENABLED=0 go install golang.org/x/tools/gopls@latest && \
    CGO_ENABLED=0 go install github.com/go-delve/delve/cmd/dlv@latest && \
    CGO_ENABLED=0 go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

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

# Copy server code (modular Python files) and entrypoint
COPY runner-service/src/*.py .
COPY runner-service/src/backends/*.py ./backends/
COPY runner-service/src/entrypoint.sh .
RUN chmod +x entrypoint.sh

# Verify installations
RUN echo "=== Python ===" && python --version && \
    echo "=== Node.js ===" && node --version && \
    echo "=== Claude Code ===" && claude --version && \
    echo "=== OpenCode ===" && (opencode --version 2>&1 || echo "not installed") && \
    echo "=== Codex ===" && (codex --version 2>&1 || echo "not installed") && \
    echo "=== OpenClaw ===" && openclaw --version && \
    echo "=== Hermes ===" && hermes --version && \
    echo "=== Git ===" && git --version && \
    echo "=== Docker ===" && docker --version && \
    echo "=== Chromium ===" && chromium --version && \
    echo "=== Go ===" && go version

# RTK (Rust Token Killer)
RUN RTK_ARCH=$(uname -m | sed 's/x86_64/x86_64/' | sed 's/aarch64/aarch64/') && \
    RTK_VERSION=$(curl -fsSL https://api.github.com/repos/rtk-ai/rtk/releases/latest | grep '"tag_name"' | head -1 | cut -d'"' -f4) && \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/${RTK_VERSION}/rtk-${RTK_ARCH}-unknown-linux-musl.tar.gz" | tar -xz -C /usr/local/bin/ && \
    chmod +x /usr/local/bin/rtk && \
    rtk --version

# gosu for runtime user switching
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -sf http://localhost:8000/health || exit 1

CMD ["./entrypoint.sh"]
