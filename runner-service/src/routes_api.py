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
    ShellExecRequest, EnsureProjectRequest,
    chunk_text, messages_to_prompt,
)
from security import extract_api_key, verify_api_key
from agent_user import get_agent_project_dir, ensure_agent_project, ensure_agent_user
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

        if request.language == "python":
            return ExecutionResponse(status="success", output=execute_python(request.code))
        if request.language in ("shell", "bash"):
            return ExecutionResponse(status="success", output=execute_shell(request.code))
        return ExecutionResponse(status="error", output="", error=f"Unsupported language: {request.language}")
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

        async def read_pipe(pipe, parts, is_stderr=False):
            while True:
                chunk = await pipe.read(4096)
                if not chunk:
                    break
                parts.append(chunk)
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
        if proc.returncode != 0:
            output += f"\n[exit code: {proc.returncode}]"
        # Clamp the caller-requested output cap to a 32 MiB server-side
        # ceiling. This covers a 20 MB attachment after base64 inflation
        # (~33%) while still bounding worst-case memory use.
        max_out = max(1, min(request.max_output, 32 * 1024 * 1024))
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
        try:
            yield f"data: {json.dumps({'status': 'starting', 'message': f'{BACKEND.name} execution started'})}\n\n"

            has_streamed_text = False
            async for event in BACKEND.stream_events(request.content, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id):
                event_type = event.get("type", "")

                if event_type == "thinking":
                    yield f"data: {json.dumps({'status': 'thinking', 'output': event['content']}, ensure_ascii=False)}\n\n"
                elif event_type == "status":
                    yield f"data: {json.dumps({'status': 'working', 'output': event['content']}, ensure_ascii=False)}\n\n"
                elif event_type == "text":
                    yield f"data: {json.dumps({'status': 'streaming', 'output': event['content']}, ensure_ascii=False)}\n\n"
                    has_streamed_text = True
                elif event_type == "result":
                    output = "" if has_streamed_text else event["content"]
                    yield f"data: {json.dumps({'status': 'success', 'output': output, 'cost_usd': event.get('cost_usd'), 'duration_ms': event.get('duration_ms'), 'total_tokens': event.get('total_tokens'), 'input_tokens': event.get('input_tokens'), 'output_tokens': event.get('output_tokens')}, ensure_ascii=False)}\n\n"
                elif event_type == "error":
                    yield f"data: {json.dumps({'status': 'error', 'error': event['content']}, ensure_ascii=False)}\n\n"

            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'status': 'error', 'error': str(e)}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/reset")
async def reset_agent(
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_task_id: Optional[str] = Header(None),
):
    """No-op: session state is now caller-managed (passed in via
    X-Runner-Session-Id). The runner holds no per-agent session cache to
    reset. Kept as a 200-OK stub so older clients don't 404.
    """
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)
    return {"status": "success", "message": "runner is stateless — drop X-Runner-Session-Id on the caller side to start fresh"}


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

        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]})}\n\n"

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
                    content = event["content"]
                    yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'reasoning_content': content}, 'finish_reason': None}]})}\n\n"
                elif event_type == "text":
                    content = event["content"]
                    yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': content}, 'finish_reason': None}]})}\n\n"
                    has_streamed_text = True
                elif event_type == "status":
                    status_text = event.get("content", "")
                    if status_text:
                        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'reasoning_content': status_text + chr(10)}, 'finish_reason': None}]})}\n\n"
                elif event_type == "result":
                    cost_usd = event.get("cost_usd", 0) or 0
                    total_tokens = event.get("total_tokens", 0) or 0
                    input_tokens = event.get("input_tokens", 0) or 0
                    output_tokens_val = event.get("output_tokens", 0) or 0
                    if not has_streamed_text:
                        content = event.get("content", "")
                        if content:
                            for piece in chunk_text(content):
                                yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': piece}, 'finish_reason': None}]})}\n\n"
                            has_streamed_text = True
                elif event_type == "error":
                    content = event.get("content", "")
                    yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': content}, 'finish_reason': None}]})}\n\n"
        except BrokenPipeError as e:
            logger.error(f"{BACKEND.name} CLI subprocess failed: {e}")
            error_msg = f"Agent subprocess failed to start: {e}"
            yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'content': error_msg}, 'finish_reason': None}]})}\n\n"

        finish_chunk = {
            "id": completion_id, "object": "chat.completion.chunk",
            "created": created, "model": model,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": input_tokens or total_tokens,
                "completion_tokens": output_tokens_val,
                "total_tokens": total_tokens or (input_tokens + output_tokens_val),
                "cost_usd": cost_usd,
                "runner_session_id": runner_session_id_used,
            },
        }
        yield f"data: {json.dumps(finish_chunk)}\n\n"
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
        "usage": {
            "prompt_tokens": result.get("input_tokens", 0) or result.get("total_tokens", 0),
            "completion_tokens": result.get("output_tokens", 0),
            "total_tokens": result.get("total_tokens", 0) or (result.get("input_tokens", 0) + result.get("output_tokens", 0)),
            "cost_usd": result.get("cost_usd", 0),
            "runner_session_id": result.get("session_id") or session_id_hint,
        },
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
        async for event in BACKEND.stream_events(request.prompt, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id):
            event_type = event.get("type", "")

            if event_type == "text":
                content = event["content"]
                for piece in chunk_text(content):
                    yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': piece, 'finish_reason': None}]})}\n\n"
                has_streamed_text = True
            elif event_type == "result":
                cost_usd = event.get("cost_usd", 0) or 0
                total_tokens = event.get("total_tokens", 0) or 0
                input_tokens = event.get("input_tokens", 0) or 0
                output_tokens_val = event.get("output_tokens", 0) or 0
                if not has_streamed_text:
                    content = event["content"]
                    for piece in chunk_text(content):
                        yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': piece, 'finish_reason': None}]})}\n\n"
            elif event_type == "error":
                yield f"data: {json.dumps({'id': completion_id, 'object': 'text_completion', 'created': created, 'model': model, 'choices': [{'index': 0, 'text': event['content'], 'finish_reason': None}]})}\n\n"

        finish_chunk = {
            "id": completion_id, "object": "text_completion",
            "created": created, "model": model,
            "choices": [{"index": 0, "text": "", "finish_reason": "stop"}],
            "usage": {
                "prompt_tokens": input_tokens or total_tokens,
                "completion_tokens": output_tokens_val,
                "total_tokens": total_tokens or (input_tokens + output_tokens_val),
                "cost_usd": cost_usd,
            },
        }
        yield f"data: {json.dumps(finish_chunk)}\n\n"
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
        "usage": {
            "prompt_tokens": result.get("input_tokens", 0) or result.get("total_tokens", 0),
            "completion_tokens": result.get("output_tokens", 0),
            "total_tokens": result.get("total_tokens", 0) or (result.get("input_tokens", 0) + result.get("output_tokens", 0)),
            "cost_usd": result.get("cost_usd", 0),
        },
    }
