"""
OpenAI Codex backend — wraps the `@openai/codex` CLI in headless mode.

Mirrors the claude-code pattern so operators can lean on their ChatGPT
plan (OAuth) the same way they lean on a Claude Pro/Max plan:
  - `codex login` writes ~/.codex/auth.json (OAuth tokens for ChatGPT plan)
  - Per-agent HOME isolation gives each agent its own auth.json copy
  - Falls back to OPENAI_API_KEY when no OAuth token is present

CLI surface (from `codex exec --help`):
  codex exec [prompt]
    --json                                       # JSONL events on stdout
    --model, -m <id>                             # e.g. gpt-5-codex
    --cd <dir>                                   # working directory
    --full-auto                                  # auto-approve safe ops
    --dangerously-bypass-approvals-and-sandbox   # skip every prompt
    --skip-git-repo-check                        # allow non-git workspaces
    --output-last-message <path>                 # write final reply to file
    --output-schema <file>                       # constrain final reply
    resume [session-id] [prompt]                 # continue a recorded session

The prompt may be passed as a positional argument OR via stdin (so we
keep `pass_prompt_via_stdin = False` and embed it in the args).

JSON event shape emitted by `codex exec --json`:
  {"id":"...","msg":{"type":"task_started"}}
  {"id":"...","msg":{"type":"agent_message_delta","delta":"..."}}
  {"id":"...","msg":{"type":"agent_message","message":"..."}}
  {"id":"...","msg":{"type":"exec_command_begin", ...}}
  {"id":"...","msg":{"type":"token_count","input_tokens":...,"output_tokens":...}}
  {"id":"...","msg":{"type":"task_complete","last_agent_message":"..."}}
"""

import os
import json
from typing import Optional

from config import RUNNER_MODEL, logger
from .cli_backend import CliBackend


# Codex CLI honors $CODEX_HOME for its auth/state location. When set, the
# tokens live in $CODEX_HOME/auth.json instead of ~/.codex/auth.json. We do
# NOT set it ourselves — per-agent HOME isolation (handled by
# ensure_agent_user) already gives every agent its own ~/.codex tree.
DEFAULT_CODEX_MODEL = "gpt-5-codex"


class CodexBackend(CliBackend):
    name = "codex"
    cli_command = "codex"
    pass_prompt_via_stdin = False  # prompt goes in as a positional arg
    supports_oauth_login = False   # OAuth is done by `codex login` inside the container
    supports_token_set = False     # codex auth.json has a complex shape — not pasteable

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        await super().startup()
        # Surface which auth mode the CLI will pick up so the operator can
        # see immediately whether they need to run `codex login`.
        auth_json = os.path.expanduser("~/.codex/auth.json")
        if os.path.isfile(auth_json):
            logger.info("  Auth: ChatGPT plan (OAuth) — ~/.codex/auth.json present")
        elif os.getenv("OPENAI_API_KEY"):
            logger.info("  Auth: OPENAI_API_KEY (API credits)")
        else:
            logger.warning(
                "  No auth configured for codex. Run `codex login` inside this "
                "container OR set OPENAI_API_KEY."
            )

    # ── Command builder ───────────────────────────────────────────────────

    def _build_command(self, prompt, stream, system_prompt, agent_id, task_id, permissions):
        cmd = [self.cli_command, "exec"]

        if stream:
            cmd.append("--json")

        cmd += ["--model", RUNNER_MODEL or DEFAULT_CODEX_MODEL]
        # Codex refuses to run outside a git repo unless told otherwise; the
        # per-agent workspace isn't always a repo (e.g. fresh sandbox dir).
        cmd.append("--skip-git-repo-check")

        # Permissions: same toggle name as the other backends. ON by default
        # for headless ops; OFF flips us to `--full-auto` which still
        # auto-runs safe operations but prompts for destructive ones (codex
        # in headless mode will then fail-fast, which is the expected
        # fallback when an agent isn't allowed to skip prompts).
        exec_perms = (permissions or {}).get("execution", {}) if permissions else {}
        if exec_perms.get("dangerousSkipPermissions", True):
            cmd.append("--dangerously-bypass-approvals-and-sandbox")
        else:
            cmd.append("--full-auto")

        # Session resume: codex prints a session_id at the start of every run
        # (event `session_configured`). Capturing/persisting it would require
        # overriding stream_events; for now we always run a fresh session,
        # matching the opencode/hermes baseline. The user prompt is enough
        # for headless one-shot tasks.

        # Append the system prompt (codex has no dedicated flag for this in
        # headless mode — prepend it to the user prompt instead, separated
        # by a blank line so the model still treats it as instructions).
        if system_prompt:
            prompt = f"{system_prompt}\n\n{prompt}"

        # Positional prompt MUST come last.
        cmd.append(prompt)
        return cmd

    # ── Output parsing ────────────────────────────────────────────────────

    def _parse_sync_result(self, stdout: str) -> dict:
        """`codex exec` without --json prints the final assistant reply as
        plain text (no JSON envelope). Return it directly."""
        return {"status": "success", "output": stdout.strip()}

    def _parse_stream_event(self, line: str) -> Optional[dict]:
        """Translate codex's JSONL event stream into the canonical event
        shape consumed by stream_events in cli_backend.

        Codex emits events of the form:
          {"id": "...", "msg": {"type": "...", ...}}
        """
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            return {"type": "text", "content": line}

        msg = event.get("msg") if isinstance(event, dict) else None
        if not isinstance(msg, dict):
            return None

        mtype = msg.get("type", "")

        if mtype == "session_configured":
            # First event of every run — informational. We don't persist
            # the session_id yet (see _build_command for the rationale).
            return None

        if mtype == "agent_message_delta":
            return {"type": "text", "content": msg.get("delta", "")}

        if mtype == "agent_message":
            # Already streamed via deltas — skip to avoid duplicate text.
            return None

        if mtype == "agent_reasoning_delta":
            return {"type": "thinking", "content": msg.get("delta", "")}

        if mtype in ("exec_command_begin", "patch_apply_begin", "mcp_tool_call_begin"):
            tool = (
                msg.get("command")
                or msg.get("tool_name")
                or msg.get("server")
                or mtype.replace("_begin", "")
            )
            if isinstance(tool, list):
                tool = " ".join(str(x) for x in tool[:3])
            return {"type": "status", "content": f"Using tool: {tool}"}

        if mtype == "token_count":
            # Hold onto last seen counts so the final `result` event can
            # report them. Codex emits this multiple times during a run.
            self._pending_tokens = {
                "input_tokens": int(msg.get("input_tokens") or 0),
                "output_tokens": int(msg.get("output_tokens") or 0),
                "total_tokens": int(msg.get("total_tokens") or 0)
                                 or (int(msg.get("input_tokens") or 0)
                                     + int(msg.get("output_tokens") or 0)),
            }
            return None

        if mtype == "task_complete":
            tokens = getattr(self, "_pending_tokens", {}) or {}
            final = msg.get("last_agent_message", "") or ""
            return {
                "type": "result",
                "content": final,
                "cost_usd": 0,
                "duration_ms": 0,
                "total_tokens": tokens.get("total_tokens", 0),
                "input_tokens": tokens.get("input_tokens", 0),
                "output_tokens": tokens.get("output_tokens", 0),
            }

        if mtype == "error":
            return {"type": "error", "content": msg.get("message", str(msg))}

        return None
