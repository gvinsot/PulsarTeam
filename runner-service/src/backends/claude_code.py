"""
Claude Code backend — wraps the Claude Code CLI (headless mode).

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
    CLAUDE_MODEL, CLAUDE_MAX_TURNS, CLI_CWD, TIMEOUT,
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
    resolve_token,
    is_token_expired, is_agent_token_expired, is_owner_token_expired,
    load_owner_token, load_agent_token,
    get_token_cooldown_until,
    refresh_oauth_token, refresh_agent_token,
    auth_method, claude_auth_status,
)
from .claude_oauth import (
    try_exchange_code_from_prompt,
    get_login_url, get_auth_url, set_auth_url,
    initiate_agent_login, initiate_owner_login,
    get_agent_oauth_flow, pop_agent_oauth_flow,
    get_owner_oauth_flow, pop_owner_oauth_flow,
    token_http_request,
)


MAX_AUTH_RETRIES = 2


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

    def __init__(self):
        # session_key ("agent_id:task_id" or "agent_id") -> session UUID
        self._sessions: dict[str, str] = {}
        self._current_task: dict[str, str] = {}
        self._permissions: dict[str, dict] = {}

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        logger.info("Claude Code backend starting...")
        logger.info(f"  Model: {CLAUDE_MODEL}")
        logger.info(f"  Max turns: {CLAUDE_MAX_TURNS}")
        logger.info(f"  Timeout: {TIMEOUT}s")
        logger.info(f"  Projects dir: {PROJECTS_DIR}")

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
            "claude_model": CLAUDE_MODEL,
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

    # ── Sessions ──────────────────────────────────────────────────────────

    def reset_agent_sessions(self, agent_id: str, task_id: Optional[str] = None) -> int:
        removed = 0
        if not agent_id:
            return removed
        if task_id:
            session_key = f"{agent_id}:{task_id}"
            if session_key in self._sessions:
                old_session = self._sessions.pop(session_key)
                logger.info(f"[Session] Reset session for agent {agent_id[:12]} task {task_id[:12]} (was {old_session[:12]})")
                removed += 1
        if agent_id in self._sessions:
            self._sessions.pop(agent_id)
            removed += 1
        self._current_task.pop(agent_id, None)
        if not task_id:
            keys_to_remove = [k for k in self._sessions if k.startswith(f"{agent_id}:")]
            for k in keys_to_remove:
                self._sessions.pop(k)
                removed += 1
        return removed

    # ── Command builder ───────────────────────────────────────────────────

    def _select_session(
        self, agent_id: Optional[str], task_id: Optional[str],
    ) -> tuple[Optional[str], bool, Optional[str]]:
        """Pick session_id for this run without persisting new ones yet.

        Returns (session_id, is_new, session_key). New sessions are NOT stored
        in self._sessions until _commit_session is called — this avoids leaving
        a poisoned session id behind when a brand-new run produces no output.
        """
        if not agent_id:
            return None, False, None
        session_key = f"{agent_id}:{task_id}" if task_id else agent_id

        if task_id:
            prev_task = self._current_task.get(agent_id)
            if prev_task and prev_task != task_id:
                old_key = f"{agent_id}:{prev_task}"
                if old_key in self._sessions:
                    old_session = self._sessions.pop(old_key)
                    logger.info(f"[Session] Task changed for agent {agent_id[:12]}: {prev_task[:12]}→{task_id[:12]}, discarding old session {old_session[:12]}")
                self._sessions.pop(agent_id, None)
            self._current_task[agent_id] = task_id

        existing = self._sessions.get(session_key)
        if existing:
            return existing, False, session_key
        return str(uuid.uuid4()), True, session_key

    def _commit_session(self, session_key: Optional[str], session_id: Optional[str]) -> None:
        if session_key and session_id:
            self._sessions[session_key] = session_id

    def _build_cmd(
        self,
        output_format: str = "json",
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        task_id: Optional[str] = None,
        permissions: Optional[dict] = None,
        agent_user: Optional[dict] = None,
    ) -> tuple[list[str], str, Optional[str], bool, Optional[str]]:
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
            "-p",
            "--output-format", output_format,
            "--max-turns", str(CLAUDE_MAX_TURNS),
            "--model", CLAUDE_MODEL,
            "--effort", "high",
        ]
        if skip_permissions:
            cmd.append("--dangerously-skip-permissions")

        session_id, is_new, session_key = self._select_session(agent_id, task_id)
        if agent_id and session_id:
            if is_new:
                cmd.extend(["--session-id", session_id])
                logger.info(f"[Session] New session {session_id[:12]}... for agent {agent_id[:12]} (task={task_id[:12] if task_id else 'none'})")
            else:
                cmd.extend(["--resume", session_id])
                logger.info(f"[Session] Resuming session {session_id[:12]}... for agent {agent_id[:12]} (task={task_id[:12] if task_id else 'none'})")

        sp = system_prompt or SYSTEM_PROMPT
        if sp:
            cmd.extend(["--append-system-prompt", sp])

        if VERBOSE or output_format == "stream-json":
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
            if os.path.isdir(PROJECTS_DIR):
                cmd.extend(["--add-dir", PROJECTS_DIR])

        return cmd, cwd, session_id, is_new, session_key

    # ── Synchronous execution ─────────────────────────────────────────────

    async def run_sync(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
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
        cooldown = get_token_cooldown_until()

        if agent_user:
            _owner_id_sync = agent_user.get("owner_id")
            # Bootstrap from global token if agent has none yet (mirrors stream_events)
            if not resolve_token(agent_user):
                global_token = load_saved_token()
                if global_token:
                    global_refresh = get_saved_refresh_token()
                    if _owner_id_sync:
                        save_owner_token(_owner_id_sync, global_token, refresh_token=global_refresh)
                        logger.info(f"[Owner Auth] Bootstrapped owner {_owner_id_sync} with global token")
                    else:
                        save_agent_token(agent_user, global_token, refresh_token=global_refresh)
                        logger.info(f"[Agent Auth] Bootstrapped agent {agent_user['username']} with global token")
            if is_agent_token_expired(agent_user) and time.time() >= cooldown:
                refreshed = await refresh_agent_token(agent_user)
                if not refreshed and not resolve_token(agent_user):
                    login_url = initiate_owner_login(_owner_id_sync) if _owner_id_sync else initiate_agent_login(agent_id)
                    return {
                        "status": "auth_required",
                        "output": "",
                        "error": f"OAuth token expired and refresh token is invalid. Please re-authenticate: {login_url}",
                        "login_url": login_url,
                    }
            # Final guard: claude CLI exits silently with rc=0 if there's no token at all.
            if not resolve_token(agent_user):
                who = f"owner {_owner_id_sync}" if _owner_id_sync else f"agent {agent_id}"
                logger.error(f"[Auth] No token available for {who} — cannot spawn Claude CLI")
                login_url = initiate_owner_login(_owner_id_sync) if _owner_id_sync else initiate_agent_login(agent_id)
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"No authentication token available. Please authenticate: {login_url}",
                    "login_url": login_url,
                }
        else:
            if is_token_expired() and time.time() >= cooldown:
                refreshed = await refresh_oauth_token()
                if not refreshed and not load_saved_token():
                    login_url = await get_login_url()
                    return {
                        "status": "auth_required",
                        "output": "",
                        "error": f"OAuth token expired and refresh token is invalid. Please re-authenticate: {login_url}",
                        "login_url": login_url,
                    }
            if not load_saved_token() and auth_method() == "none":
                logger.error("[Auth] No global token available — cannot spawn Claude CLI")
                login_url = await get_login_url()
                return {
                    "status": "auth_required",
                    "output": "",
                    "error": f"No authentication token available. Please authenticate: {login_url}",
                    "login_url": login_url,
                }

        agent_label = f" (user={agent_user['username']})" if agent_user else ""

        # linuxUser.runAsRoot=true: skip the per-agent UID drop and let claude
        # run as the server's root UID. Off by default — when off, we keep the
        # dedicated agent UID resolved by ensure_agent_user.
        effective_user = self._resolve_effective_user(agent_id, agent_user)

        pending_session: dict = {"key": None, "id": None, "is_new": False}

        async def _run_sync_proc(aid: Optional[str]):
            cmd, proc_cwd, sid, is_new, skey = self._build_cmd(
                output_format="json", system_prompt=system_prompt,
                agent_id=aid, task_id=task_id,
                permissions=self._get_permissions(aid),
                agent_user=effective_user,
            )
            pending_session["key"] = skey
            pending_session["id"] = sid
            pending_session["is_new"] = is_new
            logger.info(f"Executing Claude Code{agent_label} (prompt={len(prompt)}B): {prompt[:100]}...")
            logger.debug(f"Command: {' '.join(cmd)} (cwd={proc_cwd})")
            logger.info(f"[Spawn] {_spawn_diagnostic(proc_cwd, effective_user)}")
            try:
                p = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=proc_cwd,
                    env=get_agent_env(effective_user),
                    **get_subprocess_kwargs(effective_user),
                )
            except PermissionError as spawn_err:
                logger.error(
                    f"[Spawn] PermissionError spawning claude (cwd={proc_cwd}, "
                    f"target_uid={effective_user.get('uid') if effective_user else os.getuid()}): {spawn_err}\n"
                    f"  path components: {_cwd_path_diagnostic(proc_cwd)}"
                )
                raise RuntimeError(
                    f"Permission denied spawning claude CLI (cwd={proc_cwd}). "
                    f"The dedicated agent UID likely can't traverse cwd or its parents — "
                    f"see runner-service logs for the per-component mode/owner dump."
                ) from spawn_err
            so, se = await asyncio.wait_for(
                p.communicate(input=prompt.encode("utf-8")),
                timeout=TIMEOUT,
            )
            return p, so, se

        proc = None
        try:
            try:
                proc, stdout_bytes, stderr_bytes = await _run_sync_proc(agent_id)
            except BrokenPipeError:
                session_key = f"{agent_id}:{task_id}" if agent_id and task_id else agent_id
                if session_key and session_key in self._sessions:
                    logger.warning(f"[Session] Resume failed for agent {agent_id[:12]} — creating new session")
                    self._sessions.pop(session_key, None)
                    proc, stdout_bytes, stderr_bytes = await _run_sync_proc(agent_id)
                else:
                    raise
        except asyncio.TimeoutError:
            if proc and proc.returncode is None:
                try:
                    proc.terminate()
                except ProcessLookupError:
                    pass
                else:
                    try:
                        await asyncio.wait_for(proc.wait(), timeout=5)
                    except asyncio.TimeoutError:
                        proc.kill()
            return {"status": "timeout", "output": "", "error": f"Execution timeout after {TIMEOUT}s"}
        except asyncio.CancelledError:
            if proc and proc.returncode is None:
                try:
                    proc.terminate()
                except ProcessLookupError:
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
                    return await self.run_sync(prompt, system_prompt, agent_id=agent_id, owner_id=owner_id)
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
                    return await self.run_sync(prompt, system_prompt)
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

        if proc.returncode != 0 and not stdout:
            error_msg = stderr if stderr else f"Claude Code exited with code {proc.returncode}"
            logger.error(f"Claude Code error: {error_msg}")
            return {"status": "error", "output": "", "error": error_msg}

        if proc.returncode == 0 and not stdout:
            logger.warning(
                f"[Sync] Empty stdout from Claude CLI (rc=0, was_resume={not pending_session['is_new']}, "
                f"prompt={len(prompt)}B). stderr: {stderr[:300] if stderr else '<empty>'}"
            )
            if pending_session["is_new"] and pending_session["key"]:
                # Don't poison future calls with a session that produced nothing
                self._sessions.pop(pending_session["key"], None)
            return {"status": "error", "output": "", "error": "Empty response from Claude CLI"}

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

            # Run produced output — safe to commit a freshly minted session id
            self._commit_session(pending_session["key"], pending_session["id"])

            return {
                "status": "success",
                "output": output_text,
                "cost_usd": cost,
                "duration_ms": duration,
                "total_tokens": total_tokens,
                "input_tokens": input_tokens,
                "output_tokens": output_tokens,
            }
        except json.JSONDecodeError:
            self._commit_session(pending_session["key"], pending_session["id"])
            return {"status": "success", "output": stdout}

    # ── Streaming execution ───────────────────────────────────────────────

    async def stream_events(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        _auth_retry: int = 0,
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
        cooldown = get_token_cooldown_until()

        _owner_id = agent_user.get("owner_id") if agent_user else None
        if agent_user:
            if not resolve_token(agent_user):
                global_token = load_saved_token()
                if global_token:
                    global_refresh = get_saved_refresh_token()
                    if _owner_id:
                        save_owner_token(_owner_id, global_token, refresh_token=global_refresh)
                        logger.info(f"[Owner Auth] Bootstrapped owner {_owner_id} with global token")
                    else:
                        save_agent_token(agent_user, global_token, refresh_token=global_refresh)
                        logger.info(f"[Agent Auth] Bootstrapped agent {agent_user['username']} with global token")
            if is_agent_token_expired(agent_user) and time.time() >= cooldown:
                refreshed = await refresh_agent_token(agent_user)
                if not refreshed:
                    who = f"owner {_owner_id}" if _owner_id else f"agent {agent_id}"
                    if not resolve_token(agent_user):
                        logger.error(f"[Auth] No valid token for {who} — requiring re-authentication")
                        if agent_user:
                            login_url = initiate_owner_login(_owner_id) if _owner_id else initiate_agent_login(agent_id)
                        else:
                            login_url = await get_login_url()
                        yield {
                            "type": "error",
                            "content": f"OAuth token expired and refresh token is invalid. Please re-authenticate: {login_url}",
                            "login_url": login_url,
                        }
                        return
                    logger.warning(f"[Auth] Proactive token refresh failed for {who}, continuing with existing token...")
            # Final guard: if we still have no token after bootstrap, fail fast.
            # Without this, claude CLI exits silently with rc=0 and no output.
            if not resolve_token(agent_user):
                who = f"owner {_owner_id}" if _owner_id else f"agent {agent_id}"
                logger.error(f"[Auth] No token available for {who} — cannot spawn Claude CLI")
                login_url = initiate_owner_login(_owner_id) if _owner_id else initiate_agent_login(agent_id)
                yield {
                    "type": "error",
                    "content": f"No authentication token available. Please authenticate: {login_url}",
                    "login_url": login_url,
                }
                return
        else:
            if is_token_expired() and time.time() >= cooldown:
                refreshed = await refresh_oauth_token()
                if not refreshed:
                    if not load_saved_token():
                        logger.error("[Auth] No valid global token — requiring re-authentication")
                        login_url = await get_login_url()
                        yield {
                            "type": "error",
                            "content": f"OAuth token expired and refresh token is invalid. Please re-authenticate: {login_url}",
                            "login_url": login_url,
                        }
                        return
                    logger.warning("[Auth] Proactive global token refresh failed, continuing with existing token...")
            # Final guard for the global / no-agent path as well.
            if not load_saved_token() and auth_method() == "none":
                logger.error("[Auth] No global token available — cannot spawn Claude CLI")
                login_url = await get_login_url()
                yield {
                    "type": "error",
                    "content": f"No authentication token available. Please authenticate: {login_url}",
                    "login_url": login_url,
                }
                return

        agent_label = f" (user={agent_user['username']})" if agent_user else ""
        effective_user = self._resolve_effective_user(agent_id, agent_user)
        pending_session: dict = {"key": None, "id": None, "is_new": False}

        async def _start_stream_proc(aid: Optional[str]):
            cmd, proc_cwd, sid, is_new, skey = self._build_cmd(
                output_format="stream-json", system_prompt=system_prompt,
                agent_id=aid, task_id=task_id,
                permissions=self._get_permissions(aid),
                agent_user=effective_user,
            )
            pending_session["key"] = skey
            pending_session["id"] = sid
            pending_session["is_new"] = is_new
            logger.info(f"Streaming Claude Code{agent_label} (prompt={len(prompt)}B): {prompt[:100]}...")
            logger.info(f"[Spawn] {_spawn_diagnostic(proc_cwd, effective_user)}")
            try:
                p = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdin=asyncio.subprocess.PIPE,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    cwd=proc_cwd,
                    env=get_agent_env(effective_user),
                    limit=10 * 1024 * 1024,
                    **get_subprocess_kwargs(effective_user),
                )
            except PermissionError as spawn_err:
                # Most likely: the dropped agent UID can't traverse some
                # ancestor of `proc_cwd` (chmod 0700/0750 on a shared parent),
                # or the claude binary is not executable for that UID. Dump
                # every path component so the failing dir is obvious in the
                # logs, then re-raise as a clean stream error instead of
                # crashing the ASGI response.
                logger.error(
                    f"[Spawn] PermissionError spawning claude (cwd={proc_cwd}, "
                    f"target_uid={effective_user.get('uid') if effective_user else os.getuid()}): {spawn_err}\n"
                    f"  path components: {_cwd_path_diagnostic(proc_cwd)}"
                )
                raise RuntimeError(
                    f"Permission denied spawning claude CLI (cwd={proc_cwd}). "
                    f"The dedicated agent UID likely can't traverse cwd or its parents — "
                    f"see runner-service logs for the per-component mode/owner dump."
                ) from spawn_err
            try:
                p.stdin.write(prompt.encode("utf-8"))
                await p.stdin.drain()
                p.stdin.close()
                await p.stdin.wait_closed()
            except BrokenPipeError:
                stderr_out = ""
                try:
                    stderr_out = (await asyncio.wait_for(p.stderr.read(), timeout=5)).decode("utf-8", errors="replace").strip()
                except Exception:
                    pass
                try:
                    await asyncio.wait_for(p.wait(), timeout=5)
                except Exception:
                    pass
                raise BrokenPipeError(
                    f"Claude CLI exited before reading prompt (rc={p.returncode}). "
                    f"stderr: {stderr_out[:500]}" if stderr_out else
                    f"Claude CLI exited before reading prompt (rc={p.returncode})"
                )
            return p

        try:
            proc = await _start_stream_proc(agent_id)
        except BrokenPipeError:
            session_key = f"{agent_id}:{task_id}" if agent_id and task_id else agent_id
            if session_key and session_key in self._sessions:
                logger.warning(f"[Session] Resume failed for agent {agent_id[:12]} — creating new session")
                self._sessions.pop(session_key, None)
                try:
                    proc = await _start_stream_proc(agent_id)
                except BrokenPipeError as e:
                    logger.error(f"[Session] Retry also failed for agent {agent_id[:12]}: {e}")
                    raise
            else:
                raise
        except RuntimeError as spawn_err:
            # Spawn-time failure (typically PermissionError translated above).
            # Surface as a stream error event so the client gets a clean
            # message instead of an ASGI 500 / broken SSE response.
            yield {"type": "error", "content": str(spawn_err)}
            return

        has_content = False
        last_event_types: list[str] = []
        last_result_event: Optional[dict] = None

        try:
            async for line in proc.stdout:
                line = line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue

                is_json_event = False
                event = None
                try:
                    event = json.loads(line)
                    is_json_event = True
                except json.JSONDecodeError:
                    pass

                if is_json_event and isinstance(event, dict):
                    etype = event.get("type", "")
                    last_event_types.append(etype or "?")
                    if len(last_event_types) > 20:
                        last_event_types = last_event_types[-20:]
                    if etype == "result":
                        last_result_event = event

                check_auth = not is_json_event
                if is_json_event and isinstance(event, dict):
                    etype = event.get("type", "")
                    if etype in ("system", "error"):
                        check_auth = True
                    elif etype == "assistant":
                        msg = event.get("message", {})
                        if isinstance(msg, dict) and msg.get("model") == "<synthetic>":
                            check_auth = True

                if check_auth:
                    line_lower = line.lower()
                    if "token has expired" in line_lower or ("authentication_error" in line_lower and "401" in line_lower):
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass
                        logger.warning(f"Expired token detected in stream: {line[:120]}")
                        if agent_user:
                            refreshed = await refresh_agent_token(agent_user)
                        else:
                            refreshed = await refresh_oauth_token()
                        if refreshed and _auth_retry < MAX_AUTH_RETRIES:
                            yield {"type": "status", "content": "Token refreshed, retrying..."}
                            async for ev in self.stream_events(prompt, system_prompt, agent_id=agent_id, owner_id=owner_id, task_id=task_id, _auth_retry=_auth_retry + 1):
                                yield ev
                        else:
                            if _auth_retry >= MAX_AUTH_RETRIES:
                                logger.error(f"Auth retry limit ({MAX_AUTH_RETRIES}) reached, aborting")
                            if agent_user:
                                login_url = initiate_owner_login(_owner_id) if _owner_id else initiate_agent_login(agent_id)
                            else:
                                login_url = await get_login_url()
                            yield {
                                "type": "error",
                                "content": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                                "login_url": login_url,
                            }
                        return

                    if "not logged in" in line_lower:
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass
                        if agent_user:
                            refreshed = await refresh_agent_token(agent_user)
                            if not refreshed:
                                global_token = load_saved_token()
                                if global_token:
                                    global_refresh = get_saved_refresh_token()
                                    save_agent_token(agent_user, global_token, refresh_token=global_refresh)
                                    logger.info(f"[Agent Auth] Copied global token to {agent_user['username']}")
                                    refreshed = True
                            if refreshed and _auth_retry < MAX_AUTH_RETRIES:
                                yield {"type": "status", "content": "Agent token refreshed, retrying..."}
                                async for ev in self.stream_events(prompt, system_prompt, agent_id=agent_id, owner_id=owner_id, task_id=task_id, _auth_retry=_auth_retry + 1):
                                    yield ev
                                return
                        if agent_user:
                            login_url = initiate_owner_login(_owner_id) if _owner_id else initiate_agent_login(agent_id)
                        else:
                            login_url = await get_login_url()
                        if login_url:
                            yield {
                                "type": "error",
                                "content": f"Not authenticated. Open this URL: {login_url} -- then send the verification code as your next message.",
                                "login_url": login_url,
                            }
                        else:
                            yield {
                                "type": "error",
                                "content": "Not authenticated. Call POST /auth/login to start, or POST a token to /auth/token.",
                            }
                        return

                if not is_json_event:
                    has_content = True
                    yield {"type": "text", "content": line}
                    continue

                event_type = event.get("type", "")

                if event_type == "assistant":
                    message = event.get("message", {})
                    content = message.get("content", "")
                    if isinstance(content, list):
                        for block in content:
                            if isinstance(block, dict) and block.get("type") == "thinking":
                                has_content = True
                                yield {"type": "thinking", "content": block.get("thinking", "")}
                            elif isinstance(block, dict) and block.get("type") == "text":
                                has_content = True
                                yield {"type": "text", "content": block.get("text", "")}
                            elif isinstance(block, dict) and block.get("type") == "tool_use":
                                has_content = True
                                tool_name = block.get("name", "unknown")
                                yield {"type": "status", "content": f"Using tool: {tool_name}"}
                    elif isinstance(content, str) and content:
                        has_content = True
                        yield {"type": "text", "content": content}

                elif event_type == "tool_use":
                    has_content = True
                    tool_name = event.get("name", "unknown")
                    yield {"type": "status", "content": f"Using tool: {tool_name}"}

                elif event_type == "tool_result":
                    has_content = True

                elif event_type == "result":
                    result_text = event.get("result", "")
                    cost = event.get("cost_usd", 0)
                    duration = event.get("duration_ms", 0)
                    usage = event.get("usage", {}) or {}
                    input_tokens = usage.get("input_tokens", 0) or 0
                    output_tokens = usage.get("output_tokens", 0) or 0
                    total_tokens = event.get("total_tokens", 0) or (input_tokens + output_tokens)
                    if input_tokens > 0 or output_tokens > 0 or result_text:
                        has_content = True
                    yield {"type": "result", "content": result_text or "", "cost_usd": cost, "duration_ms": duration, "total_tokens": total_tokens, "input_tokens": input_tokens, "output_tokens": output_tokens}

                elif event_type == "error":
                    error_msg = event.get("error", {})
                    if isinstance(error_msg, dict):
                        error_msg = error_msg.get("message", str(error_msg))
                    error_str = str(error_msg)
                    if "token has expired" in error_str.lower() or "oauth token" in error_str.lower():
                        try:
                            proc.terminate()
                        except ProcessLookupError:
                            pass
                        logger.warning(f"Token expired mid-stream: {error_str}")
                        refreshed = await refresh_oauth_token()
                        if refreshed and _auth_retry < MAX_AUTH_RETRIES:
                            yield {"type": "status", "content": "Token refreshed, retrying..."}
                            async for ev in self.stream_events(prompt, system_prompt, agent_id=agent_id, owner_id=owner_id, task_id=task_id, _auth_retry=_auth_retry + 1):
                                yield ev
                        else:
                            if _auth_retry >= MAX_AUTH_RETRIES:
                                logger.error(f"Auth retry limit ({MAX_AUTH_RETRIES}) reached, aborting")
                            login_url = await get_login_url()
                            yield {
                                "type": "error",
                                "content": f"OAuth token expired and refresh failed. Please re-authenticate: {login_url}",
                                "login_url": login_url,
                            }
                        return
                    yield {"type": "error", "content": error_str}

                else:
                    if VERBOSE:
                        logger.debug(f"Unhandled event type: {event_type}")

        except asyncio.CancelledError:
            try:
                proc.terminate()
            except ProcessLookupError:
                pass
            raise
        finally:
            try:
                await proc.wait()
            except asyncio.CancelledError:
                pass

        # Read any stderr once after process completion (used by both branches below)
        try:
            stderr_text = (await proc.stderr.read()).decode("utf-8", errors="replace").strip()
        except Exception:
            stderr_text = ""

        if proc.returncode != 0:
            if stderr_text:
                yield {"type": "error", "content": stderr_text}

        if has_content:
            # Stream produced real content — safe to persist a freshly minted session id
            self._commit_session(pending_session["key"], pending_session["id"])

        if not has_content and proc.returncode == 0 and agent_id:
            was_resume = not pending_session["is_new"]
            # Surface every diagnostic we have so the cause is visible in logs.
            result_summary = ""
            if last_result_event:
                usage = (last_result_event.get("usage") or {})
                result_summary = (
                    f" result={{subtype={last_result_event.get('subtype')}, "
                    f"is_error={last_result_event.get('is_error')}, "
                    f"num_turns={last_result_event.get('num_turns')}, "
                    f"in_tokens={usage.get('input_tokens', 0)}, "
                    f"out_tokens={usage.get('output_tokens', 0)}, "
                    f"result_text_len={len(str(last_result_event.get('result') or ''))}}}"
                )
            logger.warning(
                f"[Session] Empty response from Claude CLI for agent {agent_id[:12]} "
                f"(rc=0, was_resume={was_resume}, prompt={len(prompt)}B, "
                f"events={last_event_types or '<none>'}){result_summary}"
            )
            if stderr_text:
                logger.warning(f"[Session] Empty response stderr: {stderr_text[:500]}")

            if was_resume and _auth_retry < 1:
                logger.warning(f"[Session] Resetting resumed session for agent {agent_id[:12]} and retrying with a fresh session")
                if pending_session["key"]:
                    self._sessions.pop(pending_session["key"], None)
                async for ev in self.stream_events(prompt, system_prompt, agent_id=agent_id, owner_id=owner_id, task_id=task_id, _auth_retry=_auth_retry + 1):
                    yield ev
            else:
                # Brand-new session that produced nothing — do NOT poison future calls
                if pending_session["is_new"] and pending_session["key"]:
                    self._sessions.pop(pending_session["key"], None)
                yield {
                    "type": "error",
                    "content": (
                        "Claude CLI returned no output (possible silent rate limit or upstream issue). "
                        f"Last events: {last_event_types or '<none>'}."
                        + (f" stderr: {stderr_text[:200]}" if stderr_text else "")
                    ),
                }

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

    async def agent_auth_callback(self, agent_id: str, code: str) -> dict:
        flow = get_agent_oauth_flow(agent_id)
        if not flow:
            return {"status": "error", "message": "No pending OAuth flow for this agent."}
        agent_user = await ensure_agent_user(agent_id)
        if not agent_user:
            return {"status": "error", "message": "Failed to resolve agent user"}

        payload = {
            "grant_type": "authorization_code",
            "client_id": OAUTH_CLIENT_ID,
            "code": code,
            "redirect_uri": OAUTH_REDIRECT_URI,
            "code_verifier": flow["code_verifier"],
        }
        result = await token_http_request(payload, f"agent {agent_id[:12]} code exchange")
        if not result:
            return {"status": "error", "message": "Token exchange failed"}
        access_token = result.get("access_token")
        if not access_token:
            return {"status": "error", "message": f"Token response missing access_token: {json.dumps(result)}"}
        refresh_token = result.get("refresh_token")
        expires_in = result.get("expires_in", 28800)
        if not save_agent_token(agent_user, access_token, refresh_token=refresh_token, expires_in=expires_in):
            return {"status": "error", "message": "Token exchange succeeded but persistence failed (team-api unreachable)."}
        pop_agent_oauth_flow(agent_id)
        return {"status": "authenticated", "agent_id": agent_id, "message": "Agent now has its own OAuth token."}

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
        payload = {
            "grant_type": "authorization_code",
            "client_id": OAUTH_CLIENT_ID,
            "code": code,
            "redirect_uri": OAUTH_REDIRECT_URI,
            "code_verifier": flow["code_verifier"],
        }
        result = await token_http_request(payload, f"owner {owner_id} code exchange")
        if not result:
            return {"status": "error", "message": "Token exchange failed"}
        access_token = result.get("access_token")
        if not access_token:
            return {"status": "error", "message": f"Token response missing access_token: {json.dumps(result)}"}
        refresh_token = result.get("refresh_token")
        expires_in = result.get("expires_in", 28800)
        if not save_owner_token(owner_id, access_token, refresh_token=refresh_token, expires_in=expires_in):
            return {"status": "error", "message": "Token exchange succeeded but persistence failed (team-api unreachable)."}
        pop_owner_oauth_flow(owner_id)
        return {"status": "authenticated", "owner_id": owner_id, "message": "Owner now has an OAuth token shared by all their agents."}

    async def owner_set_token(self, owner_id: str, token: str) -> None:
        if not save_owner_token(owner_id, token):
            raise RuntimeError("Failed to persist owner token (team-api unreachable)")
