"""
Runner Service — Command security: blocklist, sanitization, and environment isolation.

Prevents agents from executing dangerous commands that could compromise the host,
exfiltrate secrets, or escape their sandbox.
"""

import re
import os
from typing import Optional
from config import logger

# Commands that are completely blocked — these can damage the host or exfiltrate data
BLOCKED_COMMANDS = [
    "shutdown", "reboot", "poweroff", "halt", "init",
    "mkfs", "fdisk", "mount", "umount",
    "iptables", "ip6tables", "nft", "ufw",
    "useradd", "userdel", "usermod", "groupadd", "groupdel",
    "passwd", "chpasswd", "su ",
    "crontab", "at ",
    "systemctl", "service ",
    "insmod", "rmmod", "modprobe",
    "dd if=",
    "nc -l", "ncat -l", "socat ",
    "nmap ", "masscan ",
    "tcpdump", "wireshark", "tshark",
]

# Patterns that indicate dangerous intent — blocked regardless of command
BLOCKED_PATTERNS = [
    re.compile(r"/proc/\d+/"),
    re.compile(r"/proc/self/"),
    re.compile(r"/sys/"),
    re.compile(r"/dev/(?!null|zero|urandom|stdin|stdout|stderr)"),
    re.compile(r">\s*/etc/"),
    re.compile(r">\s*/var/"),
    re.compile(r">\s*/usr/"),
    re.compile(r">\s*/bin/"),
    re.compile(r">\s*/sbin/"),
    re.compile(r"mkfifo\s"),
    re.compile(r"mknod\s"),
    # Prevent reading environment/secrets via filesystem
    re.compile(r"cat\s+/proc/self/environ"),
    re.compile(r"cat\s+/proc/\d+/environ"),
    re.compile(r"strings\s+/proc/"),
    # Prevent reverse shells
    re.compile(r"bash\s+-i\s+>&\s*/dev/tcp/"),
    re.compile(r"/dev/tcp/"),
    re.compile(r"/dev/udp/"),
    # Prevent exfiltrating env vars to external servers
    re.compile(r"curl.*\$\(?.*(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)", re.IGNORECASE),
    re.compile(r"wget.*\$\(?.*(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)", re.IGNORECASE),
]

# Environment variables that are safe to pass to agent subprocesses
ENV_ALLOWLIST = {
    "HOME", "USER", "LOGNAME", "SHELL", "TERM",
    "PATH", "LANG", "LC_ALL", "LC_CTYPE",
    "TZ", "EDITOR",
    "PROJECTS_DIR", "DATA_DIR",
    # Git
    "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
    "GIT_SSH_COMMAND", "GIT_ASKPASS", "GIT_TERMINAL_PROMPT",
    # Node.js
    "NODE_ENV", "NODE_PATH", "NODE_OPTIONS", "NPM_CONFIG_PREFIX",
    "npm_config_cache", "npm_config_prefix",
    # Python
    "PYTHONPATH", "PYTHONDONTWRITEBYTECODE", "VIRTUAL_ENV",
    "PIP_CACHE_DIR", "PIP_DISABLE_PIP_VERSION_CHECK",
    # Build tools
    "CC", "CXX", "CFLAGS", "CXXFLAGS", "LDFLAGS",
    "GOPATH", "GOROOT", "GOPROXY",
    "CARGO_HOME", "RUSTUP_HOME",
    # Runner internals (needed by Claude Code CLI)
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    # Display
    "NO_COLOR", "FORCE_COLOR",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
}

# Environment variable name patterns that are safe to pass through
ENV_PATTERN_ALLOWLIST = [
    re.compile(r"^GIT_"),
    re.compile(r"^npm_"),
    re.compile(r"^PYTHON"),
    re.compile(r"^NODE_"),
    re.compile(r"^CLAUDE_CODE_"),
]


def validate_command(command: str) -> Optional[str]:
    """
    Validate a shell command against security rules.
    Returns None if the command is safe, or an error message if blocked.
    """
    if not command or not command.strip():
        return "Empty command"

    cmd_lower = command.strip().lower()

    # Check blocked commands
    for blocked in BLOCKED_COMMANDS:
        if cmd_lower.startswith(blocked) or f"; {blocked}" in cmd_lower or f"&& {blocked}" in cmd_lower or f"| {blocked}" in cmd_lower:
            logger.warning(f"🛡️ [Security] Blocked command: {command[:100]}")
            return f"Command blocked for security: '{blocked.strip()}' is not allowed"

    # Check blocked patterns
    for pattern in BLOCKED_PATTERNS:
        if pattern.search(command):
            logger.warning(f"🛡️ [Security] Blocked pattern in command: {command[:100]}")
            return f"Command blocked for security: contains a restricted pattern"

    return None


def sanitize_env(env: dict, agent_user: Optional[dict] = None) -> dict:
    """
    Filter environment variables to only pass safe ones to agent subprocesses.
    Prevents leaking API keys, tokens, and other secrets.
    """
    safe_env = {}

    for key, value in env.items():
        if key in ENV_ALLOWLIST:
            safe_env[key] = value
            continue
        for pattern in ENV_PATTERN_ALLOWLIST:
            if pattern.match(key):
                safe_env[key] = value
                break

    # Override with agent-specific values
    if agent_user:
        safe_env["HOME"] = agent_user["home"]
        safe_env["USER"] = agent_user["username"]
        safe_env["LOGNAME"] = agent_user["username"]

    # Ensure PATH is always set
    if "PATH" not in safe_env:
        safe_env["PATH"] = "/usr/local/bin:/usr/bin:/bin"

    return safe_env
