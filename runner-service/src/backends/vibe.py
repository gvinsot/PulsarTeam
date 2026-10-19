"""
Vibe backend — wraps Mistral Vibe Code (https://github.com/mistralai/mistral-vibe).

Real CLI surface (mistral-vibe 2.26):
  vibe [PROMPT]                         # interactive TUI, optional first prompt
  vibe -p "<prompt>"                    # programmatic mode: run, print, exit
  vibe -p "..." --output text|json|streaming
  vibe --auto-approve | --yolo          # approve every tool call
  vibe --trust                          # trust the cwd for this run only
  vibe --setup                          # store MISTRAL_API_KEY in ~/.vibe/.env
Exit codes in programmatic mode: 0 done, 1 usage/config, 2 infra,
3 limit/stop, 4 aborted.

Configuration layering (lowest → highest priority): defaults, user TOML
(~/.vibe/config.toml), project TOML (./.vibe/config.toml, trusted dirs only),
VIBE_* env vars, CLI overrides. We use the env layer for everything Pulsar
manages, so the user's own config.toml is never rewritten by us:
  - VIBE_MCP_SERVERS: the agent's MCP servers (JSON list). `mcp_servers`
    union-merges by name, so the user's own servers in config.toml are kept.
  - VIBE_BYPASS_TOOL_PERMISSIONS: mirrors the agent's "skip permissions" toggle.
  - VIBE_ENABLE_AUTO_UPDATE / VIBE_ENABLE_UPDATE_CHECKS: off — the image pins
    the CLI and a per-agent UID can't write the shared install anyway.

Model selection is terminal-driven, like hermes: Vibe resolves its model from
`active_model` in ~/.vibe/config.toml (set with /model in the TUI), persisted
across stateless restarts via persisted_config_files. We deliberately do NOT
pin VIBE_ACTIVE_MODEL from the Settings LLM config: the env layer outranks the
user TOML, so a stale Settings pin would make /model impossible to change.
The Settings config still supplies MISTRAL_API_KEY (see _PROVIDER_KEY_ENV).

Base instructions go to ~/.vibe/AGENTS.md, Vibe's documented user-level
instructions file.
"""

import json
import os
from typing import Optional

from config import logger
from .cli_backend import CliBackend
from .runner_mcp_config import fetch_vibe_mcp_servers
from .runner_instructions_config import configure_vibe_instructions

# Files under ~/.vibe that the user configures in the terminal (/model,
# `vibe --setup`) and that we persist/restore across stateless restarts.
_VIBE_PERSISTED_FILES = ("config.toml", ".env")


class VibeBackend(CliBackend):
    name = "vibe"
    cli_command = "vibe"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    persisted_config_files = tuple(
        os.path.join(".vibe", name) for name in _VIBE_PERSISTED_FILES
    )

    # Model is terminal-driven (see module docstring): no --model argv, so the
    # model-wiring verify log would warn misleadingly.
    verify_model_on_spawn = False

    def __init__(self):
        super().__init__()
        # agent_id → JSON for VIBE_MCP_SERVERS, refreshed by _configure_mcp.
        # Kept across a failed fetch so a transient team-api outage doesn't
        # strip the agent's tools for that spawn.
        self._mcp_env: dict[str, str] = {}

    def _configure_mcp(self, agent_user, agent_id) -> None:
        if not agent_id:
            return
        servers = fetch_vibe_mcp_servers(agent_id)
        if servers is None:
            return  # fetch failed — keep the last known set
        self._mcp_env[agent_id] = json.dumps(servers)
        self._mcp_present[agent_id] = bool(servers)
        logger.info(f"[Vibe MCP] configured {len(servers)} MCP server(s) for agent {agent_id[:12]}")

    def _configure_instructions(self, agent_user, agent_id) -> None:
        configure_vibe_instructions(agent_user, agent_id)

    def _skip_permissions(self, permissions: Optional[dict]) -> bool:
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        return bool(exec_perms.get("dangerousSkipPermissions", True))

    def _agent_env(self, agent_user: Optional[dict], agent_id: Optional[str] = None) -> dict:
        env = super()._agent_env(agent_user, agent_id)
        env["VIBE_ENABLE_AUTO_UPDATE"] = "false"
        env["VIBE_ENABLE_UPDATE_CHECKS"] = "false"
        # Key precedence: per-agent Settings config (already in env via
        # _PROVIDER_KEY_ENV) > key saved in the terminal (~/.vibe/.env, which
        # an env var would shadow) > the service-wide MISTRAL_API_KEY, which
        # sanitize_env strips and we forward only as a last resort.
        fallback_key = os.environ.get("MISTRAL_API_KEY", "").strip()
        if fallback_key and not env.get("MISTRAL_API_KEY") and not self._has_saved_key(agent_user):
            env["MISTRAL_API_KEY"] = fallback_key
        if agent_id:
            mcp = self._mcp_env.get(agent_id)
            if mcp is not None:
                env["VIBE_MCP_SERVERS"] = mcp
            skip = self._skip_permissions(self._get_permissions(agent_id))
            env["VIBE_BYPASS_TOOL_PERMISSIONS"] = "true" if skip else "false"
        return env

    @staticmethod
    def _has_saved_key(agent_user: Optional[dict]) -> bool:
        home = (agent_user or {}).get("home")
        if not home:
            return False
        try:
            with open(os.path.join(home, ".vibe", ".env"), "r", encoding="utf-8") as f:
                return any(
                    line.strip().startswith("MISTRAL_API_KEY=") and line.split("=", 1)[1].strip()
                    for line in f
                )
        except OSError:
            return False

    def _common_args(self, permissions: Optional[dict]) -> list[str]:
        # --trust: the agent's workspace is ours; without it a repo carrying a
        # .vibe/ folder stops on Vibe's trust-folder prompt.
        args = ["--trust"]
        if self._skip_permissions(permissions):
            args.append("--auto-approve")
        return args

    # ── Interactive terminal hooks (see CliBackend.prepare_interactive) ──

    def _interactive_cmd(self, agent_id, permissions):
        return [self.cli_command] + self._common_args(permissions)

    # ── Headless ──

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        # Runner is stateless — conversation history is replayed inside
        # `prompt` by the caller, so Vibe's --continue/--resume are not used.
        cmd = [self.cli_command] + self._common_args(permissions)
        if stream:
            cmd += ["--output", "streaming"]
        # `--prompt=` form so a prompt starting with "-" isn't read as a flag.
        cmd.append(f"--prompt={prompt}")
        return cmd

    def _parse_sync_result(self, stdout: str) -> dict:
        # Text output is the final assistant message as plain text — never
        # JSON-decode it (an answer that happens to be JSON would be mangled).
        return {"status": "success", "output": stdout}

    def _parse_stream_event(self, line: str, state: Optional[dict] = None) -> Optional[dict]:
        """Map one `--output streaming` line (a completed history entry) to a
        canonical event. Entry shapes (vibe.app_server.models):
          message   {role, content:[{type:"text", text}]}
          reasoning {text}
          effect    {title, ...}       — a tool call / side effect
          notice    {level, message}
        """
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            return {"type": "text", "content": line + "\n"}
        if not isinstance(entry, dict):
            return None

        etype = entry.get("type")
        if etype == "message":
            if entry.get("role") != "assistant":
                return None
            text = "\n\n".join(
                block.get("text") or ""
                for block in entry.get("content") or []
                if isinstance(block, dict) and block.get("type") == "text"
            )
            return {"type": "text", "content": text} if text else None
        if etype == "reasoning":
            text = entry.get("text") or ""
            return {"type": "thinking", "content": text} if text else None
        if etype == "effect":
            title = entry.get("title") or "tool"
            return {"type": "status", "content": f"Using tool: {title}"}
        if etype == "notice":
            message = entry.get("message") or ""
            if not message:
                return None
            if entry.get("level") == "error":
                return {"type": "error", "content": message}
            return {"type": "status", "content": message}
        return None
