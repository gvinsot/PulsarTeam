"""
Hermes backend — wraps the hermes CLI (https://github.com/NousResearch/hermes-agent).

Real CLI surface:
  hermes chat -q "<prompt>"            # one-shot non-interactive
  hermes chat --quiet -q "..."         # programmatic mode (no banners/spinners)
  hermes chat -m <model> -q "..."      # override model for one run
  hermes chat --provider <p> --model <m> -q "..."
  hermes chat --resume <session-id>
  hermes chat --continue [name]
  hermes chat --yolo -q "..."          # skip permission prompts
"""

import os

from config import RUNNER_MODEL
from agent_user import ensure_agent_user
from .cli_backend import CliBackend
from .claude_token_store import get_subprocess_kwargs


HERMES_PROVIDER = os.getenv("HERMES_PROVIDER")  # e.g. "openrouter", "anthropic"


class HermesBackend(CliBackend):
    name = "hermes"
    cli_command = "hermes"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn Hermes in its interactive chat mode for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        permissions = self._get_permissions(agent_id)
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}

        cmd = [self.cli_command, "chat"]
        if HERMES_PROVIDER:
            cmd += ["--provider", HERMES_PROVIDER]
        cmd += ["--model", RUNNER_MODEL]
        if exec_perms.get("dangerousSkipPermissions", True):
            cmd.append("--yolo")

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": self._agent_env(effective_user),
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "chat", "--quiet"]
        if HERMES_PROVIDER:
            cmd += ["--provider", HERMES_PROVIDER]
        cmd += ["--model", RUNNER_MODEL]
        # Skip permissions
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            cmd.append("--yolo")
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. The hermes CLI's --resume is not used.
        cmd += ["-q", prompt]
        return cmd
