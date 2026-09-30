"""
Runner Service — task attachment routes (see task_files.py).

    POST /task-files/{task_id}/sync   {files: [{name, sha256}]}
         → {dir, missing}: prunes files no longer attached, lists what to upload
    PUT  /task-files/{task_id}/{name} raw bytes → {path}
"""

import json
import os
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Request
from pydantic import BaseModel

from config import logger
from security import extract_api_key, verify_api_key
from agent_user import ensure_agent_user
from command_security import sanitize_env
from backends.claude_token_store import get_subprocess_kwargs
from task_files import (
    MAX_TASK_FILE_BYTES, run_helper, task_files_dir, valid_file_name, valid_task_id,
)

router = APIRouter()


class TaskFileRef(BaseModel):
    name: str
    sha256: str


class TaskFilesSyncRequest(BaseModel):
    files: list[TaskFileRef] = []


async def _agent_context(x_api_key, authorization, x_agent_id, x_owner_id, task_id):
    verify_api_key(extract_api_key(x_api_key, authorization))
    if not x_agent_id:
        raise HTTPException(status_code=400, detail="X-Agent-Id header required")
    if not valid_task_id(task_id):
        raise HTTPException(status_code=400, detail="invalid task id")
    agent_user = await ensure_agent_user(x_agent_id, owner_id=x_owner_id)
    home = (agent_user or {}).get("home")
    if not home:
        raise HTTPException(status_code=500, detail="agent home unavailable")
    return (
        task_files_dir(home, task_id),
        get_subprocess_kwargs(agent_user),
        sanitize_env(os.environ, agent_user=agent_user),
    )


@router.post("/task-files/{task_id}/sync")
async def sync_task_files(
    task_id: str,
    request: TaskFilesSyncRequest,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
):
    directory, kwargs, env = await _agent_context(
        x_api_key, authorization, x_agent_id, x_owner_id, task_id
    )
    for f in request.files:
        if not valid_file_name(f.name):
            raise HTTPException(status_code=400, detail=f"invalid file name: {f.name!r}")
    manifest = [{"name": f.name, "sha256": f.sha256.lower()} for f in request.files]
    try:
        return await run_helper(["sync", directory, json.dumps(manifest)], kwargs, env)
    except Exception as e:
        logger.error(f"[TaskFiles] sync failed for task {task_id[:8]}: {e}")
        raise HTTPException(status_code=500, detail=f"sync failed: {e}")


@router.put("/task-files/{task_id}/{name}")
async def write_task_file(
    task_id: str,
    name: str,
    request: Request,
    x_api_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
    x_agent_id: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
):
    directory, kwargs, env = await _agent_context(
        x_api_key, authorization, x_agent_id, x_owner_id, task_id
    )
    if not valid_file_name(name):
        raise HTTPException(status_code=400, detail="invalid file name")
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_TASK_FILE_BYTES:
        raise HTTPException(status_code=413, detail="file too large")
    body = await request.body()
    if len(body) > MAX_TASK_FILE_BYTES:
        raise HTTPException(status_code=413, detail="file too large")
    try:
        return await run_helper(["write", directory, name], kwargs, env, stdin_bytes=body)
    except Exception as e:
        logger.error(f"[TaskFiles] write failed for task {task_id[:8]}: {e}")
        raise HTTPException(status_code=500, detail=f"write failed: {e}")
