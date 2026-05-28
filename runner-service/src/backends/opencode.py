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

Per-agent LLM selection:
  When the API forwards an X-LLM-Config header (cached via
  set_agent_llm_config), this backend formats the model as
  "<provider>/<model>" so opencode picks the right vendor. The matching
  API key env var (ANTHROPIC_API_KEY / OPENAI_API_KEY / ...) is injected
  by CliBackend._agent_env. When no per-agent LLM config is set, the
  static RUNNER_MODEL env var is used as a fallback.
"""

from typing import Optional

from config import RUNNER_MODEL
from agent_user import ensure_agent_user
from .cli_backend import CliBackend
from .claude_token_store import get_subprocess_kwargs


# Map our internal provider names to the namespace opencode uses in its
# `provider/model` model spec. Anything not in this map is forwarded as-is.
_PROVIDER_TO_OPENCODE_NAMESPACE = {
    "anthropic": "anthropic",
    "claude": "anthropic",
    "claude-paid": "anthropic",
    "openai": "openai",
    "mistral": "mistral",
    "google": "google",
    "gemini": "google",
    "groq": "groq",
    "ollama": "ollama",
    "vllm": "openai",  # vLLM exposes an OpenAI-compatible API
}


def _resolve_opencode_model(llm_config: Optional[dict]) -> str:
    """Compute the `--model` value opencode should use.

    Prefers the per-agent LLM config when set (formatted as
    `<provider>/<model>`), falling back to the static RUNNER_MODEL env.
    """
    if llm_config:
        model = (llm_config.get("model") or "").strip()
        provider = (llm_config.get("provider") or "").lower().strip()
        if model and "/" in model:
            return model  # caller already provided a provider-prefixed spec
        ns = _PROVIDER_TO_OPENCODE_NAMESPACE.get(provider, provider)
        if model and ns:
            return f"{ns}/{model}"
        if model:
            return model
    return RUNNER_MODEL


class OpenCodeBackend(CliBackend):
    name = "opencode"
    cli_command = "opencode"
    pass_prompt_via_stdin = False  # opencode takes the message as positional arg
    supports_interactive_terminal = True

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn OpenCode in its interactive TUI for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)

        llm_config = self._get_llm_config(agent_id)
        model = _resolve_opencode_model(llm_config)

        cmd = [self.cli_command]
        if model:
            cmd += ["--model", model]

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": self._agent_env(effective_user, agent_id),
            "preexec_fn": kwargs.get("preexec_fn"),
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        llm_config = self._get_llm_config(agent_id)
        model = _resolve_opencode_model(llm_config)

        cmd = [self.cli_command, "run"]
        if model:
            cmd += ["--model", model]
        cmd += ["--format", "json"]  # opencode has no separate stream-json — JSON events on stdout
        # Permissions: default to skip if backend is configured for headless ops
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            cmd.append("--dangerously-skip-permissions")
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. The opencode CLI's --session is not used.
        cmd.append(prompt)
        return cmd
