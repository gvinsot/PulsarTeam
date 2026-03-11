#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
source "${SCRIPT_DIR}/.env"
set +a

echo "========================================"
echo "  Agent Swarm UI — Pre-deployment"
echo "========================================"

# 0. Auto-detect RUN_AS_USER UID/GID from the host
if [ -n "$RUN_AS_USER" ]; then
  detected_uid=$(id -u "$RUN_AS_USER" 2>/dev/null || echo "")
  detected_gid=$(id -g "$RUN_AS_USER" 2>/dev/null || echo "")
  if [ -n "$detected_uid" ] && [ -n "$detected_gid" ]; then
    export RUN_AS_UID="$detected_uid"
    export RUN_AS_GID="$detected_gid"
    # Persist into .env so docker stack deploy picks them up
    sed -i "s/^RUN_AS_UID=.*/RUN_AS_UID=${detected_uid}/" "${SCRIPT_DIR}/.env"
    sed -i "s/^RUN_AS_GID=.*/RUN_AS_GID=${detected_gid}/" "${SCRIPT_DIR}/.env"
    echo "👤 RUN_AS_USER=${RUN_AS_USER} → UID=${detected_uid} GID=${detected_gid}"
  else
    echo "⚠️  User '${RUN_AS_USER}' not found on host — keeping existing UID/GID from .env"
  fi
fi

# 1. Build Docker images
echo ""
echo "🔨 Building Docker images..."
cd "${SCRIPT_DIR}"
docker compose -f docker-compose.swarm.yml build

# 2. Push images to registry
echo ""
echo "📤 Pushing images to registry..."
docker compose -f docker-compose.swarm.yml push

# 3. Build client dist on the host (for bind-mounted volume)
echo ""
echo "📦 Building frontend assets on host..."
CLIENT_DIR="${HOST_CODE_PATH}/AgentsSwarmUI/frontend"
if [ -d "${CLIENT_DIR}" ]; then
  docker run --rm \
    -v "${CLIENT_DIR}:/build" \
    -w /build \
    node:20-alpine \
    sh -c "npm ci && npm run build"
  echo "   ✅ Frontend built at ${CLIENT_DIR}/dist"
else
  echo "   ⚠️  Frontend directory not found at ${CLIENT_DIR}"
  echo "      Falling back to image-baked dist (no bind mount override)"
fi

# 4. Ensure api source exists on host
echo ""
SERVER_DIR="${HOST_CODE_PATH}/AgentsSwarmUI/api"
if [ -d "${SERVER_DIR}/src" ]; then
  echo "✅ API source found at ${SERVER_DIR}/src"
else
  echo "⚠️  API source not found at ${SERVER_DIR}/src"
  echo "   Make sure the repo is cloned at ${HOST_CODE_PATH}/AgentsSwarmUI"
fi

echo ""
echo "✅ Pre-deployment complete"
echo "========================================"
