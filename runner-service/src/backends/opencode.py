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
import json

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
    "openrouter": "openrouter",
    "mistral": "mistral",
    "google": "google",
    "gemini": "google",
    "groq": "groq",
    "ollama": "ollama",
    "deepseek": "deepseek",
    "xai": "xai",
    "grok": "xai",
    "nvidia": "nvidia",
    "huggingface": "huggingface",
    "vllm": "vllm",  # configured as an OpenAI-compatible custom provider
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
    fallback = (RUNNER_MODEL or "").strip()
    if fallback and "/" not in fallback:
        return f"anthropic/{fallback}"
    return fallback


def _split_model_spec(model_spec: str) -> tuple[Optional[str], Optional[str]]:
    if not model_spec or "/" not in model_spec:
        return None, None
    provider_id, model_id = model_spec.split("/", 1)
    provider_id = provider_id.strip()
    model_id = model_id.strip()
    if not provider_id or not model_id:
        return None, None
    return provider_id, model_id


def _opencode_provider_config(llm_config: Optional[dict], model_spec: str) -> Optional[dict]:
    """Declare the selected model so OpenCode accepts custom/uncached IDs.

    OpenCode validates `--model` against configured providers/models. The API
    can point an agent at arbitrary OpenAI-compatible endpoints (vLLM, local
    gateways, proxies), so we feed an ephemeral config through
    OPENCODE_CONFIG_CONTENT instead of relying on the global models cache.
    """
    provider_id, model_id = _split_model_spec(model_spec)
    if not provider_id or not model_id:
        return None

    cfg = llm_config or {}
    raw_provider = (cfg.get("provider") or "").lower().strip()
    endpoint = (cfg.get("endpoint") or "").strip()
    api_key = (cfg.get("apiKey") or cfg.get("api_key") or "").strip()

    block: dict = {
        "models": {
            model_id: {
                "name": model_id,
            },
        },
    }
    options: dict = {}
    if endpoint:
        # Normalise the endpoint the same way VLLMProvider (TypeScript) does:
        # strip trailing slashes, then ensure the path ends with /v1 so that
        # @ai-sdk/openai-compatible resolves /chat/completions correctly.
        base = endpoint.rstrip("/")
        if not base.endswith("/v1"):
            base = f"{base}/v1"
        options["baseURL"] = base
    if api_key:
        options["apiKey"] = api_key
    if options:
        block["options"] = options

    if raw_provider in ("vllm", "openai-compatible", "lmstudio") or (
        endpoint and provider_id not in _PROVIDER_TO_OPENCODE_NAMESPACE.values()
    ):
        block["npm"] = "@ai-sdk/openai-compatible"
        block["name"] = raw_provider or provider_id

    return {
        "$schema": "https://opencode.ai/config.json",
        "model": model_spec,
        "provider": {
            provider_id: block,
        },
    }


def _merge_opencode_config(existing_raw: Optional[str], managed: Optional[dict]) -> Optional[str]:
    if not managed:
        return existing_raw
    try:
        existing = json.loads(existing_raw) if existing_raw else {}
        if not isinstance(existing, dict):
            existing = {}
    except (TypeError, json.JSONDecodeError):
        existing = {}

    merged = {**existing, "$schema": managed.get("$schema", existing.get("$schema"))}
    if managed.get("model"):
        merged["model"] = managed["model"]
    providers = existing.get("provider") if isinstance(existing.get("provider"), dict) else {}
    merged_providers = {**providers}
    for provider_id, block in (managed.get("provider") or {}).items():
        previous = merged_providers.get(provider_id) if isinstance(merged_providers.get(provider_id), dict) else {}
        previous_models = previous.get("models") if isinstance(previous.get("models"), dict) else {}
        block_models = block.get("models") if isinstance(block.get("models"), dict) else {}
        merged_block = {**previous, **block}
        merged_block["models"] = {**previous_models, **block_models}
        merged_providers[provider_id] = merged_block
    merged["provider"] = merged_providers
    return json.dumps(merged, separators=(",", ":"))


class OpenCodeBackend(CliBackend):
    name = "opencode"
    cli_command = "opencode"
    pass_prompt_via_stdin = False  # opencode takes the message as positional arg
    supports_interactive_terminal = True

    def _agent_env(self, agent_user: Optional[dict], agent_id: Optional[str] = None) -> dict:
        env = super()._agent_env(agent_user, agent_id)
        llm_config = self._get_llm_config(agent_id)
        model = _resolve_opencode_model(llm_config)
        managed = _opencode_provider_config(llm_config, model)
        merged = _merge_opencode_config(env.get("OPENCODE_CONFIG_CONTENT"), managed)
        if merged:
            env["OPENCODE_CONFIG_CONTENT"] = merged
        return env

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
