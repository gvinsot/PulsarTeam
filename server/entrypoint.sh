#!/bin/sh
set -e

# Create RUN_AS_USER with matching UID/GID from the host
if [ -n "$RUN_AS_USER" ]; then
  uid="${RUN_AS_UID:-1000}"
  gid="${RUN_AS_GID:-1000}"

  # Free up UID/GID if already taken by another user (e.g. 'node' uses 1000 in node:alpine)
  existing_user=$(getent passwd "$uid" 2>/dev/null | cut -d: -f1 || true)
  if [ -n "$existing_user" ] && [ "$existing_user" != "$RUN_AS_USER" ]; then
    usermod -u 65534 "$existing_user" 2>/dev/null || true
  fi
  existing_group=$(getent group "$gid" 2>/dev/null | cut -d: -f1 || true)
  if [ -n "$existing_group" ] && [ "$existing_group" != "$RUN_AS_USER" ]; then
    groupmod -g 65534 "$existing_group" 2>/dev/null || true
  fi

  # Create group if it doesn't exist
  if ! getent group "$gid" >/dev/null 2>&1; then
    addgroup -g "$gid" "$RUN_AS_USER"
  fi

  # Create user if it doesn't exist
  if ! id "$RUN_AS_USER" >/dev/null 2>&1; then
    adduser -D -u "$uid" -G "$(getent group "$gid" | cut -d: -f1)" -s /bin/bash "$RUN_AS_USER"
  fi

  # Ensure the user's home has a .gitconfig
  user_home="$(eval echo ~"$RUN_AS_USER")"
  if [ -n "$GIT_USER_NAME" ]; then
    git config --global user.name "$GIT_USER_NAME"
    su -s /bin/sh "$RUN_AS_USER" -c "git config --global user.name '$GIT_USER_NAME'"
  fi
  if [ -n "$GIT_USER_EMAIL" ]; then
    git config --global user.email "$GIT_USER_EMAIL"
    su -s /bin/sh "$RUN_AS_USER" -c "git config --global user.email '$GIT_USER_EMAIL'"
  fi

  # Copy SSH keys to user's home if available
  if [ -d /root/.ssh ]; then
    mkdir -p "$user_home/.ssh"
    cp -a /root/.ssh/* "$user_home/.ssh/" 2>/dev/null || true
    chown -R "$uid:$gid" "$user_home/.ssh"
  fi
else
  # No RUN_AS_USER — configure git for root only
  if [ -n "$GIT_USER_NAME" ]; then
    git config --global user.name "$GIT_USER_NAME"
  fi
  if [ -n "$GIT_USER_EMAIL" ]; then
    git config --global user.email "$GIT_USER_EMAIL"
  fi
fi

exec "$@"
