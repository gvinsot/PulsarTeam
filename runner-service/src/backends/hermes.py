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

Model selection is fully terminal-driven:
  hermes picks its provider/model from ~/.hermes/config.yaml — what the user
  set up in the terminal (`hermes setup` / edits), restored from team-api on
  every stateless spawn (see runner_config_store + _restore_config). We do
  NOT forward the Settings per-agent LLM config as `--provider/--model`:
  doing so let a stale Settings pin (e.g. claude-opus-4-8) override whatever
  the user configured in the terminal — which the user could then no longer
  change from the terminal at all. The matching API-key env vars are still
  injected by CliBackend._agent_env if a per-agent config lingers, but
  they're harmless: hermes follows the provider/model in config.yaml.

  We also never pass --ignore-user-config — that config file IS the agent's
  authoritative source (ignoring it was what made hermes report "no
  providers found" and re-run its setup wizard).
"""

import os
from typing import Optional

from config import logger
from agent_user import ensure_agent_user, _agent_users
from .cli_backend import CliBackend
from .claude_token_store import get_subprocess_kwargs, run_blocking
from .runner_mcp_config import configure_hermes_mcp, configure_hermes_local_providers
from .runner_instructions_config import configure_hermes_instructions
from .runner_config_store import fetch_runner_config, save_runner_config

# Files under ~/.hermes that the user configures (via `hermes setup` or by
# editing) and that we persist/restore across stateless restarts.
_HERMES_PERSISTED_FILES = ("config.yaml", ".env")


def _hermes_home(agent_user: Optional[dict], agent_id: Optional[str]):
    """Resolve agent HOME + uid/gid for ~/.hermes files, falling back to the
    agent-user cache when running as root (effective_user=None)."""
    home_user = agent_user
    if (not home_user or not home_user.get("home")) and agent_id:
        home_user = _agent_users.get(agent_id)
    home = (home_user or {}).get("home")
    uid = (home_user or {}).get("uid")
    gid = (home_user or {}).get("gid", uid)
    return home, uid, gid


def _hermes_config_paths(home: str) -> list:
    return [os.path.join(home, ".hermes", name) for name in _HERMES_PERSISTED_FILES]


class HermesBackend(CliBackend):
    name = "hermes"
    cli_command = "hermes"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    def _restore_config(self, agent_user, agent_id) -> None:
        """Restore the agent's ~/.hermes/{config.yaml,.env} from team-api before
        spawning, so the provider/model the user set up in the terminal survives
        the stateless restart (no more `hermes setup` wizard, no wrong model)."""
        if not agent_id:
            return
        # Don't clobber a live terminal session's config: the user may have
        # just edited ~/.hermes inside the PTY, and the fetch below is cached
        # (15s) so it could overwrite the fresh file with stale content —
        # which the session's live-sync would then persist back to team-api.
        try:
            from pty_session import get_session
            if get_session(agent_id) is not None:
                return
        except ImportError:
            pass
        files = fetch_runner_config("hermes", agent_id)
        if not files:
            return
        home, uid, gid = _hermes_home(agent_user, agent_id)
        if not home:
            return
        cfg_dir = os.path.join(home, ".hermes")
        try:
            os.makedirs(cfg_dir, exist_ok=True)
        except OSError as e:
            logger.warning(f"[Hermes] cannot create {cfg_dir}: {e}")
            return
        written = 0
        for name, content in files.items():
            if name not in _HERMES_PERSISTED_FILES:
                continue
            path = os.path.join(cfg_dir, name)
            try:
                with open(path, "w", encoding="utf-8") as f:
                    f.write(content)
                if uid is not None:
                    os.chown(path, uid, gid if gid is not None else uid)
                    os.chmod(path, 0o600)
                written += 1
            except OSError as e:
                logger.warning(f"[Hermes] failed to restore {path}: {e}")
        if uid is not None:
            try:
                os.chown(cfg_dir, uid, gid if gid is not None else uid)
            except OSError:
                pass
        if written:
            logger.info(f"[Hermes] restored {written} config file(s) for agent {(agent_id or '?')[:12]}")

    def _configure_mcp(self, agent_user, agent_id) -> None:
        # Restore the persisted ~/.hermes config FIRST so the MCP wiring below
        # merges on top of the user's restored setup (not a blank file). This
        # runs on EVERY spawn — headless run_sync/stream_events included — so a
        # stateless restart can't leave a headless hermes with an empty config
        # that re-runs its setup wizard. fetch_runner_config caches for 15s, so
        # back-to-back spawns don't double-fetch.
        self._restore_config(agent_user, agent_id)
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
        one-shot invocations: permission flags only.

        We deliberately pass NO --provider/--model. hermes' model is fully
        terminal-driven — it comes from ~/.hermes/config.yaml (set up in the
        terminal, restored from team-api). Forwarding the Settings per-agent
        LLM config as --model used to let a stale pin (e.g. claude-opus-4-8)
        override the terminal config, so the user could not change the model
        from the terminal. We also never pass --ignore-user-config — that
        config file IS the agent's authoritative source.
        """
        args: list[str] = []
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            args.append("--yolo")
        return args

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Spawn Hermes in its interactive chat mode for the shared PTY."""
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        permissions = self._get_permissions(agent_id)
        # _configure_mcp restores the persisted ~/.hermes config before merging
        # its MCP wiring on top of the user's setup. Off-loop: both steps do
        # blocking team-api fetches.
        await run_blocking(self._configure_mcp, effective_user, agent_id)
        await run_blocking(self._configure_instructions, effective_user, agent_id)

        cmd = [self.cli_command, "chat"] + self._common_chat_args(agent_id, permissions)

        env = await run_blocking(self._agent_env, effective_user, agent_id)

        # Live-sync: persist ~/.hermes/{config.yaml,.env} to team-api whenever
        # the user runs `hermes setup` / edits config inside the terminal, so it
        # survives the next stateless restart (see PtySession files watcher).
        home, _, _ = _hermes_home(effective_user, agent_id)
        watch_paths = _hermes_config_paths(home) if home else None
        captured_agent_id = agent_id

        def _persist_hermes_config(files: dict) -> None:
            # Raise on failure so PtySession._maybe_sync_files does NOT advance
            # its signature and retries the sync on the next poll tick.
            if not save_runner_config("hermes", captured_agent_id, files):
                raise RuntimeError(f"save_runner_config failed for agent {captured_agent_id}")

        kwargs = get_subprocess_kwargs(effective_user) or {}
        return {
            "cmd": cmd,
            "cwd": self._resolve_cwd(agent_id),
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
            "files_watch_paths": watch_paths if agent_id else None,
            "files_on_change": _persist_hermes_config if (watch_paths and agent_id) else None,
        }

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "chat", "--quiet"] + self._common_chat_args(agent_id, permissions)
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. The hermes CLI's --resume is not used.
        cmd += ["-q", prompt]
        return cmd
