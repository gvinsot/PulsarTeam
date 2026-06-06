"""
Aider backend — wraps the aider CLI (https://aider.chat).

Real CLI surface:
  aider                                  # interactive TUI
  aider --model <model>                  # pick the model (litellm spec)
  aider --message "<prompt>"             # one-shot non-interactive, then exit
  aider --yes-always                     # auto-confirm every prompt
  aider --no-stream                      # disable streaming (cleaner output)
  aider --no-pretty                      # plain output (no colours/markdown)
  aider --read <file>                    # load a read-only context file
  aider --no-check-update                # never phone home for updates
  aider --no-show-release-notes          # skip the release-notes prompt

Aider is built on litellm, so models use the litellm `<provider>/<model>`
namespace (e.g. `anthropic/claude-3-5-sonnet`, `openai/gpt-4o`,
`gemini/gemini-1.5-pro`, `ollama/llama3`). OpenAI-compatible / self-hosted
endpoints (vLLM, LM Studio, gateways) use the `openai/<model>` prefix together
with the OPENAI_API_BASE env var injected by CliBackend._agent_env.

Per-agent LLM selection:
  When the API forwards an X-LLM-Config header (cached via
  set_agent_llm_config), the agent-selected provider/model are passed to the
  aider CLI as `--model <provider>/<model>`. The matching API key env var
  (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ...) is injected by
  CliBackend._agent_env. When no per-agent LLM config is attached we pass no
  `--model` so aider falls back to its own default selection.

  Local-model injection: aider drives a single `--model` per spawn against one
  OPENAI_API_BASE, so — unlike opencode — there is no in-terminal switch across
  multiple local vLLM/Ollama models. The Settings-selected local model is the
  default and its endpoint/key are injected by _agent_env; multi-model config
  injection (see runner_local_models + opencode) does not apply to this CLI.
"""

import os
from typing import Optional

from config import logger
from agent_user import ensure_agent_user, _agent_users
from .cli_backend import CliBackend, OPENAI_COMPATIBLE_LOCAL_PROVIDERS
from .claude_token_store import get_subprocess_kwargs
from .runner_instructions_config import configure_aider_instructions


# Map our internal/canonical provider names to the litellm namespace aider
# expects on its --model flag. Anything not in this map is forwarded as-is.
_PROVIDER_TO_AIDER = {
    "anthropic": "anthropic",
    "claude": "anthropic",
    "claude-paid": "anthropic",
    "openai": "openai",
    "openrouter": "openrouter",
    "mistral": "mistral",
    "google": "gemini",
    "gemini": "gemini",
    "groq": "groq",
    "deepseek": "deepseek",
    "xai": "xai",
    "grok": "xai",
    "ollama": "ollama",
}

# Local / self-hosted OpenAI-compatible providers (vLLM, LM Studio, gateways)
# speak the OpenAI wire protocol. Route them through the `openai/` litellm
# prefix; the OPENAI_API_BASE / OPENAI_API_KEY env vars injected by
# CliBackend._agent_env point litellm at the local server.
for _p in OPENAI_COMPATIBLE_LOCAL_PROVIDERS:
    _PROVIDER_TO_AIDER.setdefault(_p, "openai")


def _resolve_aider_model(llm_config: Optional[dict]) -> str:
    """Compute the `--model` value aider should use.

    Return the per-agent LLM config when set (formatted as the litellm
    `<provider>/<model>` spec). An empty value deliberately leaves model
    selection to aider's own default.
    """
    if llm_config:
        model = (llm_config.get("model") or "").strip()
        provider = (llm_config.get("provider") or "").lower().strip()
        if model and "/" in model:
            return model  # caller already provided a provider-prefixed spec
        ns = _PROVIDER_TO_AIDER.get(provider, provider)
        if model and ns:
            return f"{ns}/{model}"
        if model:
            return model
    return ""


class AiderBackend(CliBackend):
    name = "aider"
    cli_command = "aider"
    pass_prompt_via_stdin = False  # aider takes the message via --message
    supports_interactive_terminal = True

    def _configure_instructions(self, agent_user: Optional[dict], agent_id: Optional[str]) -> None:
        # Writes the agent's base instructions into ~/.aider/AGENTS.md so we can
        # feed them to aider as a read-only context file (--read).
        configure_aider_instructions(agent_user, agent_id)

    def _instructions_read_path(self, agent_id: Optional[str]) -> Optional[str]:
        """Return the path to the agent's managed instructions file when it
        exists, so it can be passed to aider via --read."""
        if not agent_id:
            return None
        home_user = _agent_users.get(agent_id)
        home_dir = (home_user or {}).get("home")
        if not home_dir:
            return None
        path = os.path.join(home_dir, ".aider", "AGENTS.md")
        return path if os.path.exists(path) else None

    def _base_args(self, agent_id: Optional[str], permissions: Optional[dict]) -> list[str]:
        """Build the shared args used by both interactive and one-shot runs:
        model, auto-confirm, isolation, and the instructions context file."""
        llm_config = self._get_llm_config(agent_id)
        model = _resolve_aider_model(llm_config)

        args: list[str] = []
        if model:
            args += ["--model", model]
        # Never block the spawn on interactive update / release-note prompts.
        args += ["--no-check-update", "--no-show-release-notes"]

        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            args.append("--yes-always")

        read_path = self._instructions_read_path(agent_id)
        if read_path:
            args += ["--read", read_path]

        if agent_id:
            logger.debug(
                f"[Aider] agent={agent_id[:12]} model={model or '-'} "
                f"llm_config_present={llm_config is not None}"
            )
        return args

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn aider in its interactive TUI for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        permissions = self._get_permissions(agent_id)
        self._configure_instructions(effective_user, agent_id)

        cmd = [self.cli_command] + self._base_args(agent_id, permissions)

        env = self._agent_env(effective_user, agent_id)
        model = _resolve_aider_model(self._get_llm_config(agent_id))
        self._verify_model_config(agent_id, model=model, env=env)

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        self._configure_instructions(None, agent_id)
        cmd = [self.cli_command] + self._base_args(agent_id, permissions)
        # Plain, non-streaming output is easiest to capture in headless mode.
        cmd += ["--no-stream", "--no-pretty"]
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. aider exits after answering a single --message.
        cmd += ["--message", prompt]
        return cmd
