#!/bin/bash
set -e

POST_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# PulsarCD exports the target stack (qa-pulsarteam for QA) as DEPLOY_STACK_NAME;
# its STACK_NAME is not exported to hooks. Falling back to the default silently
# reconfigured production on every QA deploy and left QA's Chromium unsandboxable.
DEPLOYED_STACK="${DEPLOY_STACK_NAME:-${STACK_NAME:-pulsarteam}}"

# stack deploy ignores service security_opt on this Docker CLI. Reconcile the
# Engine service spec explicitly, preserving the non-root Chromium sandbox.
python3 "$POST_SCRIPT_DIR/configure-auth-browser.py" "$DEPLOYED_STACK"

echo "========================================"
echo "  PulsarTeam — Post-deployment"
echo "========================================"

echo ""
echo "🔍 Checking stack services..."
docker stack services "$DEPLOYED_STACK"

echo ""
echo "🌐 Application should be available at:"
echo "   https://swarm.methodinfo.fr"
echo ""
echo "   Login with the credentials configured in your .env file"
echo ""
echo "✅ Post-deployment complete"
echo "========================================"
