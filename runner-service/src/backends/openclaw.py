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

Local-model injection: OpenClaw's surface has no --model flag and carries the
model through a single env var (see _model_env), so — unlike opencode — there
is no in-terminal switch across multiple local vLLM/Ollama models. The
Settings-selected local model is the default and its endpoint/key are injected
by _agent_env; multi-model config injection (see runner_local_models + opencode)
does not apply to this CLI.
"""

import os
from typing import Optional

from agent_user import ensure_agent_user
from .cli_backend import CliBackend, OPENAI_COMPATIBLE_LOCAL_PROVIDERS
from .claude_token_store import get_subprocess_kwargs
from .runner_mcp_config import configure_openclaw_mcp
from .runner_instructions_config import configure_openclaw_instructions


OPENCLAW_AGENT = os.getenv("OPENCLAW_AGENT", "default")
OPENCLAW_LOCAL = os.getenv("OPENCLAW_LOCAL", "true").lower() in ("true", "1", "yes")


def _resolve_openclaw_model(llm_config: Optional[dict]) -> str:
    """Compute the model id OpenClaw should run with.

    Prefers the per-agent LLM config. An empty result leaves OpenClaw on its
    own built-in default model.
    """
    if llm_config:
        model = (llm_config.get("model") or "").strip()
        if model:
            return model
    return ""


class OpenClawBackend(CliBackend):
    name = "openclaw"
    cli_command = "openclaw"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    def _configure_mcp(self, agent_user, agent_id) -> None:
        # Writes mcp.servers into ~/.openclaw/openclaw.json (schema verified
        # against openclaw 2026.5.27) — see configure_openclaw_mcp.
        configure_openclaw_mcp(agent_user, agent_id)

    def _configure_instructions(self, agent_user, agent_id) -> None:
        # Writes the agent's base instructions into ~/.openclaw/AGENTS.md
        # (best-guess path — see configure_openclaw_instructions).
        configure_openclaw_instructions(agent_user, agent_id)

    def _model_env(self, agent_id: Optional[str], env: dict) -> dict:
        """Augment the spawn env with the selected model.

        Unlike opencode/hermes/codex, the OpenClaw CLI surface has no
        `--model` flag, so the model is wired through env vars. We set the
        common OpenAI-compatible model env names OpenClaw's underlying SDK
        reads; the provider key + base URL are already injected by the base
        `_agent_env` (which we now call WITH agent_id). For local/openai-
        compatible providers this is what makes the selected local model
        actually take effect at startup.
        """
        llm = self._get_llm_config(agent_id)
        model = _resolve_openclaw_model(llm)
        if not model:
            return env
        provider = (llm or {}).get("provider", "")
        provider = (provider or "").lower().strip()
        # Generic + OpenAI-compatible model hints. setdefault so an explicit
        # operator-provided env var always wins.
        env.setdefault("OPENCLAW_MODEL", model)
        if provider == "openai" or provider in OPENAI_COMPATIBLE_LOCAL_PROVIDERS:
            env.setdefault("OPENAI_MODEL", model)
        return env

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn OpenClaw's TUI for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        self._configure_mcp(effective_user, agent_id)
        self._configure_instructions(effective_user, agent_id)

        cmd = [self.cli_command, "tui"]
        if OPENCLAW_LOCAL:
            cmd.append("--local")
        if OPENCLAW_AGENT and OPENCLAW_AGENT != "default":
            cmd += ["--session", f"agent:{OPENCLAW_AGENT}:main"]

        # Pass agent_id so the selected model's provider credentials + endpoint
        # are injected (previously omitted, so local/custom models silently fell
        # back to OpenClaw's built-in default with no auth/endpoint). The
        # overridden `_agent_env` also layers the model env on top.
        env = self._agent_env(effective_user, agent_id)
        model = _resolve_openclaw_model(self._get_llm_config(agent_id))
        self._verify_model_config(agent_id, model=model, env=env)

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _agent_env(self, agent_user, agent_id=None) -> dict:
        # Layer the model env on top of the base provider/credential env so the
        # headless (`agent --message`) path also carries the selected model.
        env = super()._agent_env(agent_user, agent_id)
        return self._model_env(agent_id, env)


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
