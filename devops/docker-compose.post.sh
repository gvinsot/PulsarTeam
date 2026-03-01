#!/bin/bash
set -e

echo "========================================"
echo "  Agent Swarm UI — Post-deployment"
echo "========================================"

echo ""
echo "🔍 Checking stack services..."
docker stack services agentswarm 2>/dev/null || echo "   Stack 'agentswarm' not found — deploy with: docker stack deploy -c docker-compose.swarm.yml agentswarm"

echo ""
echo "🌐 Application should be available at:"
echo "   https://swarm.methodinfo.fr"
echo ""
echo "   Default login: admin / swarm2026"
echo ""
echo "✅ Post-deployment complete"
echo "========================================"
