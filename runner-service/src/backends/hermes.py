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
  hermes chat --ignore-user-config     # ignore ~/.hermes/config.yaml

Per-agent LLM selection:
  When the API forwards an X-LLM-Config header (cached via
  set_agent_llm_config), the agent-selected provider/model are passed to
  the hermes CLI as `--provider <p> --model <m>`. The matching API key env
  var (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY / ...) is
  injected by CliBackend._agent_env. When no per-agent LLM config is
  attached, we fall back to the HERMES_PROVIDER env / RUNNER_MODEL env.

  We also pass --ignore-user-config so the agent's run is fully driven by
  the LLM config we forward, not by a stale ~/.hermes/config.yaml that may
  pin a different provider/model.
"""

import os
from typing import Optional, Tuple

from config import RUNNER_MODEL, logger
from agent_user import ensure_agent_user
from .cli_backend import CliBackend, OPENAI_COMPATIBLE_LOCAL_PROVIDERS
from .claude_token_store import get_subprocess_kwargs
from .runner_mcp_config import configure_hermes_mcp, configure_hermes_local_providers
from .runner_instructions_config import configure_hermes_instructions


HERMES_PROVIDER = os.getenv("HERMES_PROVIDER")  # e.g. "openrouter", "anthropic"


# Map our internal/canonical provider names to the value the hermes CLI
# expects on its --provider flag. Anything not in this map is forwarded
# as-is (hermes supports many providers — see its `--provider` docs).
_PROVIDER_TO_HERMES = {
    "anthropic": "anthropic",
    "claude": "anthropic",
    "claude-paid": "anthropic",
    "openrouter": "openrouter",
    "google": "gemini",
    "gemini": "gemini",
    "xai": "xai",
    "grok": "xai",
    "deepseek": "deepseek",
    "huggingface": "huggingface",
    "bedrock": "bedrock",
    "azure": "azure-foundry",
    "ollama": "ollama-cloud",
    "nvidia": "nvidia",
    # No direct hermes "openai" provider — falling back to "auto" lets
    # hermes infer the right one from the model name.
    "openai": "auto",
    "mistral": "auto",
    "groq": "auto",
}

# Local / self-hosted OpenAI-compatible providers (vLLM, LM Studio, gateways)
# have no dedicated hermes provider. We route them through "auto" so hermes
# uses its OpenAI-compatible client driven by the OPENAI_BASE_URL / OPENAI_API_KEY
# env vars that CliBackend._agent_env now injects for these providers.
for _p in OPENAI_COMPATIBLE_LOCAL_PROVIDERS:
    _PROVIDER_TO_HERMES.setdefault(_p, "auto")



def _resolve_hermes_provider_and_model(
    llm_config: Optional[dict],
) -> Tuple[Optional[str], str]:
    """Compute (provider, model) the hermes CLI should run with.

    Prefers the per-agent LLM config; falls back to HERMES_PROVIDER env
    and RUNNER_MODEL env when no agent-level config is set.
    """
    if llm_config:
        model = (llm_config.get("model") or "").strip()
        provider = (llm_config.get("provider") or "").lower().strip()
        mapped_provider = _PROVIDER_TO_HERMES.get(provider, provider) if provider else None
        return mapped_provider or HERMES_PROVIDER, model or RUNNER_MODEL
    return HERMES_PROVIDER, RUNNER_MODEL


class HermesBackend(CliBackend):
    name = "hermes"
    cli_command = "hermes"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    def _configure_mcp(self, agent_user, agent_id) -> None:
        # Writes mcp_servers into ~/.hermes/config.yaml and records whether any
        # MCP server is present so _common_chat_args can decide on
        # --ignore-user-config. A return of -1 means the fetch failed and the
        # existing config (and flag) are left untouched.
        n = configure_hermes_mcp(agent_user, agent_id)
        if agent_id and n >= 0:
            self._mcp_present[agent_id] = n > 0
        # Opt-in (HERMES_INJECT_LOCAL_PROVIDERS): make the operator's local
        # vLLM/Ollama models switchable inside the TUI. No-op by default; the
        # Settings-selected model is still the default via --provider/--model.
        configure_hermes_local_providers(agent_user, agent_id)

    def _configure_instructions(self, agent_user, agent_id) -> None:
        # Writes the agent's base instructions into ~/.hermes/AGENTS.md
        # (best-guess path — see configure_hermes_instructions).
        configure_hermes_instructions(agent_user, agent_id)

    def _common_chat_args(self, agent_id: Optional[str], permissions: Optional[dict]) -> list[str]:
        """Build the shared `chat`-mode args used by both interactive and
        one-shot invocations: provider, model, permission flags, isolation.
        """
        llm_config = self._get_llm_config(agent_id)
        provider, model = _resolve_hermes_provider_and_model(llm_config)

        args: list[str] = []
        # Normally ignore on-disk ~/.hermes/config.yaml so the agent's run is
        # fully driven by the LLM config we forward — not by stale defaults.
        # BUT hermes reads its MCP wiring from that same config.yaml, so when we
        # have MCP servers to inject we must NOT ignore it. The explicit
        # --provider/--model flags below still override any stale config pins.
        if not self._mcp_present.get(agent_id, False):
            args.append("--ignore-user-config")
        if provider:
            args += ["--provider", provider]
        if model:
            args += ["--model", model]

        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            args.append("--yolo")

        if agent_id:
            logger.debug(
                f"[Hermes] agent={agent_id[:12]} provider={provider or '-'} model={model or '-'} "
                f"llm_config_present={llm_config is not None}"
            )
        return args

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn Hermes in its interactive chat mode for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        permissions = self._get_permissions(agent_id)
        self._configure_mcp(effective_user, agent_id)
        self._configure_instructions(effective_user, agent_id)

        cmd = [self.cli_command, "chat"] + self._common_chat_args(agent_id, permissions)

        env = self._agent_env(effective_user, agent_id)
        _, model = _resolve_hermes_provider_and_model(self._get_llm_config(agent_id))
        self._verify_model_config(agent_id, model=model, env=env)

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "chat", "--quiet"] + self._common_chat_args(agent_id, permissions)
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. The hermes CLI's --resume is not used.
        cmd += ["-q", prompt]
        return cmd
