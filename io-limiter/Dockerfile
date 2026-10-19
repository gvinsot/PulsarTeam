# io-limiter — per-node disk write throttle for labelled containers (CLI runners).
# See io_limiter.py for why this exists (Swarm has no blkio_config).
# Build context is the repo root (see docker-compose.yml).
FROM python:3.13-alpine

WORKDIR /app
COPY io-limiter/io_limiter.py io-limiter/test_io_limiter.py ./
RUN python -m unittest -q test_io_limiter && rm -rf __pycache__ test_io_limiter.py

ENV PYTHONUNBUFFERED=1
# Runs as root: it must write the host's cgroup files (root-owned) and talk to
# the Docker socket. It has no listening port and needs no capability.
CMD ["python", "/app/io_limiter.py"]
