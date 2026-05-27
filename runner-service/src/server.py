#!/usr/bin/env python3
"""
Runner Service — Generic agent runtime.

A single FastAPI service that adapts to one of several agent backends
(claude-code, openclaw, hermes, opencode, sandbox) selected via the
RUNNER_TYPE env var.

Layout:
  config.py            — config + RUNNER_TYPE
  models.py            — Pydantic schemas
  security.py          — API key
  agent_user.py        — per-agent isolated home + project workspace
  code_executor.py     — direct python/shell execution
  routes_api.py        — agent execution + shell exec endpoints
  routes_auth.py       — auth endpoints (delegates to backend)
  backends/            — backend implementations
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
import uvicorn

from config import RUNNER_TYPE, logger
from backends import BACKEND
from routes_api import router as api_router
from routes_auth import router as auth_router
from routes_terminal import router as terminal_router
import pty_session


app = FastAPI(
    title=f"Runner Service ({RUNNER_TYPE})",
    description=f"Generic agent runtime — currently configured as: {RUNNER_TYPE}",
    version="1.0.0",
)

app.include_router(auth_router)
app.include_router(api_router)
# Interactive terminal endpoints. Always mounted; the WS handler returns
# WS_1003_UNSUPPORTED_DATA when the backend doesn't expose a CLI TUI, so
# the route is harmless on non-CLI runners.
app.include_router(terminal_router)


@asynccontextmanager
async def lifespan(application: FastAPI):
    logger.info(f"Runner Service starting (backend={BACKEND.name})...")
    await BACKEND.startup()
    yield
    logger.info("Runner Service shutting down...")
    # Tear down any live PTY sessions BEFORE the backend shuts down so the
    # subprocesses get a chance to receive Ctrl-C / SIGTERM cleanly.
    await pty_session.close_all_sessions()
    await BACKEND.shutdown()


app.router.lifespan_context = lifespan


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")

    uvicorn.run(
        app,
        host=host,
        port=port,
        log_level=os.getenv("LOG_LEVEL", "info").lower(),
    )
