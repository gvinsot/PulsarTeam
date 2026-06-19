"""
Claude Code backend — wraps the Claude Code CLI (interactive PTY mode).

Implements RunnerBackend by spawning `claude` subprocesses with --resume
session persistence keyed by (agent_id, task_id).
"""

import os
import json
import time
import uuid
import shutil
import asyncio
import subprocess
from typing import AsyncIterator, Optional

from config import (
    RUNNER_MODEL, RUNNER_MAX_TURNS, CLI_CWD, TIMEOUT,
    PROJECTS_DIR, ALLOWED_TOOLS, SYSTEM_PROMPT, VERBOSE,
    OAUTH_CLIENT_ID, OAUTH_REDIRECT_URI,
    logger,
)
from agent_user import ensure_agent_user, get_agent_project_dir
from .base import RunnerBackend
from .claude_token_store import (
    get_agent_env, get_subprocess_kwargs,
    load_saved_token, get_saved_refresh_token,
    save_agent_token, save_owner_token, save_token,
    resolve_token, seed_credentials_file, seed_onboarding_state,
    is_token_expired, is_agent_token_expired, is_owner_token_expired,
    load_owner_token, load_agent_token,
    get_token_cooldown_until,
    refresh_oauth_token, refresh_agent_token,
    auth_method, claude_auth_status,
    run_blocking,
)
from .claude_oauth import (
    try_exchange_code_from_prompt,
    get_login_url, get_auth_url, set_auth_url,
    initiate_agent_login, initiate_owner_login,
    get_agent_oauth_flow, pop_agent_oauth_flow,
    get_owner_oauth_flow, pop_owner_oauth_flow,
    token_http_request,
)
from .claude_interactive import run_interactive
from .runner_mcp_config import configure_claude_mcp, claude_mcp_config_path
from .runner_instructions_config import configure_claude_instructions


# Sentinel printed by the Claude CLI on stdout (as plain text, NOT a stream-json
# event) when `--resume <uuid>` cannot find a matching session JSONL on disk.
# Happens when the session was minted by a different runner container/node and
# the local volume (per-node, not shared) doesn't have it. Detecting this lets
# us fall back to a fresh session + full history replay instead of surfacing
# the raw CLI error to the user and keeping the stale UUID persisted.
RESUME_MISS_SENTINEL = "No conversation found with session ID"


def _spawn_diagnostic(proc_cwd: str, agent_user: Optional[dict]) -> str:
    """One-line diagnostic printed before each `claude` subprocess spawn so
    EACCES failures (cwd not traversable, binary not executable, …) can be
    pinpointed without attaching a debugger."""
    target_uid = agent_user.get("uid") if agent_user else os.getuid()
    parts = [f"cwd={proc_cwd}", f"target_uid={target_uid}"]
    try:
        st = os.stat(proc_cwd)
        parts.append(f"cwd_mode={oct(st.st_mode & 0o777)} cwd_uid={st.st_uid} cwd_gid={st.st_gid}")
    except OSError as e:
        parts.append(f"cwd_stat_err={e}")
    claude_bin = shutil.which("claude")
    if claude_bin:
        try:
            st = os.stat(claude_bin)
            parts.append(f"claude_bin={claude_bin} mode={oct(st.st_mode & 0o777)} bin_uid={st.st_uid}")
        except OSError as e:
            parts.append(f"claude_bin={claude_bin} stat_err={e}")
    else:
        parts.append("claude_bin=NOT_FOUND_IN_PATH")
    return " ".join(parts)


def _cwd_path_diagnostic(proc_cwd: str) -> str:
    """Walk every component of `proc_cwd` and report mode/owner so we can see
    which intermediate dir is blocking the dropped UID from chdir-ing in."""
    parts: list[str] = []
    components: list[str] = []
    p = os.path.abspath(proc_cwd)
    while True:
        components.insert(0, p)
        parent = os.path.dirname(p)
        if parent == p:
            break
        p = parent
    for c in components:
        try:
            st = os.stat(c)
            parts.append(f"{c}=mode={oct(st.st_mode & 0o777)},uid={st.st_uid},gid={st.st_gid}")
        except OSError as e:
            parts.append(f"{c}=stat_err={e.errno}")
    return " | ".join(parts)


class ClaudeCodeBackend(RunnerBackend):
    name = "claude-code"
    supports_agent = True
    supports_oauth_login = True
    supports_token_set = True
    supports_interactive_terminal = True

    def __init__(self):
        self._permissions: dict[str, dict] = {}

    # ── Interactive terminal recipe ───────────────────────────────────────

    async def prepare_interactive(self, agent_id, owner_id=None) -> dict:
        """Provision the agent's HOME + hydrate auth + build the CLI argv
        for a shared interactive PTY session.

        This is the same setup as a one-shot `run_sync`/`stream_events`
        except we don't supply a `--session-id` or system prompt — the
        user is driving the TUI themselves and the CLI manages its own
        session/history inside the agent's per-HOME `.claude` tree.
        """
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        # Use the same auth gate as the headless path so an expired stored
        # token is refreshed before we seed ~/.claude/.credentials.json for
        # the TUI. If there is genuinely no token, keep spawning the terminal:
        # the user still needs a live TUI to run /login.
        gate = await self._ensure_auth(agent_user, agent_id)
        if gate:
            logger.warning(
                "[Interactive Auth] Starting Claude terminal without a usable "
                "persisted token for agent %s: %s",
                agent_id,
                gate.get("error"),
            )

        effective_user = await self._prepare_spawn(agent_id, agent_user)

        # Reuse _build_cmd to get the same flags as the chat path, but in
        # interactive mode (no session_id → no --resume; the user drives
        # session restoration via /resume inside the TUI if they want).
        cmd, proc_cwd = self._build_cmd(
            output_format="text",
            system_prompt=None,
            agent_id=agent_id,
            task_id=None,
            permissions=self._get_permissions(agent_id),
            agent_user=effective_user,
            session_id=None,
            is_resume=False,
        )
        env = await run_blocking(get_agent_env, effective_user)
        kwargs = get_subprocess_kwargs(effective_user) or {}

        # Reverse-sync hook: when the user runs `/login` inside the TUI, the
        # CLI writes a fresh token to `<HOME>/.claude/.credentials.json`. The
        # PTY session polls that file and calls this callable on change so
        # the new token gets persisted to the team-api DB (or the local
        # store). Without it, `seed_credentials_file` would overwrite the
        # fresh file at every restart from the stale DB record, forcing the
        # user to /login again every time the container is recycled.
        captured_user = effective_user

        def _persist_creds(creds: dict) -> None:
            oauth = (creds or {}).get("claudeAiOauth") or {}
            access = oauth.get("accessToken")
            if not access:
                return
            refresh = oauth.get("refreshToken") or ""
            expires_at_ms = oauth.get("expiresAt") or 0
            if expires_at_ms:
                expires_in = max(60, int((expires_at_ms / 1000) - time.time()))
            else:
                expires_in = 28800
            owner = (captured_user or {}).get("owner_id")
            # Raise on persistence failure so PtySession's creds watcher
            # doesn't mark the token as synced — next poll retries instead
            # of leaving the stale DB record in place. save_owner_token /
            # save_agent_token return False on HTTP failure without raising,
            # so we translate that into an exception here.
            if owner:
                ok = save_owner_token(owner, access, refresh_token=refresh, expires_in=expires_in)
                if not ok:
                    raise RuntimeError(f"save_owner_token failed for owner {owner}")
            elif captured_user:
                ok = save_agent_token(captured_user, access, refresh_token=refresh, expires_in=expires_in)
                if not ok:
                    raise RuntimeError(f"save_agent_token failed for {captured_user.get('username')}")
            else:
                save_token(access, refresh_token=refresh, expires_in=expires_in)

        # In runAsRoot mode effective_user is None and the CLI writes to
        # /root/.claude/.credentials.json. Watch that too — `_persist_creds`
        # falls through to `save_token` (global store, persisted under
        # /app/data which IS volumed).
        home = (effective_user or {}).get("home") if effective_user else os.path.expanduser("~")
        creds_watch_path = os.path.join(home, ".claude", ".credentials.json") if home else None

        def _creds_dedup_key(creds: dict) -> Optional[str]:
            return ((creds or {}).get("claudeAiOauth") or {}).get("accessToken")

        return {
            "cmd": cmd,
            "cwd": proc_cwd,
            "env": env,
            "preexec_fn": kwargs.get("preexec_fn"),
            # Server-side "snapshot" rendering was abandoned (it garbled Claude
            # Code's TUI); the PTY bytes stream raw to xterm.js which renders them.
            "creds_watch_path": creds_watch_path,
            "creds_on_change": _persist_creds,
            "creds_dedup_key": _creds_dedup_key,
        }

    async def interactive_preflight_auth(self, agent_id, owner_id=None) -> Optional[str]:
        """Fail a terminal task injection fast when there is genuinely no
        usable OAuth token for this owner/agent.

        Reuses the headless `_ensure_auth` gate (which bootstraps from the
        global token and proactively refreshes) so we only report an error
        when no token can be resolved at all — NOT for an expired-but-
        refreshable one. That is exactly the "Please run /login" / login-screen
        state where the interactive CLI would swallow the pasted prompt and go
        quiet, which the workflow otherwise misreads as a finished task.
        """
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        gate = await self._ensure_auth(agent_user, agent_id)
        return gate.get("error") if gate else None

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        logger.info("Claude Code backend starting...")
        logger.info(f"  Model: {RUNNER_MODEL}")
        logger.info(f"  Max turns: {RUNNER_MAX_TURNS}")
        logger.info(f"  Timeout: {TIMEOUT}s")
        logger.info(f"  Projects dir: {PROJECTS_DIR}")
        logger.info("  CLI mode: interactive (PTY, subscription pricing)")

        try:
            result = subprocess.run(["claude", "--version"], capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                logger.info(f"  Claude Code CLI: {result.stdout.strip()}")
            else:
                logger.error(f"  Claude Code CLI error: {result.stderr.strip()}")
        except FileNotFoundError:
            logger.error("  Claude Code CLI not found! Install with: npm install -g @anthropic-ai/claude-code")
        except Exception as e:
            logger.error(f"  Claude Code CLI check failed: {e}")

        saved = load_saved_token()
        if saved and not os.environ.get("CLAUDE_CODE_OAUTH_TOKEN"):
            os.environ["CLAUDE_CODE_OAUTH_TOKEN"] = saved
            logger.info("  Loaded saved OAuth token from persistent storage")

        cli_status = claude_auth_status()
        if cli_status.get("loggedIn"):
            logger.info(f"  Auth: {cli_status.get('authMethod', 'unknown')} "
                        f"({cli_status.get('subscriptionType', 'unknown')} plan, "
                        f"{cli_status.get('email', 'no email')})")
        else:
            method = auth_method()
            if method == "oauth":
                logger.info("  Auth: OAuth token (subscription plan)")
            elif method == "api_key":
                logger.info("  Auth: API key (API credits)")
            else:
                logger.warning("  No auth configured! Use POST /auth/login or /auth/token, or set CLAUDE_CODE_OAUTH_TOKEN env var.")

    # ── Health ────────────────────────────────────────────────────────────

    def health(self) -> dict:
        try:
            result = subprocess.run(
                ["claude", "--version"],
                capture_output=True, text=True, timeout=10,
            )
            ok = result.returncode == 0
            version = result.stdout.strip() if ok else None
        except Exception:
            ok = False
            version = None

        return {
            "status": "healthy" if ok else "degraded",
            "backend": self.name,
            "claude_version": version,
            "claude_model": RUNNER_MODEL,
        }

    # ── Permissions ───────────────────────────────────────────────────────

    def set_agent_permissions(self, agent_id: str, permissions: dict) -> None:
        if agent_id and permissions:
            self._permissions[agent_id] = permissions

    def _get_permissions(self, agent_id: Optional[str]) -> Optional[dict]:
        if not agent_id:
            return None
        return self._permissions.get(agent_id)

    def _resolve_effective_user(
        self, agent_id: Optional[str], agent_user: Optional[dict],
    ) -> Optional[dict]:
        """Honor the linuxUser.runAsRoot toggle from the agent's permissions.

        When the toggle is on, return None so the spawn inherits the server's
        root UID (no preexec_fn drop, no per-agent HOME isolation). When off
        (default), return the resolved agent_user unchanged.
        """
        perms = self._get_permissions(agent_id) or {}
        run_as_root = bool((perms.get("linuxUser") or {}).get("runAsRoot", False))
        if run_as_root:
            if agent_user:
                logger.info(
                    f"[Agent {agent_id[:12] if agent_id else 'unknown'}] "
                    "linuxUser.runAsRoot=true — spawning claude as root (UID drop disabled)"
                )
            return None
        return agent_user

    def _apply_permissions_to_settings(
        self, agent_user: Optional[dict], permissions: Optional[dict],
    ) -> None:
        """Translate the agent's permissions object into the native Claude Code
        deny rules in `~/.claude/settings.json` so the CLI enforces them.

        Also seeds onboarding defaults (`theme`) so the Claude Code TUI doesn't
        show its first-run theme picker. That screen contains none of the
        `_INPUT_READY_HINTS` the PTY driver waits for, so without this seed
        the user prompt would never be sent and every turn would hard-timeout.

        Mapping (only `False`/restrictive values produce deny rules; defaults
        keep the toggle's ON state, i.e. no extra restriction):
          - execution.shellAccess=False        → deny Bash
          - filesystem.readAccess=False        → deny Read, Glob, Grep
          - filesystem.writeAccess=False       → deny Write, Edit, NotebookEdit
          - filesystem.restrictedPaths=[...]   → deny Read/Edit/Write under each path
          - network.internetAccess=False       → deny WebFetch/WebSearch + curl/wget/git/etc.
          - network.allowedDomains=[a, b, ...] → allow WebFetch(domain:a/b/...) + deny WebFetch

        Skipped when there's no per-agent HOME (e.g. runAsRoot=true) — the CLI
        will then read the server's global settings unchanged.
        """
        if not agent_user:
            return
        home = agent_user.get("home")
        if not home:
            return
        settings_path = os.path.join(home, ".claude", "settings.json")
        try:
            with open(settings_path) as f:
                settings = json.load(f)
        except (OSError, json.JSONDecodeError):
            settings = {}

        # Onboarding seed: skip the first-run theme picker.
        if not settings.get("theme"):
            settings["theme"] = "dark"

        deny: list[str] = []
        allow: list[str] = []

        if permissions:
            fs = (permissions.get("filesystem") or {})
            if fs.get("readAccess", True) is False:
                deny.extend(["Read", "Glob", "Grep"])
            if fs.get("writeAccess", True) is False:
                deny.extend(["Write", "Edit", "NotebookEdit"])
            for raw_path in (fs.get("restrictedPaths") or []):
                path = (raw_path or "").rstrip("/")
                if not path:
                    continue
                for tool in ("Read", "Edit", "Write", "Glob", "Grep"):
                    deny.append(f"{tool}({path})")
                    deny.append(f"{tool}({path}/**)")

            execn = (permissions.get("execution") or {})
            if execn.get("shellAccess", True) is False:
                deny.append("Bash")

            net = (permissions.get("network") or {})
            if net.get("internetAccess", True) is False:
                deny.extend(["WebFetch", "WebSearch"])
                # Block the common shell-level network ops as well so the CLI can't
                # bypass WebFetch via Bash. Only effective when shellAccess is True
                # (otherwise Bash is already fully denied above).
                for cmd in ("curl", "wget", "git", "npm", "pnpm", "yarn", "pip",
                            "apt", "apt-get", "ssh", "scp", "rsync"):
                    deny.append(f"Bash({cmd}:*)")
            else:
                domains = net.get("allowedDomains") or []
                if domains:
                    for d in domains:
                        d = (d or "").strip()
                        if d:
                            allow.append(f"WebFetch(domain:{d})")
                    # Catch-all deny for any other domain — allow rules win.
                    deny.append("WebFetch")

        if deny or allow:
            perms_block = settings.setdefault("permissions", {})
            if deny:
                existing = perms_block.get("deny") or []
                perms_block["deny"] = list(dict.fromkeys(existing + deny))
            if allow:
                existing = perms_block.get("allow") or []
                perms_block["allow"] = list(dict.fromkeys(existing + allow))

        try:
            os.makedirs(os.path.dirname(settings_path), exist_ok=True)
            with open(settings_path, "w") as f:
                json.dump(settings, f, indent=2)
            uid = agent_user.get("uid")
            gid = agent_user.get("gid", uid)
            if uid is not None:
                try:
                    os.chown(settings_path, uid, gid)
                    os.chmod(settings_path, 0o600)
                except OSError:
                    pass
        except OSError as e:
            logger.warning(f"[Permissions] Failed to write {settings_path}: {e}")

    # ── Prompt strategy helpers ───────────────────────────────────────────

    @staticmethod
    def _extract_resume_prompt(messages: Optional[list], fallback: str) -> str:
        """Return the prompt to feed when --resume is in effect.

        With --resume, prior turns are loaded from the CLI's local JSONL,
        so we only want to send the new user message. The route hander
        passes us the full-history `fallback` prompt and the structured
        `messages` list — pull the latest user content from there.
        """
        if not messages:
            return fallback
        for msg in reversed(messages):
            role = getattr(msg, "role", None) or (msg.get("role") if isinstance(msg, dict) else None)
            if role == "user":
                content = getattr(msg, "content", None) or (msg.get("content") if isinstance(msg, dict) else None)
                if content:
                    return content
        return fallback

    # ── Command builder ───────────────────────────────────────────────────

    def _build_cmd(
        self,
        output_format: str = "json",
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        permissions: Optional[dict] = None,
        agent_user: Optional[dict] = None,
        session_id: Optional[str] = None,
        is_resume: bool = False,
    ) -> tuple[list[str], str]:
        exec_perms = (permissions or {}).get("execution", {})
        skip_permissions = exec_perms.get("dangerousSkipPermissions", True)
        # The Claude CLI hard-refuses --dangerously-skip-permissions when it
        # would run with euid=0. If agent_user is missing or resolved to the
        # parent UID (which is root in this container), the preexec_fn that
        # drops privileges won't fire — drop the flag so the CLI starts at
        # all. The CLI will prompt-for-permission instead of skipping, which
        # is the safe fallback.
        spawn_uid = (agent_user or {}).get("uid")
        if skip_permissions and (spawn_uid is None or spawn_uid == 0 or spawn_uid == os.getuid()):
            skip_permissions = False
            logger.warning(
                "[Spawn] Dropping --dangerously-skip-permissions: subprocess would run as root "
                "(claude CLI refuses this combination). Check agent_user provisioning — "
                f"agent_id={agent_id[:12] if agent_id else None} spawn_uid={spawn_uid} parent_uid={os.getuid()}"
            )

        cmd = [
            "claude",
            "--model", RUNNER_MODEL,
            "--effort", "high",
        ]
        if skip_permissions:
            cmd.append("--dangerously-skip-permissions")

        # MCP servers. Claude Code ignores `mcpServers` in settings.json, so the
        # agent's server map (written by configure_claude_mcp) is loaded via
        # --mcp-config; --strict-mcp-config makes it the SINGLE source so the
        # Pulsar Gateway (task control + dynamic MCP proxy) is guaranteed present
        # and no stray project .mcp.json bypasses it. Skipped when there is no
        # per-agent HOME (runAsRoot / global terminal) or the file was not written.
        home = (agent_user or {}).get("home")
        if home:
            mcp_cfg = claude_mcp_config_path(home)
            if os.path.isfile(mcp_cfg):
                cmd.extend(["--mcp-config", mcp_cfg, "--strict-mcp-config"])

        if agent_id and session_id:
            if is_resume:
                cmd.extend(["--resume", session_id])
                logger.info(f"[Session] Resuming session {session_id[:12]}... for agent {agent_id[:12]} (task={task_id[:12] if task_id else 'none'})")
            else:
                cmd.extend(["--session-id", session_id])
                logger.info(f"[Session] New session {session_id[:12]}... for agent {agent_id[:12]} (task={task_id[:12] if task_id else 'none'})")

        sp = system_prompt or SYSTEM_PROMPT
        if sp:
            cmd.extend(["--append-system-prompt", sp])

        if VERBOSE:
            cmd.append("--verbose")

        if ALLOWED_TOOLS:
            for tool in ALLOWED_TOOLS.split(","):
                tool = tool.strip()
                if tool:
                    cmd.extend(["--allowedTools", tool])

        agent_project_dir = get_agent_project_dir(agent_id) if agent_id else None
        if agent_project_dir and os.path.isdir(agent_project_dir):
            cwd = agent_project_dir
        else:
            cwd = CLI_CWD
            if agent_id:
                logger.warning(
                    f"[Cwd] No project dir resolved for agent {agent_id[:12]} — "
                    f"falling back to {CLI_CWD}. Likely the API did not call "
                    f"/projects/ensure (cache desync after runner restart) or "
                    f"the per-agent data volume is missing the cloned tree."
                )
            if os.path.isdir(PROJECTS_DIR):
                cmd.extend(["--add-dir", PROJECTS_DIR])

        return cmd, cwd

    # ── Shared auth-bootstrap / spawn-prep helpers ────────────────────────

    async def _bootstrap_owner_token(self, agent_user: Optional[dict]) -> None:
        """Seed the per-owner (or per-agent) token record from the global
        token when it is still empty — first spawn after a fresh deploy."""
        if not agent_user:
            return
        if await run_blocking(resolve_token, agent_user):
            return
        global_token = load_saved_token()
        if not global_token:
            return
        global_refresh = get_saved_refresh_token()
        _owner_id = agent_user.get("owner_id")
        if _owner_id:
            await run_blocking(save_owner_token, _owner_id, global_token, refresh_token=global_refresh)
            logger.info(f"[Owner Auth] Bootstrapped owner {_owner_id} with global token")
        else:
            save_agent_token(agent_user, global_token, refresh_token=global_refresh)
            logger.info(f"[Agent Auth] Bootstrapped agent {agent_user['username']} with global token")

    async def _ensure_auth(self, agent_user: Optional[dict], agent_id: Optional[str]) -> Optional[dict]:
        """Gate a headless spawn on a usable token.

        Bootstraps the owner/agent record from the global token, proactively
        refreshes an expired token (subject to the refresh cooldown), and
        fails fast when no token exists at all — the claude CLI exits
        silently with rc=0 when spawned without credentials. Returns None
        when a usable token exists, otherwise an auth_required payload in
        run_sync's dict shape (stream_events adapts it into an error event).
        """
        cooldown = get_token_cooldown_until()
        await self._bootstrap_owner_token(agent_user)
        if agent_user:
            _owner_id = agent_user.get("owner_id")
            if await run_blocking(is_agent_token_expired, agent_user) and time.time() >= cooldown:
                refreshed = await refresh_agent_token(agent_user)
                if not refreshed:
                    who = f"owner {_owner_id}" if _owner_id else f"agent {agent_id}"
                    if not await run_blocking(resolve_token, agent_user):
                        logger.error(f"[Auth] No valid token for {who} — requiring re-authentication")
                        login_url = initiate_owner_login(_owner_id) if _owner_id else initiate_agent_login(agent_id)
                        return {
                            "status": "auth_required",
                            "output": "",
                            "error": f"OAuth token expired and refresh token is invalid. Please re-authenticate: {login_url}",
                            "login_url": login_url,
                        }
                    logger.warning(f"[Auth] Proactive token refresh failed for {who}, continuing with existing token...")
            # Final guard: if we still have no token after bootstrap, fail fast.
            # Without this, claude CLI exits silently with rc=0 and no output.
            if not await run_blocking(resolve_token, agent_user):
                who = f"owner {_owner_id}" if _owner_id else f"agent {agent_id}"
                logger.error(f"[Auth] No token available for {who} — cannot spawn Claude CLI")
                login_url = initiate_owner_login(_owner_id) if _owner_id else initiate_agent_login(agent_id)
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"No authentication token available. Please authenticate: {login_url}",
                    "login_url": login_url,
                }
        else:
            if is_token_expired() and time.time() >= cooldown:
                refreshed = await refresh_oauth_token()
                if not refreshed:
                    if not load_saved_token():
                        logger.error("[Auth] No valid global token — requiring re-authentication")
                        login_url = await get_login_url()
                        return {
                            "status": "auth_required",
                            "output": "",
                            "error": f"OAuth token expired and refresh token is invalid. Please re-authenticate: {login_url}",
                            "login_url": login_url,
                        }
                    logger.warning("[Auth] Proactive global token refresh failed, continuing with existing token...")
            # Final guard for the global / no-agent path as well.
            if not load_saved_token() and auth_method() == "none":
                logger.error("[Auth] No global token available — cannot spawn Claude CLI")
                login_url = await get_login_url()
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"No authentication token available. Please authenticate: {login_url}",
                    "login_url": login_url,
                }
        return None

    async def _prepare_spawn(self, agent_id: Optional[str], agent_user: Optional[dict]) -> Optional[dict]:
        """Per-spawn HOME/config prep shared by run_sync, stream_events and
        prepare_interactive. Returns the effective user (None in runAsRoot
        mode)."""
        # linuxUser.runAsRoot=true: skip the per-agent UID drop and let claude
        # run as the server's root UID. Off by default — when off, we keep the
        # dedicated agent UID resolved by ensure_agent_user.
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        await run_blocking(configure_claude_mcp, effective_user, agent_id)
        await run_blocking(configure_claude_instructions, effective_user, agent_id)
        # Translate permissions (network / filesystem / execution.shell) into
        # native Claude Code deny rules in the per-agent settings.json. Done
        # at every spawn so toggles take effect on the next message without
        # having to recreate the agent's HOME.
        self._apply_permissions_to_settings(effective_user, self._get_permissions(agent_id))
        # Mark onboarding as already completed in `.claude.json` so the TUI
        # skips its first-run theme picker / login-method picker / OAuth
        # flow — none of which the PTY driver can satisfy. The CLI normally
        # writes these flags after a successful interactive OAuth login.
        seed_onboarding_state(effective_user)
        # Seed `.claude/.credentials.json` as defense in depth alongside the
        # env-var token injection.
        await run_blocking(seed_credentials_file, effective_user)
        return effective_user

    # ── Synchronous execution ─────────────────────────────────────────────

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
        exchange_result = await try_exchange_code_from_prompt(prompt, agent_id=agent_id, owner_id=owner_id)
        if exchange_result is not None:
            if exchange_result.get("status") == "authenticated":
                return {
                    "status": "success",
                    "output": f"Authentication successful ({exchange_result.get('email', '')}). You can now send your request.",
                }
            return {
                "status": "auth_required",
                "output": "",
                "error": exchange_result.get("message", "Token exchange failed."),
            }

        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        gate = await self._ensure_auth(agent_user, agent_id)
        if gate:
            return gate

        agent_label = f" (user={agent_user['username']})" if agent_user else ""
        effective_user = await self._prepare_spawn(agent_id, agent_user)

        # Decide initial session strategy. If the caller handed us a
        # session_id, try to --resume it (fast path: prior turns live in
        # the CLI's local JSONL, so we only send the latest user message).
        # Otherwise mint a fresh UUID and send the full conversation as
        # the prompt so the model gets the same context regardless of
        # whether this runner has ever seen the agent before.
        replay_prompt = prompt  # already flattened by messages_to_prompt in routes_api
        current_session_id = session_id or str(uuid.uuid4())
        is_resume = bool(session_id)
        used_prompt = self._extract_resume_prompt(messages, prompt) if is_resume else replay_prompt

        async def _run_sync_proc(sid: str, resume: bool, p_prompt: str):
            cmd, proc_cwd = self._build_cmd(
                output_format="json", system_prompt=system_prompt,
                agent_id=agent_id, task_id=task_id,
                permissions=self._get_permissions(agent_id),
                agent_user=effective_user,
                session_id=sid, is_resume=resume,
            )
            logger.info(f"Executing Claude Code{agent_label} (prompt={len(p_prompt)}B, resume={resume}): {p_prompt[:100]}...")
            logger.debug(f"Command: {' '.join(cmd)} (cwd={proc_cwd})")
            logger.info(f"[Spawn] {_spawn_diagnostic(proc_cwd, effective_user)}")

            # Interactive TUI driven through a PTY. The driver handles
            # banner detection, prompt delivery, interactive Y/N prompts
            # (auto-answered or routed to a fallback LLM), and clean
            # shutdown. It returns a result dict compatible with the
            # synthesised (proc, stdout, stderr) tuple this closure
            # historically produced.
            _subp_kwargs = get_subprocess_kwargs(effective_user) or {}
            preexec_fn = _subp_kwargs.get("preexec_fn")
            spawn_env = await run_blocking(get_agent_env, effective_user)
            try:
                interactive_result = await asyncio.wait_for(
                    run_interactive(
                        cmd=cmd, cwd=proc_cwd,
                        env=spawn_env,
                        prompt=p_prompt, preexec_fn=preexec_fn,
                    ),
                    timeout=TIMEOUT,
                )
            except PermissionError as spawn_err:
                logger.error(f"[Spawn] PermissionError driving claude (cwd={proc_cwd}): {spawn_err}")
                raise RuntimeError(f"Permission denied spawning claude CLI (cwd={proc_cwd}).") from spawn_err

            class _FakeProc:
                pass
            fp = _FakeProc()
            fp.returncode = interactive_result.get("returncode") or 0
            # Wrap the textual reply into the JSON envelope shape the parser
            # below expects.
            payload = {
                "result": interactive_result.get("output", ""),
                "cost_usd": 0,
                "duration_ms": 0,
                "usage": {"input_tokens": 0, "output_tokens": 0},
                "total_tokens": 0,
            }
            so_b = json.dumps(payload).encode("utf-8")
            se_b = (interactive_result.get("stderr") or "").encode("utf-8")
            return fp, so_b, se_b

        proc = None
        try:
            try:
                proc, stdout_bytes, stderr_bytes = await _run_sync_proc(current_session_id, is_resume, used_prompt)
            except BrokenPipeError:
                if is_resume:
                    logger.warning(f"[Session] --resume {current_session_id[:12]} failed for agent {agent_id[:12] if agent_id else '?'} — falling back to fresh session with full history replay")
                    current_session_id = str(uuid.uuid4())
                    is_resume = False
                    used_prompt = replay_prompt
                    proc, stdout_bytes, stderr_bytes = await _run_sync_proc(current_session_id, False, used_prompt)
                else:
                    raise
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

        combined = f"{stdout} {stderr}".lower()
        if "token has expired" in combined or ("authentication_error" in combined and "401" in combined):
            if agent_user:
                logger.warning(f"Agent {agent_user['username']} auth error: token expired, attempting refresh...")
                refreshed = await refresh_agent_token(agent_user)
                if refreshed:
                    logger.info("Agent token refreshed, retrying request...")
                    return await self.run_sync(prompt, system_prompt, agent_id=agent_id, owner_id=owner_id, task_id=task_id, session_id=session_id, messages=messages)
                login_url = initiate_owner_login(agent_user['owner_id']) if agent_user.get('owner_id') else initiate_agent_login(agent_id)
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                    "login_url": login_url,
                }
            else:
                logger.warning("Claude Code auth error: token expired, attempting refresh...")
                refreshed = await refresh_oauth_token()
                if refreshed:
                    logger.info("Token refreshed, retrying request...")
                    return await self.run_sync(prompt, system_prompt, task_id=task_id, session_id=session_id, messages=messages)
                login_url = await get_login_url()
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                    "login_url": login_url,
                }

        if "not logged in" in combined:
            if agent_user:
                logger.warning(f"Agent {agent_user['username']} not logged in")
                login_url = initiate_owner_login(agent_user['owner_id']) if agent_user.get('owner_id') else initiate_agent_login(agent_id)
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"Not authenticated. Please re-authenticate: {login_url}",
                    "login_url": login_url,
                }
            logger.warning("Claude Code auth error: not logged in, initiating login flow...")
            login_url = await get_login_url()
            if login_url:
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"Not authenticated. Open this URL: {login_url} -- then send the verification code as your next message.",
                    "login_url": login_url,
                }
            return {
                "status": "auth_required",
                "output": "",
                "error": "Not authenticated. Call POST /auth/login to start, or POST a token to /auth/token.",
            }

        # The CLI sometimes emits the resume-miss sentinel on stderr (instead of
        # stdout) and exits non-zero. Catch that BEFORE the generic rc!=0 path
        # so we transparently fall back to a fresh session + replay instead of
        # surfacing the raw "No conversation found with session ID" to the user.
        if is_resume and (RESUME_MISS_SENTINEL in stdout or RESUME_MISS_SENTINEL in stderr):
            logger.warning(
                f"[Session] --resume {current_session_id[:12]} reported missing JSONL "
                f"('{RESUME_MISS_SENTINEL}') — retrying with fresh session + full history replay"
            )
            current_session_id = str(uuid.uuid4())
            try:
                proc, stdout_bytes, stderr_bytes = await _run_sync_proc(current_session_id, False, replay_prompt)
                stdout = stdout_bytes.decode("utf-8", errors="replace").strip()
                stderr = stderr_bytes.decode("utf-8", errors="replace").strip()
                if not stdout or RESUME_MISS_SENTINEL in stdout or RESUME_MISS_SENTINEL in stderr:
                    return {"status": "error", "output": "", "error": "Replay fallback produced no usable output", "session_id": current_session_id}
                is_resume = False
            except (BrokenPipeError, asyncio.TimeoutError) as e:
                return {"status": "error", "output": "", "error": f"Fallback replay failed: {e}", "session_id": current_session_id}

        if proc.returncode != 0 and not stdout:
            error_msg = stderr if stderr else f"Claude Code exited with code {proc.returncode}"
            logger.error(f"Claude Code error: {error_msg}")
            return {"status": "error", "output": "", "error": error_msg}

        if proc.returncode == 0 and not stdout:
            logger.warning(
                f"[Sync] Empty stdout from Claude CLI (rc=0, resume={is_resume}, "
                f"prompt={len(used_prompt)}B). stderr: {stderr[:300] if stderr else '<empty>'}"
            )
            # If the empty response came from --resume, the JSONL likely isn't
            # here (different runner, container recreated, ...). Retry once
            # with a fresh session and full history replay.
            if is_resume:
                logger.warning(f"[Session] --resume returned no output — retrying with fresh session + replay")
                current_session_id = str(uuid.uuid4())
                try:
                    proc, stdout_bytes, stderr_bytes = await _run_sync_proc(current_session_id, False, replay_prompt)
                    stdout = stdout_bytes.decode("utf-8", errors="replace").strip()
                    stderr = stderr_bytes.decode("utf-8", errors="replace").strip()
                    if not stdout:
                        return {"status": "error", "output": "", "error": "Empty response from Claude CLI (after replay fallback)", "session_id": current_session_id}
                    is_resume = False
                except (BrokenPipeError, asyncio.TimeoutError) as e:
                    return {"status": "error", "output": "", "error": f"Fallback replay failed: {e}", "session_id": current_session_id}
            else:
                return {"status": "error", "output": "", "error": "Empty response from Claude CLI", "session_id": current_session_id}

        try:
            parsed = json.loads(stdout)
            output_text = parsed.get("result", stdout)
            cost = parsed.get("cost_usd", 0)
            duration = parsed.get("duration_ms", 0)
            usage = parsed.get("usage", {}) or {}
            input_tokens = usage.get("input_tokens", 0) or 0
            output_tokens = usage.get("output_tokens", 0) or 0
            total_tokens = parsed.get("total_tokens", 0) or (input_tokens + output_tokens)

            if VERBOSE:
                logger.info(f"Claude Code completed: cost=${cost:.4f}, duration={duration}ms, tokens={total_tokens} (in={input_tokens}, out={output_tokens})")

            return {
                "status": "success",
                "output": output_text,
                "session_id": current_session_id,
                "cost_usd": cost,
                "duration_ms": duration,
                "total_tokens": total_tokens,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }
        except json.JSONDecodeError:
            return {"status": "success", "output": stdout, "session_id": current_session_id}

    # ── Streaming execution ───────────────────────────────────────────────

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
        exchange_result = await try_exchange_code_from_prompt(prompt, agent_id=agent_id, owner_id=owner_id)
        if exchange_result is not None:
            if exchange_result.get("status") == "authenticated":
                yield {
                    "type": "result",
                    "content": f"Authentication successful ({exchange_result.get('email', '')}). You can now send your request.",
                }
                return
            yield {
                "type": "error",
                "content": exchange_result.get("message", "Token exchange failed."),
            }
            return

        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id) if agent_id else None
        gate = await self._ensure_auth(agent_user, agent_id)
        if gate:
            yield {
                "type": "error",
                "content": gate["error"],
                "login_url": gate["login_url"],
            }
            return

        agent_label = f" (user={agent_user['username']})" if agent_user else ""
        effective_user = await self._prepare_spawn(agent_id, agent_user)

        # Same resume/replay strategy as run_sync. The route handler hands us
        # `prompt` already flattened from the full conversation history (it's
        # the replay-mode prompt) plus the structured `messages` list and the
        # optional `session_id` hint. We try --resume with just the latest
        # user message; on failure we fall back to a fresh session that
        # consumes the full replay prompt.
        replay_prompt = prompt
        current_session_id = session_id or str(uuid.uuid4())
        is_resume = bool(session_id)
        used_prompt = self._extract_resume_prompt(messages, prompt) if is_resume else replay_prompt

        # Drive the TUI through a PTY and surface the assistant's reply as a
        # single text event followed by a result event. Token-level streaming
        # isn't available without `-p`, but the cost trade-off (subscription
        # vs API pricing) is the whole point of this mode.
        cmd, proc_cwd = self._build_cmd(
            output_format="text", system_prompt=system_prompt,
            agent_id=agent_id, task_id=task_id,
            permissions=self._get_permissions(agent_id),
            agent_user=effective_user,
            session_id=current_session_id, is_resume=is_resume,
        )
        logger.info(f"Streaming Claude Code (interactive){agent_label} (prompt={len(used_prompt)}B, resume={is_resume}): {used_prompt[:100]}...")
        logger.info(f"[Spawn] {_spawn_diagnostic(proc_cwd, effective_user)}")
        _subp_kwargs = get_subprocess_kwargs(effective_user) or {}
        preexec_fn = _subp_kwargs.get("preexec_fn")

        # Bridge the executor-thread callback into the asyncio event loop
        # via a queue. The driver fires `on_event` from its thread for
        # each new fragment of Claude's reply; we marshal those into the
        # async generator's yield stream as `thinking` events so callers
        # can mirror real CLI activity to the terminal without inventing
        # placeholder text.
        loop = asyncio.get_running_loop()
        event_queue: asyncio.Queue = asyncio.Queue()

        def _push_event(ev: dict) -> None:
            loop.call_soon_threadsafe(event_queue.put_nowait, ev)

        spawn_env = await run_blocking(get_agent_env, effective_user)
        runner_task = asyncio.create_task(asyncio.wait_for(
            run_interactive(
                cmd=cmd, cwd=proc_cwd,
                env=spawn_env,
                prompt=used_prompt, preexec_fn=preexec_fn,
                on_event=_push_event,
            ),
            timeout=TIMEOUT,
        ))

        try:
            while True:
                # Race: either a streamed delta or the runner finishing.
                get_task = asyncio.create_task(event_queue.get())
                done, pending = await asyncio.wait(
                    {get_task, runner_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if get_task in done:
                    ev = get_task.result()
                    yield ev
                    # If the runner also finished on the same tick, fall
                    # through and drain the rest below; otherwise loop.
                    if runner_task not in done:
                        continue
                else:
                    # Runner finished while no delta was pending; cancel
                    # the parked get_task so it doesn't leak.
                    get_task.cancel()
                # Drain anything still queued before the final event.
                while not event_queue.empty():
                    try:
                        yield event_queue.get_nowait()
                    except asyncio.QueueEmpty:
                        break
                break

            result = runner_task.result()
        except asyncio.TimeoutError:
            runner_task.cancel()
            yield {"type": "error", "content": f"Claude CLI timed out after {TIMEOUT}s"}
            return
        except RuntimeError as e:
            yield {"type": "error", "content": str(e)}
            return

        output = (result.get("output") or "").strip()
        stderr_text = (result.get("stderr") or "").strip()
        rc = result.get("returncode")

        if output:
            yield {"type": "text", "content": output}
            yield {
                "type": "result",
                "content": output,
                "cost_usd": 0,
                "duration_ms": 0,
                "total_tokens": 0,
                "input_tokens": 0,
                "output_tokens": 0,
            }
            yield {"type": "session_id_used", "session_id": current_session_id}
            return

        # No output: surface stderr / non-zero rc rather than going silent.
        err_msg = stderr_text or f"Claude CLI returned no output (rc={rc})."
        yield {"type": "error", "content": err_msg}
        return

    # ── Auth ──────────────────────────────────────────────────────────────

    async def auth_status(self) -> dict:
        cli_status = claude_auth_status()
        if cli_status.get("loggedIn"):
            return {
                "authenticated": True,
                "method": cli_status.get("authMethod", "unknown"),
                "email": cli_status.get("email"),
                "subscription": cli_status.get("subscriptionType"),
            }
        method = auth_method()
        return {"authenticated": method != "none", "method": method}

    async def auth_login_url(self) -> Optional[str]:
        cli_status = claude_auth_status()
        if cli_status.get("loggedIn"):
            return None
        method = auth_method()
        if method != "none":
            return None
        cached = get_auth_url()
        if cached:
            return cached
        url = await get_login_url()
        set_auth_url(url)
        return url

    async def auth_set_token(self, token: str) -> None:
        save_token(token)

    # ── Per-agent auth ────────────────────────────────────────────────────

    async def agent_auth_status(self, agent_id: str) -> dict:
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            return {"authenticated": False, "error": "Failed to resolve agent user"}
        token = load_agent_token(agent_user)
        if token:
            expired = is_agent_token_expired(agent_user)
            return {"authenticated": True, "expired": expired, "agent_id": agent_id}
        return {"authenticated": False, "agent_id": agent_id}

    async def agent_auth_login_url(self, agent_id: str) -> Optional[str]:
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            return None
        token = load_agent_token(agent_user)
        if token and not is_agent_token_expired(agent_user):
            return None
        flow = get_agent_oauth_flow(agent_id)
        if flow:
            return flow["auth_url"]
        return initiate_agent_login(agent_id)

    async def _oauth_callback(
        self,
        flow: dict,
        code: str,
        exchange_desc: str,
        persist,
        pop,
        success_payload: dict,
    ) -> dict:
        """Shared code-exchange body for agent_auth_callback /
        owner_auth_callback: exchange the code, validate, persist via
        `persist(access, refresh, expires_in)` (returns False on persistence
        failure), pop the pending flow, and return `success_payload`."""
        payload = {
            "grant_type": "authorization_code",
            "client_id": OAUTH_CLIENT_ID,
            "code": code,
            "redirect_uri": OAUTH_REDIRECT_URI,
            "code_verifier": flow["code_verifier"],
        }
        result = await token_http_request(payload, exchange_desc)
        if not result:
            return {"status": "error", "message": "Token exchange failed"}
        access_token = result.get("access_token")
        if not access_token:
            return {"status": "error", "message": f"Token response missing access_token: {json.dumps(result)}"}
        refresh_token = result.get("refresh_token")
        expires_in = result.get("expires_in", 28800)
        if not persist(access_token, refresh_token, expires_in):
            return {"status": "error", "message": "Token exchange succeeded but persistence failed (team-api unreachable)."}
        pop()
        return success_payload

    async def agent_auth_callback(self, agent_id: str, code: str) -> dict:
        flow = get_agent_oauth_flow(agent_id)
        if not flow:
            return {"status": "error", "message": "No pending OAuth flow for this agent."}
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            return {"status": "error", "message": "Failed to resolve agent user"}
        return await self._oauth_callback(
            flow, code, f"agent {agent_id[:12]} code exchange",
            persist=lambda at, rt, exp: save_agent_token(agent_user, at, refresh_token=rt, expires_in=exp),
            pop=lambda: pop_agent_oauth_flow(agent_id),
            success_payload={"status": "authenticated", "agent_id": agent_id, "message": "Agent now has its own OAuth token."},
        )

    async def agent_set_token(self, agent_id: str, token: str) -> None:
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            raise RuntimeError("Failed to resolve agent user")
        if not save_agent_token(agent_user, token):
            raise RuntimeError("Failed to persist agent token (team-api unreachable)")

    # ── Per-owner auth ────────────────────────────────────────────────────

    async def owner_auth_status(self, owner_id: str) -> dict:
        token = load_owner_token(owner_id)
        if token:
            expired = is_owner_token_expired(owner_id)
            return {"authenticated": True, "expired": expired, "owner_id": owner_id}
        return {"authenticated": False, "owner_id": owner_id}

    async def owner_auth_login_url(self, owner_id: str) -> Optional[str]:
        token = load_owner_token(owner_id)
        if token and not is_owner_token_expired(owner_id):
            return None
        flow = get_owner_oauth_flow(owner_id)
        if flow:
            return flow["auth_url"]
        return initiate_owner_login(owner_id)

    async def owner_auth_callback(self, owner_id: str, code: str) -> dict:
        flow = get_owner_oauth_flow(owner_id)
        if not flow:
            return {"status": "error", "message": "No pending OAuth flow for this owner."}
        return await self._oauth_callback(
            flow, code, f"owner {owner_id} code exchange",
            persist=lambda at, rt, exp: save_owner_token(owner_id, at, refresh_token=rt, expires_in=exp),
            pop=lambda: pop_owner_oauth_flow(owner_id),
            success_payload={"status": "authenticated", "owner_id": owner_id, "message": "Owner now has an OAuth token shared by all their agents."},
        )

    async def owner_set_token(self, owner_id: str, token: str) -> None:
        if not save_owner_token(owner_id, token):
            raise RuntimeError("Failed to persist owner token (team-api unreachable)")
