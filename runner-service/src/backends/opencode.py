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
  "<provider>/<model>" so opencode picks the right vendor. The provider
  config (apiKey, baseURL) is written to the agent's opencode config
  file (~/.config/opencode/config.json) — no env vars are used for LLM
  auth so there is no risk of env-var / SDK conflicts. When no per-agent
  LLM config is set, no model override is passed so OpenCode can use its
  own default model selection.
"""

from typing import Optional
import json
import logging
import os

from agent_user import ensure_agent_user, _agent_users
from .cli_backend import CliBackend
from .claude_token_store import get_subprocess_kwargs

logger = logging.getLogger("runner_service")


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

    Return the per-agent LLM config when set (formatted as
    `<provider>/<model>`). An empty value deliberately leaves model
    selection to OpenCode.
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
    return ""


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


def _merge_opencode_config(
    existing_raw: Optional[str],
    managed: Optional[dict],
    clear_model: bool = False,
) -> Optional[str]:
    if not managed and not clear_model:
        return existing_raw
    try:
        existing = json.loads(existing_raw) if existing_raw else {}
        if not isinstance(existing, dict):
            existing = {}
    except (TypeError, json.JSONDecodeError):
        existing = {}

    if clear_model and not managed and "model" not in existing:
        return existing_raw

    merged = {**existing}
    if managed:
        merged["$schema"] = managed.get("$schema", existing.get("$schema"))
    if clear_model:
        merged.pop("model", None)
    elif managed and managed.get("model"):
        merged["model"] = managed["model"]
    providers = existing.get("provider") if isinstance(existing.get("provider"), dict) else {}
    merged_providers = {**providers}
    for provider_id, block in ((managed or {}).get("provider") or {}).items():
        previous = merged_providers.get(provider_id) if isinstance(merged_providers.get(provider_id), dict) else {}
        previous_models = previous.get("models") if isinstance(previous.get("models"), dict) else {}
        block_models = block.get("models") if isinstance(block.get("models"), dict) else {}
        merged_block = {**previous, **block}
        merged_block["models"] = {**previous_models, **block_models}
        merged_providers[provider_id] = merged_block
    if managed:
        merged["provider"] = merged_providers
    return json.dumps(merged, separators=(",", ":"))


def _write_opencode_config_file(
    home_dir: str,
    config_json: str,
    uid: Optional[int],
    gid: Optional[int],
) -> None:
    """Write the provider config to ~/.config/opencode/config.json.

    Opencode reads its configuration exclusively from this file (XDG path).
    We merge the managed provider block on top of any existing content so
    that user-level settings (MCP servers, keybindings, …) are preserved.
    File and parent directories are chowned to the agent's UID/GID so the
    opencode process (running as that user) can read it.
    """
    config_dir = os.path.join(home_dir, ".config", "opencode")
    config_path = os.path.join(config_dir, "config.json")
    try:
        os.makedirs(config_dir, exist_ok=True)
        with open(config_path, "w") as f:
            f.write(config_json)
        if uid is not None and gid is not None:
            # Ensure the agent process (non-root UID) can read the file.
            for path in (os.path.join(home_dir, ".config"), config_dir, config_path):
                try:
                    os.chown(path, uid, gid)
                except OSError:
                    pass
    except Exception as exc:
        logger.warning(f"[OpenCode] Could not write config to {config_path}: {exc}")


class OpenCodeBackend(CliBackend):
    name = "opencode"
    cli_command = "opencode"
    pass_prompt_via_stdin = False  # opencode takes the message as positional arg
    supports_interactive_terminal = True

    def _agent_env(self, agent_user: Optional[dict], agent_id: Optional[str] = None) -> dict:
        # Skip LLM env-var injection (agent_id=None) — all provider config is
        # delivered via the config file written below, not via env vars.
        env = super()._agent_env(agent_user, None)
        llm_config = self._get_llm_config(agent_id)
        model = _resolve_opencode_model(llm_config)
        managed = _opencode_provider_config(llm_config, model)
        # Always resolve the agent's HOME from the cache, even when running as
        # root (effective_user=None from linuxUser.runAsRoot). Without this the
        # provider config file is never written and opencode receives only
        # `--model vllm/...` with no endpoint/apiKey, so the connection fails.
        home_user = agent_user
        if (not home_user or not home_user.get("home")) and agent_id:
            home_user = _agent_users.get(agent_id)
        if not (home_user and home_user.get("home")):
            logger.warning(
                "[OpenCode] No HOME available for agent %s — skipping provider config write",
                (agent_id or "unknown")[:12],
            )
            return env
        home_dir = home_user["home"]
        cfg_path = os.path.join(home_dir, ".config", "opencode", "config.json")
        # Merge on top of any existing config file content so we don't clobber
        # MCP server definitions or other user-level opencode settings.
        existing_json: Optional[str] = None
        try:
            with open(cfg_path) as _f:
                existing_json = _f.read()
        except OSError:
            pass
        # Returning to "Default LLM" must also remove any model pin written by
        # an earlier explicit selection. Otherwise OpenCode reads the stale
        # config-level model even though the command no longer passes --model.
        merged = _merge_opencode_config(existing_json, managed, clear_model=not model)
        if merged and merged != existing_json:
            # When the spawn keeps its parent UID (root via runAsRoot), don't
            # chown the file to the agent UID — root needs to read it back,
            # and chown after creation could lock it away from the real spawn.
            uid = agent_user.get("uid") if agent_user else None
            gid = agent_user.get("gid") if agent_user else None
            _write_opencode_config_file(home_dir, merged, uid, gid)
            logger.info(
                "[OpenCode] Wrote config for agent %s at %s (model=%s)",
                (agent_id or "unknown")[:12], cfg_path, model or "<default>",
            )
        # opencode reads its config from $HOME/.config/opencode/config.json.
        # Force HOME to the agent's home so root-spawns find the file we just
        # wrote (sanitize_env only sets HOME when agent_user is provided).
        env["HOME"] = home_dir
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

        endpoint = (llm_config or {}).get("endpoint") if llm_config else None
        logger.info(
            "[OpenCode] prepare_interactive agent=%s model=%s endpoint=%s",
            (agent_id or "unknown")[:12], model or "<none>", endpoint or "<none>",
        )

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
