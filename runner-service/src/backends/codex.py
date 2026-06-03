"""
OpenAI Codex backend — wraps the `@openai/codex` CLI in headless mode.

Mirrors the claude-code (paid) pattern so operators can lean on their
ChatGPT plan (OAuth) the same way they lean on a Claude Pro/Max plan:
  - OAuth PKCE flow against auth.openai.com (see codex_oauth.py)
  - Per-owner token persistence via team-api (encrypted at rest)
  - Per-agent HOME isolation gives each agent its own auth.json copy
  - Automatic refresh_token grant before each spawn (matching the claude
    paid pattern)
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
from typing import Optional, AsyncIterator

from config import RUNNER_MODEL, logger
from .cli_backend import CliBackend
from .codex_token_store import (
    hydrate_agent_auth,
    push_agent_auth_if_changed,
    read_local_auth,
    auth_file_path,
    load_owner_blob,
    save_owner_blob,
    write_local_auth,
    auth_method_for_blob,
    global_auth_method,
)
from .codex_oauth import (
    initiate_owner_login,
    initiate_agent_login,
    get_owner_oauth_flow,
    pop_owner_oauth_flow,
    get_agent_oauth_flow,
    pop_agent_oauth_flow,
    exchange_owner_code,
    exchange_agent_code,
    refresh_blob,
    is_blob_expired,
    blob_account_email,
    blob_plan_type,
    parse_blob_input,
    try_exchange_code_from_prompt,
)
from agent_user import ensure_agent_user
from .runner_mcp_config import configure_codex_mcp


# Codex CLI honors $CODEX_HOME for its auth/state location. When set, the
# tokens live in $CODEX_HOME/auth.json instead of ~/.codex/auth.json. We do
# NOT set it ourselves — per-agent HOME isolation (handled by
# ensure_agent_user) already gives every agent its own ~/.codex tree.
DEFAULT_CODEX_MODEL = "gpt-5.5"


class CodexBackend(CliBackend):
    name = "codex"
    cli_command = "codex"
    pass_prompt_via_stdin = False  # prompt goes in as a positional arg
    supports_oauth_login = True    # OAuth PKCE against auth.openai.com
    supports_token_set = True      # accepts a full auth.json blob via /auth/token
    supports_interactive_terminal = True  # `codex` (no `exec` subcommand) is a real TUI

    def _configure_mcp(self, agent_user, agent_id) -> None:
        # Writes [mcp_servers.*] tables into ~/.codex/config.toml. NOTE: HTTP
        # MCP support in codex is version-dependent — see configure_codex_mcp.
        configure_codex_mcp(agent_user, agent_id)

    # ── Interactive terminal recipe ───────────────────────────────────────

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Build a recipe to spawn `codex` (no `exec` subcommand) in a
        shared PTY. Same per-agent isolation and auth hydration as the
        headless `run_sync`/`stream_events` path."""
        from .cli_backend import CliBackend as _CliBackend
        # Hydrate the per-agent ~/.codex/auth.json + refresh the OAuth
        # token if it's about to expire. Reuses the same code path the
        # headless modes call before every spawn.
        await self._hydrate_for_exec(agent_id, owner_id)

        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        effective_user = self._resolve_effective_user(agent_id, agent_user) \
            if hasattr(self, "_resolve_effective_user") else agent_user
        self._configure_mcp(effective_user, agent_id)

        # cwd: the agent's project workspace when available, else the
        # generic CLI cwd. Same resolution as cli_backend uses.
        from agent_user import get_agent_project_dir
        from config import CLI_CWD
        project_dir = get_agent_project_dir(agent_id) if agent_id else None
        cwd = project_dir if (project_dir and os.path.isdir(project_dir)) else CLI_CWD

        # The interactive CLI is just `codex` — no `exec`, no `--json`, no
        # positional prompt. The user types into the TUI. We still pass
        # `--model` so the agent's configured model is used.
        cmd = [self.cli_command, "--model", RUNNER_MODEL or DEFAULT_CODEX_MODEL]

        # Env: same per-agent env as headless. CODEX_HOME is implicit via
        # the HOME of the dropped UID (see ensure_agent_user).
        env = self._build_env(agent_user) if hasattr(self, "_build_env") else None
        if env is None:
            # Fallback: minimal sanitized env.
            from command_security import sanitize_env
            env = sanitize_env(os.environ, agent_user)

        from .claude_token_store import get_subprocess_kwargs as _drop_kw
        kwargs = _drop_kw(effective_user) or {}

        # Reverse-sync hook (same idea as claude-code): when the user runs
        # `codex login` inside the TUI, the CLI rewrites ~/.codex/auth.json.
        # The headless `run_sync` / `stream_events` already do this via
        # `_push_back_if_changed` around each exec, but the interactive
        # session lives for hours — without a poll the fresh blob only gets
        # pushed back at session close, and if the container restarts
        # before then the stale team-api record overwrites the file again.
        captured_owner = owner_id
        captured_user = agent_user

        def _persist_blob(blob: dict) -> None:
            if not captured_owner:
                # No owner → no team-api persistence; the per-agent HOME is
                # already on the volumed /app/data, so the local auth.json
                # survives restarts on its own.
                return
            ok = save_owner_blob(captured_owner, blob)
            if not ok:
                raise RuntimeError(f"save_owner_blob failed for owner {captured_owner}")

        def _creds_dedup_key(blob: dict) -> Optional[str]:
            tokens = (blob or {}).get("tokens") or {}
            if isinstance(tokens, dict):
                return tokens.get("access_token")
            return None

        creds_watch_path = auth_file_path(captured_user) if captured_user else os.path.expanduser("~/.codex/auth.json")

        return {
            "cmd": cmd,
            "cwd": cwd,
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
            "creds_watch_path": creds_watch_path,
            "creds_on_change": _persist_blob,
            "creds_dedup_key": _creds_dedup_key,
        }

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        await super().startup()
        auth_json = os.path.expanduser("~/.codex/auth.json")
        if os.path.isfile(auth_json):
            try:
                with open(auth_json) as f:
                    blob = json.load(f)
                method = auth_method_for_blob(blob)
                if method == "oauth":
                    email = blob_account_email(blob) or "unknown"
                    plan = blob_plan_type(blob) or "unknown"
                    logger.info(f"  Auth: ChatGPT plan OAuth ({plan}, {email})")
                else:
                    logger.info("  Auth: ~/.codex/auth.json present (API key)")
            except (OSError, json.JSONDecodeError):
                logger.info("  Auth: ~/.codex/auth.json present but unreadable")
        elif os.getenv("OPENAI_API_KEY"):
            logger.info("  Auth: OPENAI_API_KEY (API credits)")
        else:
            logger.info(
                "  No auth configured for codex yet. Use POST /auth/login to start an OAuth "
                "flow, paste an auth.json via POST /auth/token, or set OPENAI_API_KEY. "
                "Falls back at exec time."
            )

    # ── Per-exec hydration + push-back ────────────────────────────────────

    async def run_sync(self, prompt, system_prompt=None, agent_id=None,
                       owner_id=None, task_id=None, session_id=None, messages=None):
        # Allow in-chat completion of a pending OAuth flow (mirrors the
        # claude-code paid backend): when the user just pasted a verification
        # code as their last message, exchange it before spawning the CLI.
        exchange_result = await try_exchange_code_from_prompt(prompt, agent_id=agent_id, owner_id=owner_id)
        if exchange_result is not None:
            if exchange_result.get("status") == "authenticated":
                return {
                    "status": "success",
                    "output": f"Codex authentication successful ({exchange_result.get('email','')}). You can now send your request.",
                }
            return {
                "status": "auth_required",
                "output": "",
                "error": exchange_result.get("message", "Token exchange failed."),
            }

        baseline_mtime = await self._hydrate_for_exec(agent_id, owner_id)
        try:
            return await super().run_sync(
                prompt, system_prompt=system_prompt, agent_id=agent_id,
                owner_id=owner_id, task_id=task_id, session_id=session_id,
                messages=messages,
            )
        finally:
            await self._push_back_if_changed(agent_id, owner_id, baseline_mtime)

    async def stream_events(self, prompt, system_prompt=None, agent_id=None,
                            owner_id=None, task_id=None, session_id=None,
                            messages=None) -> AsyncIterator[dict]:
        exchange_result = await try_exchange_code_from_prompt(prompt, agent_id=agent_id, owner_id=owner_id)
        if exchange_result is not None:
            if exchange_result.get("status") == "authenticated":
                yield {
                    "type": "result",
                    "content": f"Codex authentication successful ({exchange_result.get('email','')}). You can now send your request.",
                }
                return
            yield {
                "type": "error",
                "content": exchange_result.get("message", "Token exchange failed."),
            }
            return

        baseline_mtime = await self._hydrate_for_exec(agent_id, owner_id)
        try:
            async for event in super().stream_events(
                prompt, system_prompt=system_prompt, agent_id=agent_id,
                owner_id=owner_id, task_id=task_id, session_id=session_id,
                messages=messages,
            ):
                yield event
        finally:
            await self._push_back_if_changed(agent_id, owner_id, baseline_mtime)

    async def _hydrate_for_exec(self, agent_id: Optional[str], owner_id: Optional[str]) -> Optional[float]:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        # Pull the owner-shared blob from team-api into the agent's local
        # ~/.codex/auth.json (per-agent HOME). Same pattern as claude-code's
        # owner-token hydration.
        if owner_id:
            await hydrate_agent_auth(agent_user, owner_id)
        # Proactively refresh the access_token if it's about to expire so the
        # codex CLI doesn't burn the request seeing an expired JWT. Mirrors
        # the claude-code paid backend's refresh_owner_token() path.
        blob, _ = read_local_auth(agent_user)
        if isinstance(blob, dict) and auth_method_for_blob(blob) == "oauth" and is_blob_expired(blob):
            new_blob = await refresh_blob(blob)
            if new_blob:
                try:
                    write_local_auth(agent_user, new_blob)
                except OSError as e:
                    logger.warning(f"[Codex Auth] refresh ok but write_local_auth failed: {e}")
                if owner_id:
                    save_owner_blob(owner_id, new_blob)
                logger.info("[Codex Auth] Refreshed access_token via refresh_token grant")
            else:
                logger.warning("[Codex Auth] Token expired and refresh failed — codex may prompt for re-login")
        _, mtime = read_local_auth(agent_user)
        return mtime

    async def _push_back_if_changed(self, agent_id: Optional[str],
                                    owner_id: Optional[str],
                                    baseline_mtime: Optional[float]) -> None:
        if not owner_id:
            return
        try:
            agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
            await push_agent_auth_if_changed(agent_user, owner_id, baseline_mtime)
        except Exception as e:
            logger.warning(f"[Codex Auth] push-back failed for owner {owner_id}: {e}")

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

    # ── Auth: global ──────────────────────────────────────────────────────

    async def auth_status(self) -> dict:
        method = global_auth_method()
        blob, _ = read_local_auth(None)
        if method == "oauth" and isinstance(blob, dict):
            return {
                "authenticated": True,
                "method": "oauth",
                "expired": is_blob_expired(blob),
                "email": blob_account_email(blob),
                "subscription": blob_plan_type(blob),
            }
        return {"authenticated": method != "none", "method": method}

    async def auth_login_url(self) -> Optional[str]:
        # Reuse the owner-flow store keyed by a sentinel id so a global flow
        # is still resumable across HTTP calls.
        return initiate_owner_login("__global__")

    async def auth_set_token(self, token: str) -> None:
        """Accepts either a full auth.json JSON blob or a raw access_token.
        Writes to ~/.codex/auth.json (used as the server-wide default)."""
        blob = parse_blob_input(token)
        write_local_auth(None, blob)
        logger.info("[Codex Auth] Saved global auth.json from /auth/token request")

    # ── Auth: per-owner ───────────────────────────────────────────────────

    async def owner_auth_status(self, owner_id: str) -> dict:
        blob = load_owner_blob(owner_id)
        if not isinstance(blob, dict):
            return {"authenticated": False, "owner_id": owner_id}
        method = auth_method_for_blob(blob)
        if method == "none":
            return {"authenticated": False, "owner_id": owner_id}
        return {
            "authenticated": True,
            "method": method,
            "expired": is_blob_expired(blob) if method == "oauth" else False,
            "owner_id": owner_id,
            "email": blob_account_email(blob),
            "subscription": blob_plan_type(blob),
        }

    async def owner_auth_login_url(self, owner_id: str) -> Optional[str]:
        blob = load_owner_blob(owner_id)
        if isinstance(blob, dict) and auth_method_for_blob(blob) == "oauth" and not is_blob_expired(blob):
            return None
        flow = get_owner_oauth_flow(owner_id)
        if flow:
            return flow["auth_url"]
        return initiate_owner_login(owner_id)

    async def owner_auth_callback(self, owner_id: str, code: str) -> dict:
        return await exchange_owner_code(owner_id, code)

    async def owner_set_token(self, owner_id: str, token: str) -> None:
        blob = parse_blob_input(token)
        if not save_owner_blob(owner_id, blob):
            raise RuntimeError("Failed to persist owner auth blob (team-api unreachable)")

    # ── Auth: per-agent ───────────────────────────────────────────────────

    async def agent_auth_status(self, agent_id: str) -> dict:
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            return {"authenticated": False, "agent_id": agent_id, "error": "Failed to resolve agent user"}
        # If the agent has an owner, the owner blob is authoritative.
        owner_id = agent_user.get("owner_id")
        if owner_id:
            blob = load_owner_blob(owner_id)
        else:
            blob, _ = read_local_auth(agent_user)
        if not isinstance(blob, dict):
            return {"authenticated": False, "agent_id": agent_id}
        method = auth_method_for_blob(blob)
        if method == "none":
            return {"authenticated": False, "agent_id": agent_id}
        return {
            "authenticated": True,
            "method": method,
            "expired": is_blob_expired(blob) if method == "oauth" else False,
            "agent_id": agent_id,
            "email": blob_account_email(blob),
            "subscription": blob_plan_type(blob),
        }

    async def agent_auth_login_url(self, agent_id: str) -> Optional[str]:
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            return None
        owner_id = agent_user.get("owner_id")
        if owner_id:
            blob = load_owner_blob(owner_id)
        else:
            blob, _ = read_local_auth(agent_user)
        if isinstance(blob, dict) and auth_method_for_blob(blob) == "oauth" and not is_blob_expired(blob):
            return None
        flow = get_agent_oauth_flow(agent_id)
        if flow:
            return flow["auth_url"]
        return initiate_agent_login(agent_id)

    async def agent_auth_callback(self, agent_id: str, code: str) -> dict:
        agent_user = await ensure_agent_user(agent_id)
        owner_id = agent_user.get("owner_id") if agent_user else None
        return await exchange_agent_code(agent_id, code, owner_id=owner_id)

    async def agent_set_token(self, agent_id: str, token: str) -> None:
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            raise RuntimeError("Failed to resolve agent user")
        blob = parse_blob_input(token)
        owner_id = agent_user.get("owner_id")
        if owner_id:
            if not save_owner_blob(owner_id, blob):
                raise RuntimeError("Failed to persist agent auth blob (team-api unreachable)")
        else:
            write_local_auth(agent_user, blob)
