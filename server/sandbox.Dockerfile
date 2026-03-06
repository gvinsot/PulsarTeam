FROM node:20-alpine

# Dev tools for agent sandboxes
RUN apk add --no-cache \
    git openssh-client \
    curl wget \
    jq yq \
    bash \
    grep sed gawk findutils coreutils \
    tree \
    tar gzip unzip \
    python3 py3-pip py3-pytest \
    make gcc g++ musl-dev \
    ripgrep \
    fd \
    less \
    patch diffutils \
    docker-cli docker-cli-compose \
    # Headless Chromium for web scraping, testing, PDF generation
    chromium nss freetype harfbuzz ca-certificates ttf-freefont

# Chromium flags for running inside containers (no GPU, no sandbox needed)
ENV CHROMIUM_BIN=/usr/bin/chromium-browser \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser \
    CHROME_BIN=/usr/bin/chromium-browser \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PLAYWRIGHT_BROWSERS_PATH=/usr/lib \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# Global Node.js dev tools & browser automation
RUN npm install -g \
    playwright-core \
    puppeteer-core \
    typescript \
    ts-node \
    eslint \
    prettier \
    jest \
    vitest \
    lighthouse

# kubectl
RUN curl -LO "https://dl.k8s.io/release/$(curl -Ls https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/

# GitHub SSH host keys
RUN mkdir -p /root/.ssh && \
    ssh-keyscan github.com >> /root/.ssh/known_hosts

WORKDIR /workspace

# Keep container alive for docker exec
CMD ["tail", "-f", "/dev/null"]
