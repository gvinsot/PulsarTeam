#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "${SCRIPT_DIR}/.env"

echo "========================================"
echo "  Agent Swarm UI — Pre-deployment"
echo "========================================"

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
echo "📦 Building client assets on host..."
CLIENT_DIR="${HOST_CODE_PATH}/AgentsSwarmUI/client"
if [ -d "${CLIENT_DIR}" ]; then
  docker run --rm \
    -v "${CLIENT_DIR}:/build" \
    -w /build \
    node:20-alpine \
    sh -c "npm ci && npm run build"
  echo "   ✅ Client built at ${CLIENT_DIR}/dist"
else
  echo "   ⚠️  Client directory not found at ${CLIENT_DIR}"
  echo "      Falling back to image-baked dist (no bind mount override)"
fi

# 4. Ensure server source exists on host
echo ""
SERVER_DIR="${HOST_CODE_PATH}/AgentsSwarmUI/server"
if [ -d "${SERVER_DIR}/src" ]; then
  echo "✅ Server source found at ${SERVER_DIR}/src"
else
  echo "⚠️  Server source not found at ${SERVER_DIR}/src"
  echo "   Make sure the repo is cloned at ${HOST_CODE_PATH}/AgentsSwarmUI"
fi

echo ""
echo "✅ Pre-deployment complete"
echo "========================================"
