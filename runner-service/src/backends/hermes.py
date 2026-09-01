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
  every stateless spawn (see CliBackend.persisted_config_files). We do
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

from .cli_backend import CliBackend
from .runner_mcp_config import configure_hermes_mcp, configure_hermes_local_providers
from .runner_instructions_config import configure_hermes_instructions

# Files under ~/.hermes that the user configures (via `hermes setup` or by
# editing) and that we persist/restore across stateless restarts.
_HERMES_PERSISTED_FILES = ("config.yaml", ".env")


class HermesBackend(CliBackend):
    name = "hermes"
    cli_command = "hermes"
    pass_prompt_via_stdin = False
    supports_interactive_terminal = True

    # Restored before every spawn and saved back on in-terminal edits by
    # CliBackend (see persisted_config_files). Without this a stateless restart
    # dropped the user through hermes' setup wizard again, on the wrong model.
    persisted_config_files = tuple(
        os.path.join(".hermes", name) for name in _HERMES_PERSISTED_FILES
    )

    def _configure_mcp(self, agent_user, agent_id) -> None:
        # The persisted ~/.hermes config was already restored by
        # CliBackend._restore_persisted_config, which every spawn path (headless
        # included) runs just before this — so the MCP wiring below merges on
        # top of the user's setup instead of into a blank file.
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

    # ── Interactive terminal hooks (see CliBackend.prepare_interactive) ──

    # Hermes' model is fully terminal-driven by design (see module docstring):
    # no --model argv, so the model-wiring verify log would warn misleadingly.
    verify_model_on_spawn = False

    def _interactive_cmd(self, agent_id, permissions):
        return [self.cli_command, "chat"] + self._common_chat_args(agent_id, permissions)

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "chat", "--quiet"] + self._common_chat_args(agent_id, permissions)
        # Runner is stateless — conversation history is replayed inside `prompt`
        # by the caller. The hermes CLI's --resume is not used.
        cmd += ["-q", prompt]
        return cmd
