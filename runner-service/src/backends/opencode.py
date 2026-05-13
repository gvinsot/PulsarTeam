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
from .cli_backend import CliBackend


class OpenCodeBackend(CliBackend):
    name = "opencode"
    cli_command = "opencode"
    pass_prompt_via_stdin = False  # opencode takes the message as positional arg

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
