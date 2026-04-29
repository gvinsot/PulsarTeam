"""
Runner Service — API HTTP routes (delegates agent execution to BACKEND).
"""

import os
import json
import time
import uuid
import asyncio
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
from agent_user import get_agent_project_dir, ensure_agent_project
from code_executor import execute_python, execute_shell
from backends import BACKEND

router = APIRouter()


def _maybe_set_permissions(agent_id: Optional[str], header: Optional[str]) -> None:
    if agent_id and header:
        try:
            BACKEND.set_agent_permissions(agent_id, json.loads(header))
        except (json.JSONDecodeError, TypeError):
            pass


def _agent_unsupported() -> HTTPException:
    return HTTPException(
        status_code=501,
        detail=f"Backend '{BACKEND.name}' does not provide an LLM agent. Use /exec-shell or call your LLM provider directly.",
    )


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
):
    """Execute a natural language request via the configured runner."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)

    result = await BACKEND.run_sync(request.content, request.system_prompt, agent_id=x_agent_id, owner_id=x_owner_id)
    return ExecutionResponse(**result)


@router.post("/code/execute", response_model=ExecutionResponse)
async def execute_code(
    request: CodeRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    """Direct code execution endpoint (bypasses any LLM)."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

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
):
    """Clone or update a project repo for a specific agent."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not x_agent_id:
        raise HTTPException(status_code=400, detail="X-Agent-Id header required")

    try:
        project_dir = await ensure_agent_project(x_agent_id, request.project, request.git_url)
        return {"status": "success", "project_dir": project_dir}
    except Exception as e:
        logger.error(f"[Project] ensure failed for agent {x_agent_id[:12]}: {e}")
        return {"status": "error", "error": str(e)}


@router.post("/exec-shell")
async def exec_shell(
    request: ShellExecRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
):
    """Execute a shell command in the agent's project context."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    cwd = request.cwd
    if not cwd and x_agent_id:
        cwd = get_agent_project_dir(x_agent_id)
    if not cwd:
        cwd = PROJECTS_DIR
    if not os.path.isdir(cwd):
        return ExecutionResponse(status="error", output="", error=f"Directory not found: {cwd}")

    timeout = min(request.timeout, 120)

    try:
        proc = await asyncio.create_subprocess_exec(
            "bash", "-c", request.command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
        )
        stdout_bytes, stderr_bytes = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        stdout = stdout_bytes.decode("utf-8", errors="replace")
        stderr = stderr_bytes.decode("utf-8", errors="replace")

        output = stdout
        if stderr:
            output += f"\n[stderr] {stderr}"
        if proc.returncode != 0:
            output += f"\n[exit code: {proc.returncode}]"
            return ExecutionResponse(
                status="error",
                output=output[:10000],
                error=f"Command failed with exit code {proc.returncode}",
            )
        return ExecutionResponse(status="success", output=output[:10000])
    except asyncio.TimeoutError:
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
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)

    async def event_generator():
        try:
            yield f"data: {json.dumps({'status': 'starting', 'message': f'{BACKEND.name} execution started'})}\n\n"

            has_streamed_text = False
            async for event in BACKEND.stream_events(request.content, request.system_prompt, agent_id=x_agent_id, owner_id=x_owner_id):
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
    """Reset agent session — starts a fresh runner session on next invocation."""
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not x_agent_id:
        return {"status": "success", "message": "No session to reset"}

    removed = BACKEND.reset_agent_sessions(x_agent_id, x_task_id)
    if removed:
        return {"status": "success", "message": f"Reset {removed} session(s) for agent {x_agent_id[:12]}"}
    return {"status": "success", "message": "No session to reset"}


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
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)

    if not request.messages:
        raise HTTPException(status_code=400, detail="At least one message is required")

    prompt, system_prompt = messages_to_prompt(request.messages)
    if request.system_prompt:
        system_prompt = request.system_prompt

    model = request.model or RUNNER_MODEL

    async def stream_openai_response():
        completion_id = f"chatcmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        yield f"data: {json.dumps({'id': completion_id, 'object': 'chat.completion.chunk', 'created': created, 'model': model, 'choices': [{'index': 0, 'delta': {'role': 'assistant'}, 'finish_reason': None}]})}\n\n"

        has_streamed_text = False
        total_tokens = 0
        input_tokens = 0
        output_tokens_val = 0
        cost_usd = 0
        try:
            async for event in BACKEND.stream_events(prompt, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id):
                event_type = event.get("type", "")

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
            },
        }
        yield f"data: {json.dumps(finish_chunk)}\n\n"
        yield "data: [DONE]\n\n"

    if request.stream:
        return StreamingResponse(stream_openai_response(), media_type="text/event-stream")

    result = await BACKEND.run_sync(prompt, system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id)
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
):
    api_key = extract_api_key(x_api_key, authorization)
    verify_api_key(api_key)

    if not BACKEND.supports_agent:
        raise _agent_unsupported()

    _maybe_set_permissions(x_agent_id, x_agent_permissions)

    model = request.model or RUNNER_MODEL

    async def stream_openai_completion_response():
        completion_id = f"cmpl-{uuid.uuid4().hex}"
        created = int(time.time())

        has_streamed_text = False
        total_tokens = 0
        input_tokens = 0
        output_tokens_val = 0
        cost_usd = 0
        async for event in BACKEND.stream_events(request.prompt, request.system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id):
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

    result = await BACKEND.run_sync(request.prompt, request.system_prompt, agent_id=x_agent_id, owner_id=x_owner_id, task_id=x_task_id)
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
