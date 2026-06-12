"""
Runner Service — API HTTP routes (delegates agent execution to BACKEND).
"""

import os
import json
import time
import uuid
import asyncio
import hashlib
from typing import Optional
from fastapi import APIRouter, HTTPException, Header
from fastapi.responses import StreamingResponse

from config import RUNNER_MODEL, PROJECTS_DIR, logger
from models import (
    MessageRequest, CodeRequest, ExecutionResponse,
    OpenAIChatCompletionRequest, OpenAICompletionRequest,
    ShellExecRequest, EnsureProjectRequest, InstallGitCredentialsRequest,
    chunk_text, messages_to_prompt,
)
from security import extract_api_key, verify_api_key
from agent_user import (
    get_agent_project_dir, ensure_agent_project, ensure_agent_user,
    install_agent_git_credentials,
)
from code_executor import execute_python, execute_shell
from command_security import validate_command, sanitize_env
from backends import BACKEND
from backends.claude_token_store import get_subprocess_kwargs
import pty_session

router = APIRouter()


def _maybe_set_permissions(agent_id: Optional[str], header: Optional[str]) -> None:
    if agent_id and header:
        try:
            BACKEND.set_agent_permissions(agent_id, json.loads(header))
        except (json.JSONDecodeError, TypeError):
            pass


def _maybe_set_llm_config(agent_id: Optional[str], header: Optional[str]) -> None:
    """Cache the per-agent LLM config (provider/model/apiKey) so CLI backends
    that wrap multi-provider tools (opencode, ...) can configure the CLI to
    use the agent's selected LLM instead of the static RUNNER_MODEL."""
    if not agent_id or not header:
        return
    try:
        cfg = json.loads(header)
        if isinstance(cfg, dict):
            BACKEND.set_agent_llm_config(agent_id, cfg)
        elif cfg is None:
            BACKEND.set_agent_llm_config(agent_id, None)
    except (json.JSONDecodeError, TypeError):
        pass


def _resolve_permissions(agent_id: Optional[str], header: Optional[str]) -> dict:
    """Permissions for this request: header takes precedence (most up-to-date),
    fall back to whatever the backend has cached from the last /execute or
    /v1/chat/completions call. Returns {} when nothing is set."""
    if header:
        try:
            perms = json.loads(header)
            if isinstance(perms, dict):
                if agent_id:
                    # Refresh the backend-side cache so subsequent runs see the
                    # latest toggles without needing the header again.
                    BACKEND.set_agent_permissions(agent_id, perms)
                return perms
        except (json.JSONDecodeError, TypeError):
            pass
    if agent_id:
        cached = getattr(BACKEND, "_permissions", {}).get(agent_id) if hasattr(BACKEND, "_permissions") else None
        if isinstance(cached, dict):
            return cached
    return {}


def _path_is_under_restricted(target: str, restricted: list) -> bool:
    """True if `target` is inside any of the `restricted` paths."""
    try:
        target_abs = os.path.realpath(os.path.abspath(target))
    except OSError:
        target_abs = os.path.abspath(target)
    for raw in restricted or []:
        raw = (raw or "").strip()
        if not raw:
            continue
        try:
            base = os.path.realpath(os.path.abspath(os.path.expanduser(raw)))
        except OSError:
            base = os.path.abspath(os.path.expanduser(raw))
        if target_abs == base or target_abs.startswith(base.rstrip("/") + "/"):
            return True
    return False


def _agent_unsupported() -> HTTPException:
    return HTTPException(
        status_code=501,
        detail=f"Backend '{BACKEND.name}' does not provide an LLM agent. Use /exec-shell or call your LLM provider directly.",
    )


def _safe_task_name(task_id: Optional[str]) -> str:
    raw = (task_id or "current").strip() or "current"
    return "".join(ch if ch.isalnum() or ch in ("-", "_") else "_" for ch in raw)[:120]


def _write_text_file(path: str, content: str, agent_user: Optional[dict] = None) -> None:
    os.makedirs(os.path.dirname(path), mode=0o700, exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(content)
    os.replace(tmp, path)
    os.chmod(path, 0o600)
    if agent_user:
        uid = agent_user.get("uid")
        gid = agent_user.get("gid", uid)
        if uid is not None:
            try:
                os.chown(os.path.dirname(path), uid, gid)
                os.chown(path, uid, gid)
            except OSError:
                pass


def _ensure_local_git_exclude(project_dir: Optional[str], agent_user: Optional[dict] = None) -> None:
    if not project_dir:
        return
    exclude_path = os.path.join(project_dir, ".git", "info", "exclude")
    if not os.path.isfile(exclude_path):
        return
    try:
        with open(exclude_path, "r", encoding="utf-8", errors="replace") as f:
            existing = f.read()
        if "\n.pulsar/\n" in f"\n{existing}\n":
            return
        with open(exclude_path, "a", encoding="utf-8") as f:
            if existing and not existing.endswith("\n"):
                f.write("\n")
            f.write(".pulsar/\n")
        if agent_user:
            uid = agent_user.get("uid")
            gid = agent_user.get("gid", uid)
            if uid is not None:
                try:
                    os.chown(exclude_path, uid, gid)
                except OSError:
                    pass
    except OSError as e:
        logger.debug(f"[Context] Could not update git exclude for {project_dir}: {e}")


async def _write_hidden_context_files(
    agent_id: Optional[str],
    owner_id: Optional[str],
    task_id: Optional[str],
    prompt: str,
    system_prompt: Optional[str],
    messages: Optional[list] = None,
) -> list[str]:
    """Persist execution context outside the terminal display.

    The terminal transcript should show observable execution, not the full
    hidden prompt/system context. These files give CLI runners and later
    subprocesses a stable, up-to-date context surface without echoing it into
    xterm.
    """
    if not agent_id:
        return []
    try:
        agent_user = await ensure_agent_user(agent_id, owner_id=owner_id)
        project_dir = get_agent_project_dir(agent_id)
        now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        task_name = _safe_task_name(task_id)
        digest_src = f"{system_prompt or ''}\n{prompt or ''}"
        digest = hashlib.sha256(digest_src.encode("utf-8", errors="replace")).hexdigest()[:16]
        body_parts = [
            "# PulsarTeam Hidden Execution Context",
            "",
            f"- Updated: {now}",
            f"- Agent ID: {agent_id}",
            f"- Task ID: {task_id or 'none'}",
            f"- Context hash: {digest}",
            "",
        ]
        if system_prompt:
            body_parts.extend(["## System Context", "", system_prompt.strip(), ""])
        if prompt:
            body_parts.extend(["## Current Prompt", "", prompt.strip(), ""])
        if messages:
            body_parts.extend(["## Structured Messages", ""])
            for idx, msg in enumerate(messages[-20:], 1):
                role = getattr(msg, "role", None) or (msg.get("role") if isinstance(msg, dict) else "unknown")
                content = getattr(msg, "content", None) or (msg.get("content") if isinstance(msg, dict) else "")
                body_parts.extend([f"### {idx}. {role}", "", str(content).strip(), ""])
        content = "\n".join(body_parts).rstrip() + "\n"

        targets = []
        if agent_user and agent_user.get("home"):
            base = os.path.join(agent_user["home"], ".pulsar", "context")
            targets.append(os.path.join(base, "current.md"))
            targets.append(os.path.join(base, "tasks", f"{task_name}.md"))
        if project_dir:
            base = os.path.join(project_dir, ".pulsar", "context")
            targets.append(os.path.join(base, "current.md"))
            targets.append(os.path.join(base, "tasks", f"{task_name}.md"))

        for target in targets:
            _write_text_file(target, content, agent_user)
        _ensure_local_git_exclude(project_dir, agent_user)
        return targets
    except Exception as e:
        logger.warning(f"[Context] Failed to write hidden context for agent {agent_id}: {e}")
        return []


def _append_context_file_note(system_prompt: Optional[str], paths: list[str]) -> Optional[str]:
    if not paths:
        return system_prompt
    note = (
        "\n\n--- Hidden Runner Context Files ---\n"
        "The latest PulsarTeam execution context is maintained in these files. "
        "Use them as background context when useful, but do not print their contents unless explicitly asked:\n"
        + "\n".join(f"- {p}" for p in paths)
    )
    return (system_prompt or "") + note


# =============================================================================
# Health / docs
# =============================================================================

@router.get("/health")
async def health_check():
    return BACKEND.health()


@router.get("/docs-openapi")
async def docs_openapi(x_api_key: str = Header(None)):
    from server import app
    return app.openapi()


# =============================================================================
# Core execution endpoints
# =============================================================================

@router.post("/execute", response_model=ExecutionResponse)
async def execute_message(
    request: MessageRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
    x_llm_config: Optional[str] = Header(None),
):
    """Execute a natural language request via the configured runner."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)
    _maybe_set_llm_config(x_agent_id, x_llm_config)

    context_paths = await _write_hidden_context_files(
        x_agent_id, x_owner_id, None,
        request.content, request.system_prompt, None,
    )
    system_prompt = _append_context_file_note(request.system_prompt, context_paths)
    result = await BACKEND.run_sync(request.content, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id)
    return ExecutionResponse(**result)


@router.post("/code/execute", response_model=ExecutionResponse)
async def execute_code(
    request: CodeRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
):
    """Direct code execution endpoint (bypasses any LLM)."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    perms = _resolve_permissions(x_agent_id, x_agent_permissions)
    exec_perms = perms.get("execution") or {}
    if exec_perms.get("shellAccess", True) is False:
        raise HTTPException(
            status_code=403,
            detail="execution.shellAccess is disabled for this agent",
        )

    try:
        logger.info(f"Executing {request.language} code ({len(request.code)} chars)...")

        # Run the blocking executors in a worker thread so a slow command can't
        # stall the event loop; the outer timeout (70s) stays strictly above the
        # executors' own 60s subprocess timeout, which bounds the worker thread.
        if request.language == "python":
            output = await asyncio.wait_for(asyncio.to_thread(execute_python, request.code), timeout=70)
            return ExecutionResponse(status="success", output=output)
        if request.language in ("shell", "bash"):
            output = await asyncio.wait_for(asyncio.to_thread(execute_shell, request.code), timeout=70)
            return ExecutionResponse(status="success", output=output)
        return ExecutionResponse(status="error", output="", error=f"Unsupported language: {request.language}")
    except asyncio.TimeoutError:
        return ExecutionResponse(status="error", output="", error="Code execution timed out")
    except Exception as e:
        logger.error(f"Code execution error: {str(e)}", exc_info=True)
        return ExecutionResponse(status="error", output="", error=str(e))


@router.post("/projects/ensure")
async def ensure_project(
    request: EnsureProjectRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
):
    """Clone or update a project repo for a specific agent."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not x_agent_id:
        raise HTTPException(status_code=400, detail="X-Agent-Id header required")

    perms = _resolve_permissions(x_agent_id, x_agent_permissions)
    net_perms = perms.get("network") or {}
    if net_perms.get("internetAccess", True) is False:
        raise HTTPException(
            status_code=403,
            detail="network.internetAccess is disabled — cannot clone/fetch remote repositories",
        )

    try:
        creds = None
        if request.git_credentials and request.git_credentials.token:
            creds = {
                "provider": request.git_credentials.provider or "github",
                "token": request.git_credentials.token,
                "username": request.git_credentials.username or "",
            }
        await ensure_agent_user(x_agent_id, owner_id=x_owner_id)
        project_dir = await ensure_agent_project(
            x_agent_id, request.project, request.git_url, git_credentials=creds,
        )
        return {"status": "success", "project_dir": project_dir}
    except Exception as e:
        # Some exceptions (asyncio.TimeoutError, plain RuntimeError(""), ...)
        # have an empty str(), which produces an unhelpful blank error in the
        # logs and in the API response. Always include the exception class
        # name and log a full traceback so the failure can be diagnosed.
        err_type = type(e).__name__
        err_msg = str(e).strip() or err_type
        if err_type not in err_msg:
            err_msg = f"{err_type}: {err_msg}"
        logger.error(
            f"[Project] ensure failed for agent {x_agent_id[:12]} "
            f"(project={request.project!r}): {err_msg}",
            exc_info=True,
        )
        return {"status": "error", "error": err_msg}


@router.post("/credentials/git")
async def install_git_credentials_route(
    request: InstallGitCredentialsRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
):
    """Push git plugin credentials for an agent without cloning a project.

    Symmetric with /projects/ensure for the credential-install side, but
    skips the working-tree work. Lets the API ship the token for agents
    that have a GitHub plugin connected at the agent or board level but no
    project pinned yet — the CLI runner still needs ~/.git-credentials so
    `git`/`gh` authenticate as soon as the LLM decides to interact with a
    repo.
    """
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not x_agent_id:
        raise HTTPException(status_code=400, detail="X-Agent-Id header required")
    if not request.git_credentials or not request.git_credentials.token:
        raise HTTPException(status_code=400, detail="git_credentials.token is required")

    creds = {
        "provider": request.git_credentials.provider or "github",
        "token": request.git_credentials.token,
        "username": request.git_credentials.username or "",
    }
    try:
        await ensure_agent_user(x_agent_id, owner_id=x_owner_id)
        ok = await install_agent_git_credentials(
            x_agent_id, creds, host_hint=request.host or None,
        )
        if not ok:
            return {"status": "error", "error": "credentials install failed"}
        return {"status": "success"}
    except Exception as e:
        err_type = type(e).__name__
        err_msg = str(e).strip() or err_type
        logger.error(
            f"[Credentials] Install failed for agent {x_agent_id[:12]}: {err_type}: {err_msg}",
            exc_info=True,
        )
        return {"status": "error", "error": f"{err_type}: {err_msg}"}


@router.post("/exec-shell")
async def exec_shell(
    request: ShellExecRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
):
    """Execute a shell command in the agent's project context."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    perms = _resolve_permissions(x_agent_id, x_agent_permissions)
    exec_perms = perms.get("execution") or {}
    if exec_perms.get("shellAccess", True) is False:
        return ExecutionResponse(
            status="error", output="",
            error="🛡️ execution.shellAccess is disabled for this agent",
        )

    # Security: validate command against blocklist
    block_reason = validate_command(request.command)
    if block_reason:
        return ExecutionResponse(status="error", output="", error=f"🛡️ {block_reason}")

    cwd = request.cwd
    if not cwd and x_agent_id:
        cwd = get_agent_project_dir(x_agent_id)
    if not cwd:
        cwd = PROJECTS_DIR
    if not os.path.isdir(cwd):
        return ExecutionResponse(status="error", output="", error=f"Directory not found: {cwd}")

    # Block cwd that falls under any restrictedPaths.
    fs_perms = perms.get("filesystem") or {}
    restricted = fs_perms.get("restrictedPaths") or []
    if restricted and _path_is_under_restricted(cwd, restricted):
        return ExecutionResponse(
            status="error", output="",
            error=f"🛡️ cwd '{cwd}' is under a restricted path",
        )

    timeout = min(request.timeout, 120)
    # Clamp the caller-requested output cap to a 32 MiB server-side
    # ceiling. This covers a 20 MB attachment after base64 inflation
    # (~33%) while still bounding worst-case memory use.
    output_ceiling = 32 * 1024 * 1024
    max_out = max(1, min(request.max_output, output_ceiling))

    # Ensure the agent's HOME exists so credential helpers, ~/.gitconfig and
    # ~/.git-credentials installed by /projects/ensure are picked up.
    agent_user = await ensure_agent_user(x_agent_id, owner_id=x_owner_id) if x_agent_id else None

    # Security: use sanitized environment to prevent secret leakage
    safe_env = sanitize_env(os.environ, agent_user=agent_user)
    subprocess_kwargs = get_subprocess_kwargs(agent_user)

    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", request.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=safe_env,
            **subprocess_kwargs,
        )
        stdout_parts = []
        stderr_parts = []
        captured_bytes = 0
        truncated = False

        async def read_pipe(pipe, parts, is_stderr=False):
            nonlocal captured_bytes, truncated
            while True:
                chunk = await pipe.read(4096)
                if not chunk:
                    break
                # Cap in-memory accumulation at the server ceiling, but keep
                # draining so the child never blocks on a full pipe buffer.
                if captured_bytes < output_ceiling:
                    parts.append(chunk)
                    captured_bytes += len(chunk)
                else:
                    truncated = True
                await pty_session.append_terminal_transcript(x_agent_id, chunk)

        await asyncio.wait_for(asyncio.gather(
            read_pipe(proc.stdout, stdout_parts, False),
            read_pipe(proc.stderr, stderr_parts, True),
            proc.wait(),
        ), timeout=timeout)

        stdout = b"".join(stdout_parts).decode("utf-8", errors="replace")
        stderr = b"".join(stderr_parts).decode("utf-8", errors="replace")

        output = stdout
        if stderr:
            output += f"\n[stderr] {stderr}"
        if truncated:
            output += "\n[output truncated: 32 MiB server-side cap reached]"
        if proc.returncode != 0:
            output += f"\n[exit code: {proc.returncode}]"
        if proc.returncode != 0:
            return ExecutionResponse(
                status="error",
                output=output[:max_out],
                error=f"Command failed with exit code {proc.returncode}",
            )
        return ExecutionResponse(status="success", output=output[:max_out])
    except asyncio.TimeoutError:
        if "proc" in locals() and proc.returncode is None:
            try:
                proc.kill()
                await proc.wait()
            except Exception:
                pass
        return ExecutionResponse(status="error", output="", error=f"Command timed out after {timeout}s")
    except Exception as e:
        logger.error(f"exec-shell error: {e}")
        return ExecutionResponse(status="error", output="", error=str(e))


# =============================================================================
# SSE chunk builders (shared by the three streaming generators below)
# =============================================================================

# Omit-sentinel for _usage_block: the chat endpoints ALWAYS include
# runner_session_id (possibly null) while the completions endpoints never do,
# so presence can't be keyed on None.
_OMIT = object()


def _sse(obj, ensure_ascii: bool = True) -> str:
    """Serialize one SSE data frame. `ensure_ascii` mirrors each call site's
    historical json.dumps flag (the wire bytes differ for non-ASCII text)."""
    return f"data: {json.dumps(obj, ensure_ascii=ensure_ascii)}\n\n"


def _chat_chunk(cid: str, created: int, model: str, delta: dict,
                finish_reason: Optional[str] = None, usage: Optional[dict] = None) -> dict:
    """One chat.completion.chunk. `usage` is only attached to the finish
    chunk — intermediate chunks must not carry a usage key at all."""
    chunk = {
        "id": cid, "object": "chat.completion.chunk",
        "created": created, "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        chunk["usage"] = usage
    return chunk


def _completion_chunk(cid: str, created: int, model: str, text: str,
                      finish_reason: Optional[str] = None, usage: Optional[dict] = None) -> dict:
    """One legacy text_completion chunk (the /v1/completions wire shape)."""
    chunk = {
        "id": cid, "object": "text_completion",
        "created": created, "model": model,
        "choices": [{"index": 0, "text": text, "finish_reason": finish_reason}],
    }
    if usage is not None:
        chunk["usage"] = usage
    return chunk


def _usage_block(input_tokens, output_tokens, total_tokens, cost_usd,
                 runner_session_id=_OMIT) -> dict:
    """Token-usage block with the shared `or`-fallback totals formula.

    Callers pass raw values (possibly None — propagated unchanged, exactly
    as the inline dicts did). Pass `runner_session_id` (even None) on the
    chat paths; leave it unset on the completions paths to omit the key."""
    usage = {
        "prompt_tokens": input_tokens or total_tokens,
        "completion_tokens": output_tokens,
        "total_tokens": total_tokens or (input_tokens + output_tokens),
        "cost_usd": cost_usd,
    }
    if runner_session_id is not _OMIT:
        usage["runner_session_id"] = runner_session_id
    return usage


# =============================================================================
# Streaming
# =============================================================================

@router.post("/stream")
async def stream_execution(
    request: MessageRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
    x_llm_config: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)
    _maybe_set_llm_config(x_agent_id, x_llm_config)
    context_paths = await _write_hidden_context_files(
        x_agent_id, x_owner_id, None,
        request.content, request.system_prompt, None,
    )
    system_prompt = _append_context_file_note(request.system_prompt, context_paths)

    async def event_generator():
        # Custom {'status', 'output'} schema (not OpenAI chunks) — only the
        # _sse framing helper applies here.
        try:
            yield _sse({"status": "starting", "message": f"{BACKEND.name} execution started"})

            has_streamed_text = False
            async for event in BACKEND.stream_events(request.content, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id):
                event_type = event.get("type", "")

                if event_type == "thinking":
                    yield _sse({"status": "thinking", "output": event["content"]}, ensure_ascii=False)
                elif event_type == "status":
                    yield _sse({"status": "working", "output": event["content"]}, ensure_ascii=False)
                elif event_type == "text":
                    yield _sse({"status": "streaming", "output": event["content"]}, ensure_ascii=False)
                    has_streamed_text = True
                elif event_type == "result":
                    output = "" if has_streamed_text else event["content"]
                    yield _sse({
                        "status": "success",
                        "output": output,
                        "cost_usd": event.get("cost_usd"),
                        "duration_ms": event.get("duration_ms"),
                        "total_tokens": event.get("total_tokens"),
                        "input_tokens": event.get("input_tokens"),
                        "output_tokens": event.get("output_tokens"),
                    }, ensure_ascii=False)
                elif event_type == "error":
                    yield _sse({"status": "error", "error": event["content"]}, ensure_ascii=False)

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield _sse({"status": "error", "error": str(e)}, ensure_ascii=False)

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# =============================================================================
# OpenAI-compatible endpoints
# =============================================================================

@router.get("/v1/models")
async def openai_models(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return {
        "object": "list",
        "data": [
            {
                "id": RUNNER_MODEL,
                "object": "model",
                "created": int(time.time()),
                "owned_by": BACKEND.name,
            }
        ],
    }


@router.post("/v1/chat/completions")
async def openai_chat_completions(
    request: OpenAIChatCompletionRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_task_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
    x_llm_config: Optional[str] = Header(None),
    x_runner_session_id: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)
    _maybe_set_llm_config(x_agent_id, x_llm_config)

    if not request.messages:
        raise HTTPException(status_code=400, detail="At least one message is required")

    prompt, system_prompt = messages_to_prompt(request.messages)
    if request.system_prompt:
        system_prompt = request.system_prompt

    model = request.model or RUNNER_MODEL
    session_id_hint = (x_runner_session_id or "").strip() or None
    context_paths = await _write_hidden_context_files(
        x_agent_id, x_owner_id, x_task_id,
        prompt, system_prompt, request.messages,
    )
    system_prompt = _append_context_file_note(system_prompt, context_paths)

    async def stream_openai_response():
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        yield _sse(_chat_chunk(completion_id, created, model, {"role": "assistant"}))

        has_streamed_text = False
        total_tokens = 0
        input_tokens = 0
        output_tokens_val = 0
        cost_usd = 0
        # Default to the hint so a no-op (resume succeeded) still reports back
        # the same UUID. Overwritten if the backend emits a session_id_used
        # event with a fresh UUID after falling back to a new session.
        runner_session_id_used = session_id_hint
        try:
            async for event in BACKEND.stream_events(
                prompt, system_prompt,
                agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id,
                session_id=session_id_hint, messages=request.messages,
            ):
                event_type = event.get("type", "")

                if event_type == "session_id_used":
                    runner_session_id_used = event.get("session_id") or runner_session_id_used
                    continue

                if event_type == "thinking":
                    yield _sse(_chat_chunk(completion_id, created, model,
                                           {"reasoning_content": event["content"]}))
                elif event_type == "text":
                    yield _sse(_chat_chunk(completion_id, created, model,
                                           {"content": event["content"]}))
                    has_streamed_text = True
                elif event_type == "status":
                    status_text = event.get("content", "")
                    if status_text:
                        yield _sse(_chat_chunk(completion_id, created, model,
                                               {"reasoning_content": status_text + "\n"}))
                elif event_type == "result":
                    cost_usd = event.get("cost_usd", 0) or 0
                    total_tokens = event.get("total_tokens", 0) or 0
                    input_tokens = event.get("input_tokens", 0) or 0
                    output_tokens_val = event.get("output_tokens", 0) or 0
                    if not has_streamed_text:
                        content = event.get("content", "")
                        if content:
                            for piece in chunk_text(content):
                                yield _sse(_chat_chunk(completion_id, created, model,
                                                       {"content": piece}))
                            has_streamed_text = True
                elif event_type == "error":
                    yield _sse(_chat_chunk(completion_id, created, model,
                                           {"content": event.get("content", "")}))
        except BrokenPipeError as e:
            logger.error(f"{BACKEND.name} CLI subprocess failed: {e}")
            error_msg = f"Agent subprocess failed to start: {e}"
            yield _sse(_chat_chunk(completion_id, created, model, {"content": error_msg}))
        except Exception as e:
            # Surface backend failures as a content delta and fall through to
            # the finish chunk + [DONE] so the consumer never sees a truncated
            # stream with no error text. CancelledError (client disconnect) is
            # a BaseException and still propagates.
            logger.exception(f"{BACKEND.name} stream failed mid-response")
            error_msg = f"Agent stream failed: {type(e).__name__}: {e}"
            yield _sse(_chat_chunk(completion_id, created, model, {"content": error_msg}),
                       ensure_ascii=False)

        yield _sse(_chat_chunk(
            completion_id, created, model, {}, finish_reason="stop",
            usage=_usage_block(input_tokens, output_tokens_val, total_tokens, cost_usd,
                               runner_session_id=runner_session_id_used),
        ))
        yield "data: [DONE]\n\n"

    if request.stream:
        return StreamingResponse(stream_openai_response(), media_type="text/event-stream")

    result = await BACKEND.run_sync(
        prompt, system_prompt,
        agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id,
        session_id=session_id_hint, messages=request.messages,
    )
    content = result.get("output", "") if result.get("status") == "success" else (result.get("error") or "Execution failed")

    return {
        "id": f"chatcmpl-{uuid.uuid4().hex}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "message": {"role": "assistant", "content": content}, "finish_reason": "stop"}],
        "usage": _usage_block(
            result.get("input_tokens", 0),
            result.get("output_tokens", 0),
            result.get("total_tokens", 0),
            result.get("cost_usd", 0),
            runner_session_id=result.get("session_id") or session_id_hint,
        ),
    }


@router.post("/v1/completions")
async def openai_completions(
    request: OpenAICompletionRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_task_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
    x_llm_config: Optional[str] = Header(None),
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)
    _maybe_set_llm_config(x_agent_id, x_llm_config)

    model = request.model or RUNNER_MODEL
    context_paths = await _write_hidden_context_files(
        x_agent_id, x_owner_id, x_task_id,
        request.prompt, request.system_prompt, None,
    )
    system_prompt = _append_context_file_note(request.system_prompt, context_paths)

    async def stream_openai_completion_response():
        completion_id = f"cmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        has_streamed_text = False
        total_tokens = 0
        input_tokens = 0
        output_tokens_val = 0
        cost_usd = 0
        try:
            async for event in BACKEND.stream_events(request.prompt, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id):
                event_type = event.get("type", "")

                if event_type == "text":
                    for piece in chunk_text(event["content"]):
                        yield _sse(_completion_chunk(completion_id, created, model, piece))
                    has_streamed_text = True
                elif event_type == "result":
                    cost_usd = event.get("cost_usd", 0) or 0
                    total_tokens = event.get("total_tokens", 0) or 0
                    input_tokens = event.get("input_tokens", 0) or 0
                    output_tokens_val = event.get("output_tokens", 0) or 0
                    if not has_streamed_text:
                        for piece in chunk_text(event["content"]):
                            yield _sse(_completion_chunk(completion_id, created, model, piece))
                elif event_type == "error":
                    yield _sse(_completion_chunk(completion_id, created, model, event["content"]))
        except Exception as e:
            # Same contract as stream_openai_response: emit the failure as a
            # text chunk and still send the finish chunk + [DONE].
            logger.exception(f"{BACKEND.name} stream failed mid-response")
            error_msg = f"Agent stream failed: {type(e).__name__}: {e}"
            yield _sse(_completion_chunk(completion_id, created, model, error_msg),
                       ensure_ascii=False)

        yield _sse(_completion_chunk(
            completion_id, created, model, "", finish_reason="stop",
            usage=_usage_block(input_tokens, output_tokens_val, total_tokens, cost_usd),
        ))
        yield "data: [DONE]\n\n"

    if request.stream:
        return StreamingResponse(stream_openai_completion_response(), media_type="text/event-stream")

    result = await BACKEND.run_sync(request.prompt, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id)
    content = result.get("output", "") if result.get("status") == "success" else (result.get("error") or "Execution failed")

    return {
        "id": f"cmpl-{uuid.uuid4().hex}",
        "object": "text_completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "text": content, "finish_reason": "stop"}],
        "usage": _usage_block(
            result.get("input_tokens", 0),
            result.get("output_tokens", 0),
            result.get("total_tokens", 0),
            result.get("cost_usd", 0),
        ),
    }
