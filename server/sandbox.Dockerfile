FROM alpine:3.20

# Dev tools for agent sandboxes
RUN apk add --no-cache \
    bash \
    git \
    openssh-client \
    curl \
    wget \
    jq \
    grep \
    sed \
    coreutils \
    findutils \
    python3 \
    py3-pip \
    nodejs \
    npm \
    chromium \
    ca-certificates \
    docker-cli

# Install common frontend tooling globally so ephemeral sandboxes can build Vite apps
RUN npm install -g vite

# Chromium flags for running inside containers (no GPU, no sandbox needed)
ENV CHROME_BIN=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspace

CMD ["sh", "-c", "while true; do sleep 3600; done"]