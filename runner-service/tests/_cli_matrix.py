"""Shared matrix of the interactive CLI backends for the cross-CLI tests.

`build_recipe()` runs a backend's `prepare_interactive()` with every real
provisioning side effect stubbed out — agent-user creation, the OAuth auth
gate, MCP / instruction config and credential seeding — so the tests can
inspect the launch *command* each runner hands to the PTY without touching the
network, the team-api DB or anything outside `tmp_path`.

This is NOT a test module (underscore-prefixed so pytest skips it); it is
imported by `test_cli_launch_recipes.py` and `test_cli_flag_compatibility.py`.

Why it exists: a Claude terminal that "ne charge plus correctement" turned out
to be the CLI starting in a bad launch state (unauthenticated / a flag the CLI
no longer accepts). The Dockerfile installs each CLI at `@latest`, so a rebuild
can silently change a backend's flags. These helpers pin the launch contract
for every runner in one place.
"""

import asyncio
import importlib
import os
import sys
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "claude-code")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from agent_user import _agent_users  # noqa: E402
import backends.cli_backend as cli_backend_module  # noqa: E402


# ── Backend matrix ──────────────────────────────────────────────────────────
# For each interactive runner:
#   binary        — the executable the recipe must invoke (also used by the
#                   flag-compatibility test to probe `<binary> --help`).
#   cmd_prefix    — the leading argv tokens (binary + any subcommand).
#   required_flags— flags the recipe MUST always emit, regardless of the
#                   selected model. Dropping one is the regression these tests
#                   exist to catch.
#   danger_flag   — the "don't prompt / bypass approvals" flag the CLI must
#                   still advertise. May be conditionally absent from a given
#                   recipe (e.g. Claude drops it when it would run as root), so
#                   the flag-compat test checks it against the CLI's own help
#                   rather than the recipe. None when the runner expresses the
#                   bypass via config/env instead of a flag (opencode).
CLIS = [
    {
        "name": "claude-code",
        "binary": "claude",
        "cmd_prefix": ["claude"],
        "required_flags": ["--model", "--effort"],
        "danger_flag": "--dangerously-skip-permissions",
    },
    {
        "name": "codex",
        "binary": "codex",
        "cmd_prefix": ["codex"],
        "required_flags": ["--dangerously-bypass-approvals-and-sandbox"],
        "danger_flag": "--dangerously-bypass-approvals-and-sandbox",
    },
    {
        "name": "opencode",
        "binary": "opencode",
        "cmd_prefix": ["opencode"],
        "required_flags": ["--model"],
        "danger_flag": None,  # bypass is written into opencode's config, not a flag
    },
    {
        "name": "openclaw",
        "binary": "openclaw",
        "cmd_prefix": ["openclaw", "tui"],
        "required_flags": ["--local"],
        "danger_flag": None,
    },
    {
        "name": "hermes",
        "binary": "hermes",
        "cmd_prefix": ["hermes", "chat"],
        "required_flags": ["--yolo"],
        "danger_flag": "--yolo",
    },
    {
        "name": "aider",
        "binary": "aider",
        "cmd_prefix": ["aider"],
        "required_flags": ["--model", "--yes-always"],
        "danger_flag": "--yes-always",
    },
]

# Per-name backend module / class and an optional LLM config so model-dependent
# flags (`--model …`) are present in the recipe.
_BACKENDS = {
    "claude-code": ("backends.claude_code", "ClaudeCodeBackend", None),
    "codex": ("backends.codex", "CodexBackend", None),
    "opencode": ("backends.opencode", "OpenCodeBackend", {"provider": "vllm", "model": "qwen"}),
    "openclaw": ("backends.openclaw", "OpenClawBackend", None),
    "hermes": ("backends.hermes", "HermesBackend", None),
    "aider": ("backends.aider", "AiderBackend", {"provider": "openai", "model": "gpt-4o"}),
}


def _noop_configure(agent_user, agent_id):
    return None


async def _no_agent_user(agent_id, owner_id=None):
    return None


def build_recipe(name, tmp_path, monkeypatch, uid=None):
    """Return the `prepare_interactive` recipe for backend `name`.

    `uid` controls the per-agent UID the CLI subprocess would drop to: `None`
    means runAsRoot (the parent's UID). Claude's launch command depends on this
    (it drops `--dangerously-skip-permissions` when it would run as root), so
    the Claude-specific tests pass a non-root UID explicitly.
    """
    mod_name, cls_name, llm = _BACKENDS[name]
    module = importlib.import_module(mod_name)
    agent_id = f"agent-{name}"
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": uid, "gid": uid}
    try:
        if name == "claude-code":
            agent_user = {
                "username": "agent_claude",
                "owner_id": "owner-1",
                "home": str(tmp_path),
                "uid": uid,
                "gid": uid,
            }

            async def _user(aid, owner_id=None):
                return agent_user

            async def _gate(user, aid):
                return None

            monkeypatch.setattr(module, "ensure_agent_user", _user)
            monkeypatch.setattr(module, "configure_claude_mcp", _noop_configure)
            monkeypatch.setattr(module, "configure_claude_instructions", _noop_configure)
            monkeypatch.setattr(module, "seed_credentials_file", lambda _user: True)
            backend = getattr(module, cls_name)()
            monkeypatch.setattr(backend, "_ensure_auth", _gate)
            return asyncio.run(backend.prepare_interactive(agent_id, owner_id="owner-1"))

        # cli_backend-based runners: ensure_agent_user → None (runAsRoot), HOME
        # is taken from the _agent_users cache, MCP/instruction writers stubbed.
        for mod in {module, cli_backend_module}:
            if hasattr(mod, "ensure_agent_user"):
                monkeypatch.setattr(mod, "ensure_agent_user", _no_agent_user)
        backend = getattr(module, cls_name)()
        backend._configure_mcp = _noop_configure
        backend._configure_instructions = _noop_configure
        if llm is not None:
            backend.set_agent_llm_config(agent_id, llm)
        return asyncio.run(backend.prepare_interactive(agent_id))
    finally:
        _agent_users.pop(agent_id, None)


def emitted_long_flags(cmd):
    """The distinct `--long` option names the recipe passes to the CLI
    (`--flag=value` reduced to `--flag`)."""
    flags = []
    for tok in cmd:
        if isinstance(tok, str) and tok.startswith("--") and len(tok) > 2:
            flag = tok.split("=", 1)[0]
            if flag not in flags:
                flags.append(flag)
    return flags
