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

import json
import os
from typing import Optional

from config import logger
from agent_user import ensure_agent_user, _agent_users
from .cli_backend import CliBackend, OPENAI_COMPATIBLE_LOCAL_PROVIDERS
from .claude_token_store import get_subprocess_kwargs, run_blocking
from .runner_mcp_config import configure_openclaw_mcp
from .runner_instructions_config import configure_openclaw_instructions


OPENCLAW_AGENT = os.getenv("OPENCLAW_AGENT", "default")
OPENCLAW_LOCAL = os.getenv("OPENCLAW_LOCAL", "true").lower() in ("true", "1", "yes")
_PULSAR_PERMISSIONS_SIDECAR = ".pulsar-managed-permissions.json"


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


def _dangerous_skip_permissions(permissions: Optional[dict]) -> bool:
    exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
    return bool(exec_perms.get("dangerousSkipPermissions", True))


def _resolve_openclaw_home(agent_user: Optional[dict], agent_id: Optional[str]) -> tuple[Optional[str], Optional[int], Optional[int]]:
    home_user = agent_user
    if (not home_user or not home_user.get("home")) and agent_id:
        home_user = _agent_users.get(agent_id)
    if not home_user or not home_user.get("home"):
        return None, None, None
    uid = home_user.get("uid")
    gid = home_user.get("gid", uid)
    return home_user["home"], uid, gid


def _read_json_file(path: str) -> dict:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _write_json_file(path: str, data: dict, uid: Optional[int], gid: Optional[int]) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    if uid is not None:
        try:
            os.chown(path, uid, gid if gid is not None else uid)
            os.chmod(path, 0o600)
        except OSError:
            pass


def _openclaw_permissions_were_managed(cfg_dir: str) -> bool:
    data = _read_json_file(os.path.join(cfg_dir, _PULSAR_PERMISSIONS_SIDECAR))
    return data.get("managed") is True


def _set_openclaw_permissions_managed(cfg_dir: str, enabled: bool, uid: Optional[int], gid: Optional[int]) -> None:
    sidecar = os.path.join(cfg_dir, _PULSAR_PERMISSIONS_SIDECAR)
    if not enabled:
        try:
            os.remove(sidecar)
        except FileNotFoundError:
            pass
        except OSError as exc:
            logger.warning("[OpenClaw Permissions] could not remove %s: %s", sidecar, exc)
        return
    try:
        _write_json_file(sidecar, {"managed": True}, uid, gid)
    except OSError as exc:
        logger.warning("[OpenClaw Permissions] could not write %s: %s", sidecar, exc)


def configure_openclaw_permissions(agent_user: Optional[dict], agent_id: Optional[str], permissions: Optional[dict]) -> None:
    """Apply Pulsar's dangerousSkipPermissions toggle to OpenClaw's native
    no-approval policy surfaces.

    OpenClaw has no single CLI flag for "skip approvals": docs define YOLO as
    requested exec mode plus host-local approvals defaults in
    ~/.openclaw/exec-approvals.json.
    """
    home, uid, gid = _resolve_openclaw_home(agent_user, agent_id)
    if not home:
        logger.warning("[OpenClaw Permissions] no HOME for agent %s — skipping", (agent_id or "?")[:12])
        return
    cfg_dir = os.path.join(home, ".openclaw")
    cfg_path = os.path.join(cfg_dir, "openclaw.json")
    approvals_path = os.path.join(cfg_dir, "exec-approvals.json")
    enabled = _dangerous_skip_permissions(permissions)
    was_managed = _openclaw_permissions_were_managed(cfg_dir)

    cfg = _read_json_file(cfg_path)
    approvals = _read_json_file(approvals_path)

    if enabled:
        tools = cfg.setdefault("tools", {})
        if not isinstance(tools, dict):
            tools = {}
            cfg["tools"] = tools
        exec_cfg = tools.setdefault("exec", {})
        if not isinstance(exec_cfg, dict):
            exec_cfg = {}
            tools["exec"] = exec_cfg
        exec_cfg["mode"] = "full"
        # OpenClaw rejects the newer `mode` key when legacy policy keys are
        # also present in tools.exec.
        exec_cfg.pop("security", None)
        exec_cfg.pop("ask", None)

        approvals["version"] = approvals.get("version") or 1
        defaults = approvals.setdefault("defaults", {})
        if not isinstance(defaults, dict):
            defaults = {}
            approvals["defaults"] = defaults
        defaults["security"] = "full"
        defaults["ask"] = "off"
        defaults["askFallback"] = "full"
    elif was_managed:
        tools = cfg.get("tools")
        exec_cfg = tools.get("exec") if isinstance(tools, dict) else None
        if isinstance(exec_cfg, dict):
            for key in ("mode", "security", "ask"):
                exec_cfg.pop(key, None)
            if not exec_cfg:
                tools.pop("exec", None)
        if isinstance(tools, dict) and not tools:
            cfg.pop("tools", None)
        defaults = approvals.get("defaults")
        if isinstance(defaults, dict):
            for key in ("security", "ask", "askFallback"):
                defaults.pop(key, None)
            if not defaults:
                approvals.pop("defaults", None)

    if enabled or was_managed:
        try:
            _write_json_file(cfg_path, cfg, uid, gid)
            _write_json_file(approvals_path, approvals, uid, gid)
            _set_openclaw_permissions_managed(cfg_dir, enabled, uid, gid)
            logger.info(
                "[OpenClaw Permissions] %s YOLO exec policy for agent %s",
                "enabled" if enabled else "cleared",
                (agent_id or "?")[:12],
            )
        except OSError as exc:
            logger.warning("[OpenClaw Permissions] failed to write policy files: %s", exc)


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
        # Off-loop: both helpers do blocking team-api fetches.
        await run_blocking(self._configure_mcp, effective_user, agent_id)
        await run_blocking(self._configure_instructions, effective_user, agent_id)
        configure_openclaw_permissions(
            effective_user or agent_user,
            agent_id,
            self._get_permissions(agent_id),
        )

        cmd = [self.cli_command, "tui"]
        if OPENCLAW_LOCAL:
            cmd.append("--local")
        if OPENCLAW_AGENT and OPENCLAW_AGENT != "default":
            cmd += ["--session", f"agent:{OPENCLAW_AGENT}:main"]

        # Pass agent_id so the selected model's provider credentials + endpoint
        # are injected (previously omitted, so local/custom models silently fell
        # back to OpenClaw's built-in default with no auth/endpoint). The
        # overridden `_agent_env` also layers the model env on top. Off-loop:
        # _get_llm_config may fetch from team-api on a cache miss.
        env = await run_blocking(self._agent_env, effective_user, agent_id)
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
        home, _, _ = _resolve_openclaw_home(agent_user, agent_id)
        if home:
            env["HOME"] = home
        return self._model_env(agent_id, env)


    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        configure_openclaw_permissions(None, agent_id, permissions)
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
