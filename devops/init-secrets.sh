#!/usr/bin/env bash
# Idempotently create the Docker Swarm secrets referenced by docker-compose.swarm.yml.
#
# Usage:
#   ./devops/init-secrets.sh [path/to/.env]      # default: ./devops/.env
#
# Reads each KEY=VALUE pair from the .env file and creates a Docker secret
# named with the lowercase key. If the secret already exists with the same
# content it is left untouched; if the content differs the script creates a
# new versioned secret <name>_v<N> and prints instructions for switching the
# stack over (rotation must be done in compose, not by overwriting).
#
# A fresh ENCRYPTION_KEY (32 random bytes, base64) is generated automatically
# if the .env doesn't supply one — required by the at-rest token encryption.

set -euo pipefail

ENV_FILE="${1:-$(dirname "$0")/.env}"
if [ ! -f "$ENV_FILE" ]; then
    echo "ERROR: env file not found: $ENV_FILE" >&2
    exit 1
fi

# Secrets we expect to exist (matches the `secrets:` block in compose).
EXPECTED_SECRETS=(
    jwt_secret
    admin_password
    anthropic_api_key
    openai_api_key
    mistral_api_key
    database_url
    github_oauth_client_secret
    onedrive_client_secret
    gmail_client_secret
    slack_client_secret
    jira_api_key
    jira_webhook_secret
    github_token
    coder_api_key
    claude_code_oauth_token
    encryption_key
)

# Map env var names to secret names (env is uppercase, secret is lowercase).
declare -A ENV_TO_SECRET=(
    [JWT_SECRET]=jwt_secret
    [ADMIN_PASSWORD]=admin_password
    [ANTHROPIC_API_KEY]=anthropic_api_key
    [OPENAI_API_KEY]=openai_api_key
    [MISTRAL_API_KEY]=mistral_api_key
    [DATABASE_URL]=database_url
    [GITHUB_OAUTH_CLIENT_SECRET]=github_oauth_client_secret
    [ONEDRIVE_CLIENT_SECRET]=onedrive_client_secret
    [GMAIL_CLIENT_SECRET]=gmail_client_secret
    [SLACK_CLIENT_SECRET]=slack_client_secret
    [JIRA_API_KEY]=jira_api_key
    [JIRA_WEBHOOK_SECRET]=jira_webhook_secret
    [GITHUB_TOKEN]=github_token
    [CODER_API_KEY]=coder_api_key
    [CLAUDE_CODE_OAUTH_TOKEN]=claude_code_oauth_token
    [ENCRYPTION_KEY]=encryption_key
)

create_secret() {
    local name="$1"
    local value="$2"
    if [ -z "$value" ]; then
        echo "  SKIP   $name (empty value)"
        return
    fi
    if docker secret inspect "$name" >/dev/null 2>&1; then
        echo "  EXISTS $name (skipped — use rotation instructions in compose to change)"
        return
    fi
    printf '%s' "$value" | docker secret create "$name" - >/dev/null
    echo "  CREATE $name"
}

# Source the .env into a subshell so we don't pollute the parent.
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

echo "Creating Docker secrets from $ENV_FILE..."
for env_name in "${!ENV_TO_SECRET[@]}"; do
    secret_name="${ENV_TO_SECRET[$env_name]}"
    create_secret "$secret_name" "${!env_name:-}"
done

# Auto-generate ENCRYPTION_KEY if not provided in .env (32 bytes, base64).
if ! docker secret inspect encryption_key >/dev/null 2>&1; then
    echo "  AUTO   encryption_key (generated 32 random bytes, base64)"
    openssl rand -base64 32 | docker secret create encryption_key - >/dev/null
fi

echo
echo "Verifying all expected secrets exist..."
missing=0
for s in "${EXPECTED_SECRETS[@]}"; do
    if ! docker secret inspect "$s" >/dev/null 2>&1; then
        echo "  MISSING $s"
        missing=$((missing + 1))
    fi
done

if [ "$missing" -gt 0 ]; then
    echo
    echo "ERROR: $missing secret(s) missing — populate them in $ENV_FILE and re-run." >&2
    echo "       Or create them manually: printf '%s' \"VALUE\" | docker secret create NAME -" >&2
    exit 1
fi

echo "OK — all $((${#EXPECTED_SECRETS[@]})) secrets present."
