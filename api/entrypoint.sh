#!/bin/sh
set -e

# Secrets are NOT loaded into env vars — application code reads them directly
# from /run/secrets/<NAME> via api/src/secrets.ts. This keeps them out of
# /proc/<pid>/environ and out of `docker inspect` output.

# Git identity for agent commits
if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

exec "$@"
