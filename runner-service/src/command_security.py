"""
Runner Service — Command guardrail and environment isolation.

Two very different things live in this module, and conflating them is a mistake:

1. `validate_command()` — an ACCIDENT GUARDRAIL, not a security boundary.
   It is a prefix/substring blocklist over a string that a shell will later
   re-interpret, so it is trivially bypassable by design: `/bin/sh -c
   'shutdow'"n"`, `$(printf '\\x73hutdown')`, `eval "$X"`, base64, a here-doc,
   a wrapper script, a Makefile target… Worse, it only sees commands routed
   through the HTTP tool surface (`/exec-shell`, `execute_shell`, and the API's
   `run_command` tool). The interactive PTY (`pty_session.py`, the CLI backends)
   spawns whatever the agent CLI decides to spawn and never passes through here.
   So its value is exactly one thing: stopping a well-behaved agent from
   *accidentally* rebooting the box or wiping a filesystem while it flails at a
   task. Do not gate anything on it, do not extend it hoping it becomes a
   sandbox, and do not treat "the blocklist missed X" as a vulnerability.

2. `sanitize_env()` — a real control. Runner secrets never enter the child's
   environment, so an agent subprocess cannot read `ANTHROPIC_API_KEY`,
   `JWT_SECRET`, DB credentials, … out of its own `environ`.

The actual containment for agent-run commands is elsewhere and is what should be
strengthened when isolation needs to improve: a per-agent UID with a 0700 HOME
(`agent_user.py`), the container's `cap_drop: ALL` + `no-new-privileges:true`
policy in `docker-compose.yml`, and the per-agent `execution.shellAccess` /
`filesystem.restrictedPaths` permissions enforced in `routes_api.py`. See the
"Known limitations" section of SECURITY.md.
"""

import re
import os
from typing import Optional
from config import logger

# Commands a task should never need, and whose accidental use is expensive:
# host lifecycle, disk formatting, firewall/user/service administration, packet
# capture and listeners. Prefix/substring matched — see the module docstring for
# why that is deliberately weak and must not be relied on as a boundary.
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

# Shapes that are almost never an honest mistake (reverse shells, secret
# exfiltration, writes into system directories). Same caveat: a regex over a
# string the shell has not expanded yet catches the literal form only.
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
    # GitHub — injected per-agent from the plugin token resolved by the API,
    # so CLI runners and the `gh` tool can authenticate without re-prompting.
    "GITHUB_TOKEN", "GH_TOKEN", "GH_HOST", "GITHUB_USER", "GITHUB_API_URL",
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
    Screen a shell command against the accident guardrail.

    Returns None when nothing obviously destructive was spotted, or a message
    explaining the refusal. A None result means "no known footgun in the literal
    string" — NOT "this command is safe to run". See the module docstring.
    """
    if not command or not command.strip():
        return "Empty command"

    cmd_lower = command.strip().lower()

    # Check blocked commands
    for blocked in BLOCKED_COMMANDS:
        if cmd_lower.startswith(blocked) or f"; {blocked}" in cmd_lower or f"&& {blocked}" in cmd_lower or f"| {blocked}" in cmd_lower:
            logger.warning(f"🛡️ [Guardrail] Refused command: {command[:100]}")
            return f"Command refused by the safety guardrail: '{blocked.strip()}' is not allowed here"

    # Check blocked patterns
    for pattern in BLOCKED_PATTERNS:
        if pattern.search(command):
            logger.warning(f"🛡️ [Guardrail] Refused pattern in command: {command[:100]}")
            return "Command refused by the safety guardrail: contains a restricted pattern"

    return None


def sanitize_env(env: dict, agent_user: Optional[dict] = None) -> dict:
    """
    Filter environment variables down to an allowlist before handing them to an
    agent subprocess. Unlike `validate_command()` this is a real control: what is
    not in the allowlist is not in the child's `environ` at all, so runner
    secrets cannot be read back by anything the agent spawns — including through
    the interactive PTY, which the command guardrail never sees.
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
