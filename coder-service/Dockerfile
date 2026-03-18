# Coder Service - FastAPI proxy to Claude Code CLI
FROM python:3.12-slim

WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Build tools
    build-essential \
    git \
    curl \
    wget \
    ca-certificates \
    # Development tools
    jq \
    netcat-openbsd \
    dnsutils \
    # Database clients
    postgresql-client \
    sqlite3 \
    # Template rendering (envsubst)
    gettext-base \
    # Chromium headless (for web scraping / browser automation)
    chromium \
    chromium-driver \
    fonts-liberation \
    fonts-noto-color-emoji \
    # Utilities
    util-linux \
    openssh-client \
    # Cleanup
    && rm -rf /var/lib/apt/lists/*

# Chromium headless environment
ENV CHROME_BIN=/usr/bin/chromium
ENV CHROMIUM_FLAGS="--no-sandbox --headless --disable-gpu --disable-dev-shm-usage"

# Install Node.js 22 LTS (required for Claude Code CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Install Go
RUN curl -fsSL https://go.dev/dl/go1.24.1.linux-$(dpkg --print-architecture).tar.gz | tar -C /usr/local -xz
ENV PATH="/usr/local/go/bin:/root/go/bin:$PATH"
RUN CGO_ENABLED=0 go install golang.org/x/tools/gopls@latest && \
    CGO_ENABLED=0 go install github.com/go-delve/delve/cmd/dlv@latest && \
    CGO_ENABLED=0 go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest

# Install Docker CLI (for agent to manage containers)
RUN curl -fsSL https://download.docker.com/linux/debian/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/debian $(. /etc/os-release && echo $VERSION_CODENAME) stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && rm -rf /var/lib/apt/lists/*

# Create a dedicated Python virtual environment (PEP 668 compatible)
RUN python3.12 -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Copy and install Python dependencies
COPY coder-service/requirements.txt .
RUN /opt/venv/bin/pip install --no-cache-dir -r requirements.txt

# Make dev tools available globally (for scripts calling /usr/bin/python3 -m pytest)
RUN pip install --break-system-packages pytest black

# Copy server code and entrypoint
COPY coder-service/src/server.py .
COPY coder-service/src/entrypoint.sh .
RUN chmod +x entrypoint.sh

# Verify installations
RUN echo "=== Python ===" && python --version && \
    echo "=== Node.js ===" && node --version && \
    echo "=== npm ===" && npm --version && \
    echo "=== Claude Code ===" && claude --version && \
    echo "=== Git ===" && git --version && \
    echo "=== Docker ===" && docker --version && \
    echo "=== Chromium ===" && chromium --version && \
    echo "=== Go ===" && go version

# Install gosu for runtime user switching
RUN apt-get update && apt-get install -y --no-install-recommends gosu && rm -rf /var/lib/apt/lists/*

# Health check
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=60s \
    CMD curl -sf http://localhost:8000/health || exit 1

# Start FastAPI server (entrypoint creates user from PUID/PGID env vars)
CMD ["./entrypoint.sh"]
