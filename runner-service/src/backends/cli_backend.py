"""
Generic CLI backend — base class for runners driven by a CLI tool.

Subclasses configure:
  - cli_command: the executable name
  - pass_prompt_via_stdin: whether the prompt goes via stdin or as a CLI arg
  - _build_command(): full subprocess args (including prompt if not via stdin)
  - _parse_sync_result() / _parse_stream_event(): output format adapters
"""

import os
import json
import asyncio
import subprocess
from typing import AsyncIterator, Optional

from config import (
    RUNNER_MODEL, CLI_CWD, TIMEOUT, PROJECTS_DIR, VERBOSE, logger,
)
from agent_user import get_agent_project_dir, ensure_agent_user
from .base import RunnerBackend
from .claude_token_store import get_subprocess_kwargs, run_blocking
from .runner_llm_config import fetch_agent_llm_config
from usage_reporter import report_usage


# Most CLI agents (claude, opencode, codex, hermes, openclaw) render an initial
# splash / model-pick / permissions screen on cold start that they auto-dismiss
# after a beat. Piping the prompt immediately races those screens and can land
# the user's request *into* a dialog field. Sleep briefly after spawn so the CLI
# has time to settle on its real REPL prompt before we feed it input. Tunable via
# the CLI_PREP_DELAY_S env var (default 2.0 s, set to 0 to disable).
try:
    CLI_PREP_DELAY_S = float(os.environ.get("CLI_PREP_DELAY_S", "2.0"))
except ValueError:
    CLI_PREP_DELAY_S = 2.0


# Providers that speak the OpenAI-compatible wire protocol and are typically
# self-hosted / local (vLLM, LM Studio, generic OpenAI-compatible gateways).
# They authenticate via OPENAI_API_KEY and need an explicit OPENAI_BASE_URL
# pointing at the local server so the CLI's OpenAI SDK targets it instead of
# api.openai.com. Centralised here so every CLI backend resolves "local model"
# wiring the same way.
OPENAI_COMPATIBLE_LOCAL_PROVIDERS = (
    "vllm",
    "lmstudio",
    "lm-studio",
    "openai-compatible",
    "openai_compatible",
    "local",
    "custom",
    "litellm",
    "tgi",
    "text-generation-webui",
)


# Which env var(s) each provider's official SDK reads for its API key.
# opencode / openclaw / hermes pick these up automatically when no auth.json
# is present. The OpenAI-compatible local providers (vLLM, LM Studio,
# gateways) authenticate via OPENAI_API_KEY too; their spread comes FIRST so
# an explicit entry wins on any future name collision (matching the old
# elif-chain precedence).
_PROVIDER_KEY_ENV: dict[str, tuple[str, ...]] = {
    **{p: ("OPENAI_API_KEY",) for p in OPENAI_COMPATIBLE_LOCAL_PROVIDERS},
    "anthropic": ("ANTHROPIC_API_KEY",),
    "claude": ("ANTHROPIC_API_KEY",),
    "claude-paid": ("ANTHROPIC_API_KEY",),
    "openai": ("OPENAI_API_KEY",),
    "openrouter": ("OPENROUTER_API_KEY",),
    "mistral": ("MISTRAL_API_KEY",),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "gemini": ("GOOGLE_API_KEY", "GEMINI_API_KEY"),
    "groq": ("GROQ_API_KEY",),
    "deepseek": ("DEEPSEEK_API_KEY",),
    "xai": ("XAI_API_KEY",),
    "grok": ("XAI_API_KEY",),
    "nvidia": ("NVIDIA_API_KEY",),
    "huggingface": ("HF_TOKEN",),
    "ollama": ("OLLAMA_API_KEY",),
}


def resolve_model_spec(llm_config: Optional[dict], provider_map: Optional[dict] = None) -> str:
    """Compute the `--model` value a CLI should run with from the per-agent
    LLM config. An empty result deliberately leaves model selection to the
    CLI's own default (no stale pin fighting the CLI's evolving default).

    With a `provider_map` (opencode/aider), the internal provider name is
    translated to the CLI's namespace and the result is the prefixed
    `<provider>/<model>` spec. Without one (codex/openclaw), the bare model
    id is returned untouched — those CLIs take no provider prefix.
    """
    if not llm_config:
        return ""
    model = (llm_config.get("model") or "").strip()
    if provider_map is None:
        return model
    if model and "/" in model:
        return model  # caller already provided a provider-prefixed spec
    provider = (llm_config.get("provider") or "").lower().strip()
    ns = provider_map.get(provider, provider)
    if model and ns:
        return f"{ns}/{model}"
    return model


class CliBackend(RunnerBackend):
    """Base class for CLI-driven runners.

    Override `cli_command`, `pass_prompt_via_stdin`, and `_build_command`
    in subclasses. Optionally override `_parse_sync_result` /
    `_parse_stream_event` to adapt to the CLI's output format.
    """

    cli_command: str = ""
    pass_prompt_via_stdin: bool = True
    supports_agent: bool = True
    supports_oauth_login: bool = False
    supports_token_set: bool = True

    def __init__(self):
        self._permissions: dict[str, dict] = {}
        self._llm_configs: dict[str, dict] = {}
        # Per-agent flag set by _configure_mcp: True when the last reconcile
        # wrote ≥1 MCP server. Backends whose argv depends on MCP presence
        # (e.g. hermes' --ignore-user-config) read this.
        self._mcp_present: dict[str, bool] = {}

    # ── Hooks subclasses override ─────────────────────────────────────────

    def _build_command(
        self,
        prompt: str,
        stream: bool,
        system_prompt: Optional[str],
        agent_id: Optional[str],
        task_id: Optional[str],
        permissions: Optional[dict],
    ) -> list[str]:
        """Return the full subprocess args.

        If `pass_prompt_via_stdin` is True, the prompt should NOT be in
        the returned list — base class will pipe it via stdin.
        Otherwise the subclass is responsible for embedding the prompt
        as an argument (e.g. `--message <prompt>`).
        """
        raise NotImplementedError

    def _parse_sync_result(self, stdout: str) -> dict:
        """Parse the CLI's --json (or equivalent) output into a result dict.

        Default tries the Claude-code shape: {result, cost_usd, usage:{input_tokens,output_tokens}}.
        Falls back to raw stdout.
        """
        try:
            parsed = json.loads(stdout)
        except json.JSONDecodeError:
            return {"status": "success", "output": stdout}
        output_text = parsed.get("result") or parsed.get("output") or parsed.get("message") or stdout
        usage = parsed.get("usage", {}) or {}
        input_tokens = usage.get("input_tokens", 0) or 0
        output_tokens = usage.get("output_tokens", 0) or 0
        return {
            "status": "success",
            "output": output_text,
            "cost_usd": parsed.get("cost_usd"),
            "duration_ms": parsed.get("duration_ms"),
            "total_tokens": parsed.get("total_tokens") or (input_tokens + output_tokens),
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    def _parse_stream_event(self, line: str) -> Optional[dict]:
        """Parse a stream output line into a canonical event.

        Default assumes JSON-per-line in Claude-code's stream-json format.
        Returns None to skip the event. Returns a dict with "type" set to
        one of: text, thinking, status, result, error.
        """
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            # Preserve a line break so multi-line plain-text CLI output (banners,
            # error messages) is not collapsed into a single space-less blob
            # when chunks are concatenated by the OpenAI-stream consumer.
            return {"type": "text", "content": line + "\n"}

        event_type = event.get("type", "")
        if event_type == "assistant":
            content = event.get("message", {}).get("content", "")
            if isinstance(content, str) and content:
                return {"type": "text", "content": content}
            # List of blocks — return as-is so caller iterates
            if isinstance(content, list):
                return {"type": "_blocks", "blocks": content}
        elif event_type == "result":
            usage = event.get("usage", {}) or {}
            return {
                "type": "result",
                "content": event.get("result", "") or "",
                "cost_usd": event.get("cost_usd", 0),
                "duration_ms": event.get("duration_ms", 0),
                "total_tokens": event.get("total_tokens", 0) or (usage.get("input_tokens", 0) + usage.get("output_tokens", 0)),
                "input_tokens": usage.get("input_tokens", 0),
                "output_tokens": usage.get("output_tokens", 0),
            }
        elif event_type in ("text", "thinking", "status", "error"):
            return event
        return None

    def set_agent_permissions(self, agent_id: str, permissions: dict) -> None:
        if agent_id and permissions:
            self._permissions[agent_id] = permissions

    def _get_permissions(self, agent_id: Optional[str]) -> Optional[dict]:
        return self._permissions.get(agent_id) if agent_id else None

    def set_agent_llm_config(self, agent_id: str, llm_config: Optional[dict]) -> None:
        if not agent_id:
            return
        if llm_config:
            self._llm_configs[agent_id] = llm_config
        else:
            self._llm_configs.pop(agent_id, None)

    def _get_llm_config(self, agent_id: Optional[str]) -> Optional[dict]:
        if not agent_id:
            return None
        cfg = self._llm_configs.get(agent_id)
        if cfg is not None:
            return cfg
        # Cache miss: the in-memory config set from the X-LLM-Config header was
        # wiped by a runner restart, or this session spawned before any header
        # arrived (e.g. a tmux terminal reattach). Re-hydrate from team-api so
        # the agent's selected model survives restarts instead of silently
        # falling back to RUNNER_MODEL. A later header still wins, since
        # set_agent_llm_config overwrites this entry.
        hydrated = fetch_agent_llm_config(agent_id)
        if hydrated:
            self._llm_configs[agent_id] = hydrated
        return hydrated

    def _resolve_effective_user(
        self, agent_id: Optional[str], agent_user: Optional[dict],
    ) -> Optional[dict]:
        """Honor the linuxUser.runAsRoot toggle.

        When the toggle is on, return None so the spawn inherits the parent
        process UID (root in our deployment). When off (default), keep the
        dedicated per-agent UID resolved by ensure_agent_user.
        """
        perms = self._get_permissions(agent_id) or {}
        run_as_root = bool((perms.get("linuxUser") or {}).get("runAsRoot", False))
        if run_as_root:
            if agent_user:
                logger.info(
                    f"[Agent {agent_id[:12] if agent_id else 'unknown'}] "
                    "linuxUser.runAsRoot=true — spawning as root (UID drop disabled)"
                )
            return None
        return agent_user

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        logger.info(f"{self.name} backend starting...")
        logger.info(f"  CLI: {self.cli_command}")
        logger.info(f"  Model: {RUNNER_MODEL}")
        logger.info(f"  Timeout: {TIMEOUT}s")
        try:
            result = subprocess.run([self.cli_command, "--version"], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                logger.info(f"  {self.cli_command} version: {result.stdout.strip()}")
            else:
                logger.error(f"  {self.cli_command} error: {result.stderr.strip()}")
        except FileNotFoundError:
            logger.error(f"  {self.cli_command} not found on PATH")
        except Exception as e:
            logger.error(f"  {self.cli_command} version check failed: {e}")

    def health(self) -> dict:
        try:
            result = subprocess.run([self.cli_command, "--version"], capture_output=True, text=True, timeout=10)
            ok = result.returncode == 0
            version = result.stdout.strip() if ok else None
        except Exception:
            ok = False
            version = None
        return {
            "status": "healthy" if ok else "degraded",
            "backend": self.name,
            "cli": self.cli_command,
            "cli_version": version,
            "model": RUNNER_MODEL,
        }

    # ── Common helpers ────────────────────────────────────────────────────

    def _agent_env(self, agent_user: Optional[dict], agent_id: Optional[str] = None) -> dict:
        from command_security import sanitize_env
        env = sanitize_env(os.environ, agent_user)
        llm = self._get_llm_config(agent_id) if agent_id else None
        if llm:
            api_key = (llm.get("apiKey") or "").strip()
            provider = (llm.get("provider") or "").lower().strip()
            endpoint = (llm.get("endpoint") or "").strip()
            if api_key:
                # Expose the agent's API key under the env-var name(s) each
                # provider's SDK expects (see _PROVIDER_KEY_ENV). Must run
                # BEFORE the endpoint handling below: its placeholder-key
                # logic checks whether a real OPENAI_API_KEY landed here.
                for var in _PROVIDER_KEY_ENV.get(provider, ()):
                    env[var] = api_key
            if endpoint:
                # Some CLIs (litellm-based, openai-compatible) honor a base URL
                # override via env. Set the common ones so vLLM / Ollama / proxy
                # setups work without per-CLI config files.
                if provider == "openai" or provider in OPENAI_COMPATIBLE_LOCAL_PROVIDERS:
                    env["OPENAI_BASE_URL"] = endpoint
                    # Older OpenAI SDKs read OPENAI_API_BASE instead of _BASE_URL.
                    env.setdefault("OPENAI_API_BASE", endpoint)
                    # The OpenAI SDK refuses to start without OPENAI_API_KEY even
                    # when the local server ignores auth. Inject a harmless
                    # placeholder so the agent can reach a keyless local model.
                    if not env.get("OPENAI_API_KEY"):
                        env["OPENAI_API_KEY"] = "sk-local"
                elif provider == "anthropic":
                    env["ANTHROPIC_BASE_URL"] = endpoint
                elif provider == "ollama":
                    env["OLLAMA_HOST"] = endpoint
                    # Ollama also exposes an OpenAI-compatible API at /v1, which
                    # several CLIs prefer. Provide it so a local Ollama model is
                    # reachable regardless of which client path the CLI takes.
                    base = endpoint.rstrip("/")
                    if not base.endswith("/v1"):
                        base = f"{base}/v1"
                    env.setdefault("OPENAI_BASE_URL", base)
                    env.setdefault("OPENAI_API_BASE", base)
                    env.setdefault("OPENAI_API_KEY", "ollama")

        # GitHub plugin token mirror — see agent_user.apply_github_token_env
        # for the rationale (gh / SDK tooling needs GITHUB_TOKEN/GH_TOKEN).
        if agent_user and agent_user.get("home"):
            from agent_user import apply_github_token_env
            apply_github_token_env(env, agent_user["home"])
        return env

    def _verify_model_config(
        self,
        agent_id: Optional[str],
        *,
        model: str,
        env: Optional[dict] = None,
    ) -> None:
        """Log a startup summary of the agent's resolved model wiring and warn
        on likely misconfiguration.

        Called by CLI backends from `prepare_interactive` so an operator can
        confirm — at spawn time — that the agent's selected model is actually
        configured. For local / self-hosted models (a custom endpoint is set)
        it verifies the endpoint and an API key reached the spawn environment,
        which is the most common silent failure.
        """
        llm = self._get_llm_config(agent_id) or {}
        provider = (llm.get("provider") or "").lower().strip()
        endpoint = (llm.get("endpoint") or "").strip()
        configured_model = (llm.get("model") or "").strip()
        short = (agent_id or "unknown")[:12]
        env = env or {}

        is_local = bool(endpoint) or provider in OPENAI_COMPATIBLE_LOCAL_PROVIDERS or provider == "ollama"

        if not llm:
            logger.info(
                "[%s] model verify agent=%s: no per-agent LLM config — using runner default",
                self.name, short,
            )
            return

        logger.info(
            "[%s] model verify agent=%s provider=%s model=%s endpoint=%s local=%s resolved_cli_model=%s",
            self.name, short, provider or "-", configured_model or "-",
            endpoint or "-", is_local, model or "<default>",
        )

        if configured_model and not model:
            logger.warning(
                "[%s] agent=%s selected model '%s' did NOT resolve to a CLI model "
                "argument — the runner may fall back to its built-in default.",
                self.name, short, configured_model,
            )

        if is_local:
            if not endpoint:
                logger.warning(
                    "[%s] agent=%s local/openai-compatible provider '%s' has no endpoint "
                    "configured — the agent cannot reach the local model server.",
                    self.name, short, provider or "-",
                )
            has_base = any(
                env.get(k) for k in ("OPENAI_BASE_URL", "OPENAI_API_BASE", "OLLAMA_HOST", "ANTHROPIC_BASE_URL")
            )
            if endpoint and not has_base:
                logger.warning(
                    "[%s] agent=%s endpoint '%s' was not propagated to the spawn env "
                    "(no *_BASE_URL/OLLAMA_HOST set) — local model calls will hit the "
                    "default cloud endpoint.",
                    self.name, short, endpoint,
                )
            has_key = any(
                env.get(k) for k in (
                    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OLLAMA_API_KEY",
                )
            )
            if not has_key:
                logger.warning(
                    "[%s] agent=%s no API key env reached the spawn for the local model — "
                    "if the server enforces auth, requests will be rejected.",
                    self.name, short,
                )

    async def _report_usage_for_agent(self, agent_id: Optional[str], result: dict) -> None:
        """Push token usage to team-api so it shows up on the budget screen."""
        if not agent_id or not isinstance(result, dict):
            return
        try:
            in_toks = int(result.get("input_tokens") or 0)
            out_toks = int(result.get("output_tokens") or 0)
            cost = float(result.get("cost_usd") or 0.0)
        except (TypeError, ValueError):
            return
        if not in_toks and not out_toks and not cost:
            return
        llm = self._get_llm_config(agent_id) or {}
        provider = (llm.get("provider") or self.name or "cli").strip()
        model = (llm.get("model") or RUNNER_MODEL or "unknown").strip()
        try:
            await report_usage(
                agent_id,
                input_tokens=in_toks,
                output_tokens=out_toks,
                cost_usd=cost,
                provider=provider,
                model=model,
            )
        except Exception as e:
            logger.debug(f"[Usage] reporter raised for agent {agent_id[:8]}: {e}")

    def _resolve_cwd(self, agent_id: Optional[str]) -> str:
        agent_project_dir = get_agent_project_dir(agent_id) if agent_id else None
        if agent_project_dir and os.path.isdir(agent_project_dir):
            return agent_project_dir
        return CLI_CWD

    def _configure_mcp(self, agent_user: Optional[dict], agent_id: Optional[str]) -> None:
        """Materialize the agent's team-api MCP servers into this CLI's native
        config before a spawn. No-op in the base class; each CLI subclass
        overrides it with its own translator (see runner_mcp_config.py). Called
        from run_sync / stream_events / prepare_interactive so plugin/tool
        assignment changes take effect on the next message without recreating
        the agent's HOME."""
        return

    def _configure_instructions(self, agent_user: Optional[dict], agent_id: Optional[str]) -> None:
        """Materialize the agent's base instructions into this CLI's native
        global instructions file (CLAUDE.md / AGENTS.md) before a spawn. No-op
        in the base class; each CLI subclass overrides it with its own writer
        (see runner_instructions_config.py). Called from the same three spots as
        _configure_mcp so instruction edits take effect on the next message in
        BOTH the interactive PTY and headless paths."""
        return

    # ── Interactive terminal (shared template) ───────────────────────────

    # Whether prepare_interactive logs the model-wiring summary via
    # _verify_model_config. hermes opts out: its model is terminal-driven by
    # design (no --model argv), so the "did NOT resolve to a CLI model
    # argument" warning would be misleading there.
    verify_model_on_spawn: bool = True

    def _pre_interactive(
        self,
        agent_user: Optional[dict],
        effective_user: Optional[dict],
        agent_id: Optional[str],
    ) -> None:
        """Subclass setup that must run before the config writers (e.g.
        opencode pre-creates ~/.config). Runs after ensure_agent_user so the
        agent HOME already exists on a first spawn. Synchronous by design."""
        return

    def _post_configure_interactive(
        self,
        agent_user: Optional[dict],
        effective_user: Optional[dict],
        agent_id: Optional[str],
    ) -> None:
        """Subclass setup that runs after the MCP/instructions writers, before
        the spawn env is resolved (e.g. openclaw's exec-approvals policy).
        Kept separate from _configure_mcp so the headless run_sync /
        stream_events paths don't execute it."""
        return

    def _interactive_cmd(self, agent_id: Optional[str], permissions: Optional[dict]) -> list[str]:
        """Return the argv for the interactive TUI spawn."""
        raise NotImplementedError

    def _cli_model(self, agent_id: Optional[str]) -> str:
        """The resolved CLI model argument, for _verify_model_config logging."""
        return ""

    def _interactive_extras(
        self,
        agent_id: Optional[str],
        owner_id: Optional[str],
        agent_user: Optional[dict],
        effective_user: Optional[dict],
    ) -> dict:
        """Extra recipe keys (e.g. hermes' files-watcher pair). Default none."""
        return {}

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn recipe for the shared interactive PTY (see pty_session).

        One shared skeleton for every CLI backend: provision the agent user,
        write the CLI's native MCP/instructions config, resolve the spawn
        env, and let the subclass contribute argv + recipe extras via the
        hooks above. codex overrides this wholesale (different env/auth
        model)."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        self._pre_interactive(agent_user, effective_user, agent_id)
        # Off-loop: these helpers do blocking team-api fetches. Resolving the
        # env next also warms the per-agent LLM config cache for the
        # _interactive_cmd / _cli_model hooks below.
        await run_blocking(self._configure_mcp, effective_user, agent_id)
        await run_blocking(self._configure_instructions, effective_user, agent_id)
        self._post_configure_interactive(agent_user, effective_user, agent_id)
        env = await run_blocking(self._agent_env, effective_user, agent_id)

        cmd = self._interactive_cmd(agent_id, self._get_permissions(agent_id))
        if self.verify_model_on_spawn:
            self._verify_model_config(agent_id, model=self._cli_model(agent_id), env=env)

        kwargs = get_subprocess_kwargs(effective_user) or {}
        recipe = {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
        }
        recipe.update(self._interactive_extras(agent_id, owner_id, agent_user, effective_user))
        return recipe

    # ── Sync execution ────────────────────────────────────────────────────

    async def run_sync(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        messages: Optional[list] = None,
    ) -> dict:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        cwd = self._resolve_cwd(agent_id)
        permissions = self._get_permissions(agent_id)
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        # Materialize MCP tools into the CLI's native config BEFORE building the
        # command (some backends, e.g. hermes, branch their argv on whether MCP
        # is present). Off-loop: these helpers do blocking team-api fetches.
        await run_blocking(self._configure_mcp, effective_user, agent_id)
        # Materialize the agent's base instructions into the CLI's native global
        # instructions file (CLAUDE.md / AGENTS.md) so they're in context even
        # for backends that don't consume system_prompt in _build_command.
        await run_blocking(self._configure_instructions, effective_user, agent_id)
        # Resolve the spawn env off-loop too (_get_llm_config may fetch from
        # team-api on a cache miss); this also warms the per-agent LLM config
        # cache for _build_command below.
        env = await run_blocking(self._agent_env, effective_user, agent_id)

        cmd = self._build_command(prompt, stream=False, system_prompt=system_prompt, agent_id=agent_id, task_id=task_id, permissions=permissions)
        logger.info(f"Executing {self.cli_command}: {prompt[:100]}...")
        logger.debug(f"Command: {' '.join(cmd)} (cwd={cwd})")

        proc = None
        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdin=asyncio.subprocess.PIPE if self.pass_prompt_via_stdin else None,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=cwd,
                env=env,
                **get_subprocess_kwargs(effective_user),
            )
            stdin_input = prompt.encode("utf-8") if self.pass_prompt_via_stdin else None
            if CLI_PREP_DELAY_S > 0:
                # Let the CLI dismiss its splash/permission/model-pick prompts
                # before we pipe the real prompt into stdin. See module-level
                # CLI_PREP_DELAY_S comment.
                await asyncio.sleep(CLI_PREP_DELAY_S)
            stdout_bytes, stderr_bytes = await asyncio.wait_for(
                proc.communicate(input=stdin_input),
                timeout=TIMEOUT,
            )
        except asyncio.TimeoutError:
            if proc and proc.returncode is None:
                try:
                    proc.terminate()
                except (ProcessLookupError, PermissionError):
                    pass
                else:
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        try:
                            proc.kill()
                        except (ProcessLookupError, PermissionError):
                            pass
            return {"status": "timeout", "output": "", "error": f"Execution timeout after {TIMEOUT}s"}
        except asyncio.CancelledError:
            if proc and proc.returncode is None:
                try:
                    proc.terminate()
                except (ProcessLookupError, PermissionError):
                    pass
            raise

        stdout = stdout_bytes.decode("utf-8", errors="replace").strip()
        stderr = stderr_bytes.decode("utf-8", errors="replace").strip()

        if proc.returncode != 0 and not stdout:
            return {"status": "error", "output": "", "error": stderr or f"{self.cli_command} exited with code {proc.returncode}"}

        result = self._parse_sync_result(stdout)
        await self._report_usage_for_agent(agent_id, result)
        return result

    # ── Streaming ─────────────────────────────────────────────────────────

    async def stream_events(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        messages: Optional[list] = None,
    ) -> AsyncIterator[dict]:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        cwd = self._resolve_cwd(agent_id)
        permissions = self._get_permissions(agent_id)
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        # See run_sync: write MCP config + base instructions before building
        # argv, and resolve everything that hits team-api off-loop.
        await run_blocking(self._configure_mcp, effective_user, agent_id)
        await run_blocking(self._configure_instructions, effective_user, agent_id)
        env = await run_blocking(self._agent_env, effective_user, agent_id)

        cmd = self._build_command(prompt, stream=True, system_prompt=system_prompt, agent_id=agent_id, task_id=task_id, permissions=permissions)
        logger.info(f"Streaming {self.cli_command}: {prompt[:100]}...")

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdin=asyncio.subprocess.PIPE if self.pass_prompt_via_stdin else None,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
            limit=10 * 1024 * 1024,
            **get_subprocess_kwargs(effective_user),
        )
        # Drain stderr concurrently so a CLI that logs heavily to stderr
        # (e.g. codex's progress log) can't fill the pipe and stall mid-run.
        # The collected bytes are consumed after the stdout loop.
        stderr_task = asyncio.create_task(proc.stderr.read())
        loop = asyncio.get_running_loop()
        deadline = loop.time() + TIMEOUT
        timed_out = False
        try:
            if self.pass_prompt_via_stdin:
                if CLI_PREP_DELAY_S > 0:
                    # See module-level CLI_PREP_DELAY_S comment — let the CLI's
                    # auto-dismissed startup screens settle before feeding stdin.
                    await asyncio.sleep(CLI_PREP_DELAY_S)
                try:
                    proc.stdin.write(prompt.encode("utf-8"))
                    await proc.stdin.drain()
                    proc.stdin.close()
                except BrokenPipeError:
                    pass

            while True:
                remaining = deadline - loop.time()
                if remaining <= 0:
                    timed_out = True
                    break
                try:
                    raw_line = await asyncio.wait_for(proc.stdout.readline(), timeout=remaining)
                except asyncio.TimeoutError:
                    timed_out = True
                    break
                if not raw_line:
                    break  # EOF
                # Preserve internal whitespace; only strip the line terminator
                # so that plain-text fallbacks emitted by the CLI keep their
                # spacing when concatenated downstream.
                line = raw_line.decode("utf-8", errors="replace").rstrip("\r\n")
                if not line or not line.strip():
                    continue
                event = self._parse_stream_event(line)
                if not event:
                    continue
                # Expand "_blocks" container into individual events
                if event.get("type") == "_blocks":
                    for block in event.get("blocks", []):
                        if not isinstance(block, dict):
                            continue
                        btype = block.get("type")
                        if btype == "thinking":
                            yield {"type": "thinking", "content": block.get("thinking", "")}
                        elif btype == "text":
                            yield {"type": "text", "content": block.get("text", "")}
                        elif btype == "tool_use":
                            yield {"type": "status", "content": f"Using tool: {block.get('name', 'unknown')}"}
                else:
                    if event.get("type") == "result":
                        await self._report_usage_for_agent(agent_id, event)
                    yield event
            if timed_out:
                # Kill before the finally's wait so cleanup can't block on
                # the stalled CLI.
                try:
                    proc.kill()
                except (ProcessLookupError, PermissionError):
                    pass
        except asyncio.CancelledError:
            # Client disconnected — signal the CLI before any await so it
            # doesn't keep running (and writing) headless forever.
            stderr_task.cancel()
            try:
                proc.terminate()
            except (ProcessLookupError, PermissionError):
                pass
            raise
        finally:
            try:
                await proc.wait()
            except asyncio.CancelledError:
                pass

        if timed_out:
            stderr_task.cancel()
            yield {"type": "error", "content": f"Execution timeout after {TIMEOUT}s"}
            return

        if proc.returncode != 0:
            stderr_bytes = await stderr_task
            stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
            if stderr_text:
                yield {"type": "error", "content": stderr_text}
        else:
            stderr_task.cancel()
