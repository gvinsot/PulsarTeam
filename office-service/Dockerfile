# office-service — server-side home of office-engine (cloud/upload files).
# Build context is the repo root (see docker-compose.yml). The ~350-400MB comes
# from LibreOffice headless, which convert.py shells out to for high-fidelity
# conversion/rendering; the pure-library tools need none of it.
#
# Runs as an unprivileged user: this service parses attacker-supplied documents
# with LibreOffice, historically the richest source of parser CVEs in the stack,
# so image-level privilege separation matters even more here than elsewhere. The
# compose file's cap_drop is not enough — it does not travel with the image.
#
# DEPLOY NOTE: a *new* office-data volume inherits /data's ownership from this
# image, but an existing one stays root-owned and the service will fail to write.
# Migrate once with:  docker run --rm -v office-data:/data alpine chown -R 10002:10002 /data
FROM python:3.12-slim

# LibreOffice headless (writer/calc/impress pull libreoffice-core) + fonts so
# converted PDFs render text correctly. curl is for the compose healthcheck.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc libreoffice-impress \
        fonts-liberation fonts-dejavu-core \
        curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY office-engine/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY office-engine/office_engine ./office_engine

# Confine every file operation under /data (mounted volume of scratch/uploads).
ENV OFFICE_HOST=0.0.0.0 \
    OFFICE_PORT=8000 \
    OFFICE_ROOT=/data

# Unprivileged runtime user. /data is the only writable location the service
# needs; HOME must exist and be writable too, because LibreOffice creates a user
# profile under it on first conversion and aborts if it cannot.
RUN groupadd -g 10002 -r office \
    && useradd -u 10002 -r -g office -m -d /home/office -s /usr/sbin/nologin office \
    && mkdir -p /data \
    && chown -R office:office /data /home/office
ENV HOME=/home/office

USER office

EXPOSE 8000
CMD ["python", "-m", "office_engine.mcp_server"]
