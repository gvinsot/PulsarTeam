# mcp-browser — crawl4ai/Playwright web-exploration tools behind FastAPI.
#
# Runs as an unprivileged user. This service drives a real Chromium against
# attacker-chosen URLs, so a browser-renderer escape must not land on uid 0. The
# compose file's cap_drop covers that only when the image is deployed from this
# repo — the USER below covers it everywhere.
FROM python:3.11-slim

# System dependencies required by Playwright / Chromium
RUN apt-get update && apt-get install -y --no-install-recommends \
        wget curl gnupg2 ca-certificates fonts-liberation \
        libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
        libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 \
        libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 \
        libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python dependencies
COPY mcp-browser/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Unprivileged runtime user, created before the browser install so the
# Chromium bundle and crawl4ai's state directory can be laid down with the right
# ownership in a single pass.
RUN groupadd -g 10003 -r crawler \
    && useradd -u 10003 -r -g crawler -m -d /home/crawler -s /usr/sbin/nologin crawler

# Pin both writable locations out of /root, which uid 10003 cannot read:
#   PLAYWRIGHT_BROWSERS_PATH — the Chromium bundle (read-only at runtime)
#   CRAWL4AI_BASE_DIRECTORY  — crawl4ai's cache/db (written at runtime)
ENV HOME=/home/crawler \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CRAWL4AI_BASE_DIRECTORY=/home/crawler

# Let crawl4ai install Playwright + Chromium. Run as root (the installer may
# still want to touch system paths), then hand the results to the runtime user.
RUN mkdir -p /ms-playwright \
    && crawl4ai-setup \
    && chmod -R a+rX /ms-playwright \
    && chown -R crawler:crawler /home/crawler

COPY --chown=crawler:crawler mcp-browser/src/ ./src/

USER crawler

EXPOSE 8000

CMD ["python", "src/server.py"]
