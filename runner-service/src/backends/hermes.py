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
from .cli_backend import CliBackend


HERMES_PROVIDER = os.getenv("HERMES_PROVIDER")  # e.g. "openrouter", "anthropic"


class HermesBackend(CliBackend):
    name = "hermes"
    cli_command = "hermes"
    pass_prompt_via_stdin = False

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "chat", "--quiet"]
        if HERMES_PROVIDER:
            cmd += ["--provider", HERMES_PROVIDER]
        cmd += ["--model", RUNNER_MODEL]
        # Skip permissions
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            cmd.append("--yolo")
        # Session resume keyed by (agent_id, task_id)
        if agent_id:
            session_key = f"{agent_id}:{task_id}" if task_id else agent_id
            session_id = self._sessions.get(session_key)
            if session_id:
                cmd += ["--resume", session_id]
        cmd += ["-q", prompt]
        return cmd
