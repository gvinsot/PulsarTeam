"""
OpenCode backend — wraps the opencode CLI (https://opencode.ai).

Real CLI surface:
  opencode run [message...]
    --model, -m <provider/model>
    --agent <name>
    --continue, -c          # resume last session
    --session, -s <id>      # continue a specific session id
    --fork                  # branch off when continuing
    --format default|json   # output format
    --file, -f              # attach file
    --share                 # share resulting session
    --dangerously-skip-permissions

Note: opencode passes the message as a positional argument, not via stdin.
"""

from typing import Optional

from config import RUNNER_MODEL
from agent_user import ensure_agent_user
from .cli_backend import CliBackend
from .claude_token_store import get_subprocess_kwargs


class OpenCodeBackend(CliBackend):
    name = "opencode"
    cli_command = "opencode"
    pass_prompt_via_stdin = False  # opencode takes the message as positional arg
    supports_interactive_terminal = True

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn OpenCode in its interactive TUI for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)

        cmd = [self.cli_command]
        if RUNNER_MODEL:
            cmd += ["--model", RUNNER_MODEL]

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": self._agent_env(effective_user),
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "run"]
        cmd += ["--model", RUNNER_MODEL]
        cmd += ["--format", "json"]  # opencode has no separate stream-json — JSON events on stdout
        # Permissions: default to skip if backend is configured for headless ops
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            cmd.append("--dangerously-skip-permissions")
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. The opencode CLI's --session is not used.
        cmd.append(prompt)
        return cmd
