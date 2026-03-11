FROM node:20-alpine AS base

WORKDIR /app

# Install system dependencies for agent coding tools
RUN apk add --no-cache \
    git openssh-client \
    curl wget \
    jq yq \
    bash \
    grep sed gawk findutils coreutils \
    tree \
    tar gzip unzip \
    python3 py3-pip \
    make gcc g++ musl-dev \
    ripgrep \
    fd \
    less \
    patch diffutils \
    docker-cli \
    shadow \
    util-linux

# Configure git at runtime via entrypoint (user/email from env vars)
ENV GIT_USER_NAME=""
ENV GIT_USER_EMAIL=""

# Add GitHub's SSH host keys to known_hosts
RUN mkdir -p /root/.ssh && \
    ssh-keyscan github.com >> /root/.ssh/known_hosts

# Install dependencies
COPY api/package*.json ./
RUN npm i --production

# Copy source code
COPY api/src ./src

# ── Test stage ──────────────────────────────────────────────
FROM base AS test
CMD ["sh", "-c", "node --test src/services/__tests__/*.test.js"]

# ── Production stage ────────────────────────────────────────
FROM base AS production
COPY api/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 3001

ENTRYPOINT ["/entrypoint.sh"]
CMD ["node", "src/index.js"]
