# office-service — server-side home of office-engine (cloud/upload files).
# Build context is the repo root (see docker-compose.yml). The ~350-400MB comes
# from LibreOffice headless, which convert.py shells out to for high-fidelity
# conversion/rendering; the pure-library tools need none of it.
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
RUN mkdir -p /data

EXPOSE 8000
CMD ["python", "-m", "office_engine.mcp_server"]
