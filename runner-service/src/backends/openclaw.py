"""
OpenClaw backend — wraps the openclaw CLI (https://openclaw.ai).

Real CLI surface:
  openclaw tui [flags]                 # interactive terminal UI
  openclaw chat                         # alias for `openclaw tui --local`
  openclaw terminal                     # alias for `openclaw tui --local`
  openclaw agent --message "..." [flags]
    --json              # JSON output (suitable for piping)
    --plain             # disable styling
    --local             # embedded execution (no Gateway)
    --agent <name>      # select named agent
    --to <recipient>    # delivery target (phone/channel)
    --deliver           # send to default channel
    --reply-channel     # reply destination
    --verbose on|off

Note: prompt is passed via --message, not stdin.
The --local flag is recommended when running inside a container without
the OpenClaw gateway.
"""

import os

from agent_user import ensure_agent_user
from .cli_backend import CliBackend
from .claude_token_store import get_subprocess_kwargs
from .runner_mcp_config import configure_openclaw_mcp


OPENCLAW_AGENT = os.getenv("OPENCLAW_AGENT", "default")
OPENCLAW_LOCAL = os.getenv("OPENCLAW_LOCAL", "true").lower() in ("true", "1", "yes")


class OpenClawBackend(CliBackend):
    name = "openclaw"
    cli_command = "openclaw"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    def _configure_mcp(self, agent_user, agent_id) -> None:
        # Writes mcp.servers into ~/.openclaw/openclaw.json (schema verified
        # against openclaw 2026.5.27) — see configure_openclaw_mcp.
        configure_openclaw_mcp(agent_user, agent_id)

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn OpenClaw's TUI for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        self._configure_mcp(effective_user, agent_id)

        cmd = [self.cli_command, "tui"]
        if OPENCLAW_LOCAL:
            cmd.append("--local")
        if OPENCLAW_AGENT and OPENCLAW_AGENT != "default":
            cmd += ["--session", f"agent:{OPENCLAW_AGENT}:main"]

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": self._agent_env(effective_user),
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "agent"]
        cmd += ["--message", prompt]
        cmd += ["--json"]
        if OPENCLAW_LOCAL:
            cmd.append("--local")
        if OPENCLAW_AGENT and OPENCLAW_AGENT != "default":
            cmd += ["--agent", OPENCLAW_AGENT]
        return cmd

    def _parse_sync_result(self, stdout: str) -> dict:
        # OpenClaw --json emits a single JSON object per invocation.
        # Common shape: {"text": "...", "messages": [...], "model": "...", ...}
        # Falls back to defaults if the schema differs.
        import json
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError:
            return {"status": "success", "output": stdout}
        # Try common keys
        output_text = (
            parsed.get("text")
            or parsed.get("reply")
            or parsed.get("output")
            or parsed.get("result")
            or stdout
        )
        usage = parsed.get("usage", {}) or {}
        return {
            "status": "success",
            "output": output_text,
            "cost_usd": parsed.get("cost_usd"),
            "duration_ms": parsed.get("duration_ms"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "total_tokens": usage.get("total_tokens"),
        }
