#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
set -a
source "${SCRIPT_DIR}/.env"
set +a

echo "========================================"
echo "  PulsarTeam — Pre-deployment"
echo "========================================"

echo ""
echo "✅ Pre-deployment complete"
echo "========================================"
