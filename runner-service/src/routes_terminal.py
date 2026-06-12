"""
Runner Service — Interactive terminal endpoints.

Exposes a shared-PTY WebSocket for backends that support a real CLI TUI
(claude-code, codex, opencode, openclaw). One agent = one subprocess + one
PTY, attached by any number of concurrent WebSocket clients. The chat-style
`/v1/chat/completions` endpoint is intentionally NOT used for these runners
in interactive mode anymore — the frontend points its terminal pane at the
WebSocket below and the user sees / drives the real CLI.

Routes:
    GET    /terminal/sessions                   — list active sessions
    GET    /terminal/sessions/{agent_id}        — status of one session
    DELETE /terminal/sessions/{agent_id}        — kill a session
    POST   /terminal/sessions/{agent_id}/input  — paste task prompt into TUI
    WS     /ws/terminal/{agent_id}              — attach to / create a session

The WS protocol is bidirectional binary + small JSON control frames:
    server → client : binary frames (raw PTY output bytes)
    client → server : binary frames (raw keystrokes to write into the PTY)
                      OR text frames carrying JSON {type: "resize", cols, rows}

Authentication mirrors the rest of the service: the caller (team-api proxy)
supplies the shared `CODER_API_KEY` via the `Authorization: Bearer …` header
or the `?api_key=` query parameter on the WS handshake.
"""
from __future__ import annotations

import json
import os
import asyncio
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Query, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from config import API_KEY, logger
from backends import BACKEND
import pty_session


router = APIRouter()


class TerminalInputRequest(BaseModel):
    input: str = Field(..., min_length=1)
    submit: bool = True
    bracketed_paste: bool = True
    cols: int = 120
    rows: int = 40


def _check_api_key(header: Optional[str], qs_key: Optional[str]) -> None:
    presented = None
    if header and header.lower().startswith("bearer "):
        presented = header.split(" ", 1)[1].strip()
    elif header:
        presented = header.strip()
    if not presented and qs_key:
        presented = qs_key
    if not presented or presented != API_KEY:
        raise HTTPException(status_code=401, detail="Invalid API key")


def _maybe_set_permissions(agent_id: Optional[str], header: Optional[str]) -> None:
    if agent_id and header:
        try:
            permissions = json.loads(header)
            if isinstance(permissions, dict):
                BACKEND.set_agent_permissions(agent_id, permissions)
        except (json.JSONDecodeError, TypeError):
            pass


def _maybe_set_llm_config(agent_id: Optional[str], header: Optional[str]) -> bool:
    if agent_id and header:
        try:
            cfg = json.loads(header)
            if isinstance(cfg, dict):
                previous = getattr(BACKEND, "_llm_configs", {}).get(agent_id)
                BACKEND.set_agent_llm_config(agent_id, cfg)
                return previous != cfg
            if cfg is None:
                previous = getattr(BACKEND, "_llm_configs", {}).get(agent_id)
                BACKEND.set_agent_llm_config(agent_id, None)
                return previous is not None
        except (json.JSONDecodeError, TypeError):
            pass
    return False


def _llm_config_fingerprint(header: Optional[str]) -> Optional[str]:
    if not header:
        return None
    try:
        return json.dumps(json.loads(header), sort_keys=True, separators=(",", ":"))
    except (json.JSONDecodeError, TypeError):
        return header.strip() or None


@router.get("/terminal/sessions")
def list_terminal_sessions(authorization: Optional[str] = Header(None)) -> JSONResponse:
    _check_api_key(authorization, None)
    return JSONResponse({"sessions": pty_session.list_sessions()})


@router.get("/terminal/sessions/{agent_id}")
def get_terminal_session(agent_id: str, authorization: Optional[str] = Header(None)) -> JSONResponse:
    _check_api_key(authorization, None)
    session = pty_session.get_session(agent_id)
    if session is None:
        raise HTTPException(status_code=404, detail="No session for that agent")
    return JSONResponse(session.status())


@router.delete("/terminal/sessions/{agent_id}")
async def delete_terminal_session(agent_id: str, authorization: Optional[str] = Header(None)) -> JSONResponse:
    _check_api_key(authorization, None)
    closed = await pty_session.close_session(agent_id)
    return JSONResponse({"closed": closed})


@router.post("/terminal/sessions/{agent_id}/input")
async def send_terminal_input(
    agent_id: str,
    request: TerminalInputRequest,
    authorization: Optional[str] = Header(None),
    x_owner_id: Optional[str] = Header(None),
    x_agent_permissions: Optional[str] = Header(None),
    x_llm_config: Optional[str] = Header(None),
) -> JSONResponse:
    """Inject a real prompt into the backend TUI.

    This is reserved for workflow execute actions: when the API has selected
    an idle CLI runner, it pastes the task instruction into the actual
    terminal input instead of mirroring synthetic text into scrollback.
    """
    _check_api_key(authorization, None)
    if not getattr(BACKEND, "supports_interactive_terminal", False):
        raise HTTPException(
            status_code=501,
            detail=f"Backend {BACKEND.name} does not support interactive terminals",
        )

    _maybe_set_permissions(agent_id, x_agent_permissions)
    existing = pty_session.get_session(agent_id)
    session_was_alive = bool(existing and existing.is_alive())
    if session_was_alive:
        # A task prompt should be pasted into the current interactive TUI, not
        # restart it because the API's config header differs from the browser's.
        config_fingerprint = existing.config_fingerprint
    else:
        _maybe_set_llm_config(agent_id, x_llm_config)
        config_fingerprint = _llm_config_fingerprint(x_llm_config)

    async def factory() -> dict:
        return await BACKEND.prepare_interactive(agent_id=agent_id, owner_id=x_owner_id)

    session = await pty_session.get_or_create_session(
        agent_id=agent_id,
        factory=factory,
        cols=request.cols,
        rows=request.rows,
        config_fingerprint=config_fingerprint,
    )

    # A workflow-injected prompt must land in the TUI's message box, not in a
    # startup confirmation screen (trust folder / bypass-permissions) that
    # would swallow it, nor mid-response where it would interleave. Wait until
    # the CLI returns to an input-ready prompt — this doubles as the
    # "PTY-is-free" gate so a CLI runner that's still finishing a previous turn
    # doesn't get a second prompt jammed into its stream. The reader loop
    # auto-answers trust/bypass concurrently. Falls back to a short fixed delay
    # only when the readiness hint never appears within the window.
    #   • fresh session  → longer window (CLI is still booting its TUI)
    #   • alive session  → wait for the current turn to wind down to the prompt
    ready_timeout = float(os.getenv(
        "TERMINAL_INPUT_READY_TIMEOUT_SEC",
        "45" if not session_was_alive else "30",
    ))
    ready = await session.wait_until_input_ready(timeout=ready_timeout)
    if not ready:
        delay = float(os.getenv("TERMINAL_INPUT_STARTUP_DELAY_SEC", "0.75"))
        if delay > 0:
            await asyncio.sleep(delay)
        logger.warning(
            f"[Terminal] Input-ready hint not seen for agent {agent_id} within "
            f"{ready_timeout}s — pasting prompt anyway after {delay}s fallback"
        )

    # Fresh task attempt: drop any latched auth error from a previous run so a
    # recovered login isn't reported as still-broken to the API.
    session.clear_auth_error()

    payload = request.input.encode("utf-8", errors="replace")
    if request.bracketed_paste:
        payload = b"\x1b[200~" + payload + b"\x1b[201~"
    if request.submit:
        payload += b"\r"
    await session.write(payload)
    return JSONResponse({"status": "success", "alive": session.is_alive()})


@router.websocket("/ws/terminal/{agent_id}")
async def ws_terminal(
    websocket: WebSocket,
    agent_id: str,
    api_key: Optional[str] = Query(None),
    owner_id: Optional[str] = Query(None),
    cols: int = Query(120),
    rows: int = Query(40),
):
    """Attach a WebSocket client to the (shared) PTY session for `agent_id`.

    If no session exists yet for this agent_id, spawn one using the backend's
    `prepare_interactive` recipe. Otherwise replay the scrollback and join.

    Disconnection (client side OR PTY EOF) just detaches this client — the
    session lives on for other connected admins until either the subprocess
    exits or the idle timeout in pty_session.IDLE_TIMEOUT_SEC kicks in.
    """
    # Authenticate on the handshake. Header-based auth is awkward over the
    # browser WS API (you can't set arbitrary headers), so we accept the
    # API key on the query string too — the team-api proxy is the only
    # caller and supplies it server-side.
    auth_header = websocket.headers.get("authorization")
    try:
        _check_api_key(auth_header, api_key)
    except HTTPException:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    if not getattr(BACKEND, "supports_interactive_terminal", False):
        await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA,
                              reason=f"Backend {BACKEND.name} does not support interactive terminals")
        return

    await websocket.accept()
    _maybe_set_permissions(agent_id, websocket.headers.get("x-agent-permissions"))
    x_llm_config = websocket.headers.get("x-llm-config")
    existing = pty_session.get_session(agent_id)
    if existing and existing.is_alive():
        # Attaching a browser must never kill a task that was just injected by
        # POST /terminal/sessions/:id/input. The running CLI owns its config
        # until an explicit terminal reset/reload starts a new process.
        config_fingerprint = existing.config_fingerprint
    else:
        _maybe_set_llm_config(agent_id, x_llm_config)
        config_fingerprint = _llm_config_fingerprint(x_llm_config)

    async def factory() -> dict:
        # Per-spawn provisioning (agent HOME, token hydration, project clone,
        # env, preexec_fn for the per-agent UID drop). Each backend that
        # supports interactive mode implements this in its prepare_interactive.
        return await BACKEND.prepare_interactive(agent_id=agent_id, owner_id=owner_id)

    try:
        session = await pty_session.get_or_create_session(
            agent_id=agent_id, factory=factory, cols=cols, rows=rows,
            config_fingerprint=config_fingerprint,
        )
    except NotImplementedError as e:
        await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        await websocket.close(code=status.WS_1003_UNSUPPORTED_DATA)
        return
    except Exception as e:
        logger.exception(f"[Terminal] Failed to start session for agent {agent_id}")
        await websocket.send_text(json.dumps({"type": "error", "message": f"Failed to start session: {e}"}))
        await websocket.close(code=status.WS_1011_INTERNAL_ERROR)
        return

    # Adopt this client's geometry up front so the shared PTY matches the
    # browser terminal that just attached. A PTY has one canonical size, so the
    # latest active terminal wins, like an SSH session resized from its client.
    if cols != session.cols or rows != session.rows:
        await session.resize(cols, rows)

    async def push_bytes_to_client(data: bytes) -> None:
        # A zero-length payload is the convention used by PtySession to
        # tell us the subprocess just exited — close the socket politely.
        if not data:
            try:
                await websocket.send_text(json.dumps({
                    "type": "exit",
                    "code": session.exit_code,
                    "tail": session.tail_text(2048),
                }))
            finally:
                try:
                    await websocket.close()
                except Exception:
                    pass
            return
        await websocket.send_bytes(data)

    label = f"ws@{websocket.client.host}:{websocket.client.port}" if websocket.client else "ws"
    await websocket.send_text(json.dumps({"type": "reset"}))
    await pty_session.replay_terminal_transcript(agent_id, push_bytes_to_client)
    client_id = await session.attach(push_bytes_to_client, label=label)

    try:
        while True:
            msg = await websocket.receive()
            # WS messages can be binary, text, or a close envelope.
            if msg.get("type") == "websocket.disconnect":
                break
            if "bytes" in msg and msg["bytes"] is not None:
                await session.write(msg["bytes"])
            elif "text" in msg and msg["text"] is not None:
                # Control frames (resize, refresh) piggy-back on text messages;
                # keystrokes only ever arrive as binary frames. Unparseable
                # text frames are ignored.
                try:
                    ctrl = json.loads(msg["text"])
                except Exception:
                    continue
                ctype = ctrl.get("type") if isinstance(ctrl, dict) else None
                if ctype == "resize":
                    try:
                        c = int(ctrl.get("cols", session.cols))
                        r = int(ctrl.get("rows", session.rows))
                    except (TypeError, ValueError):
                        continue
                    await session.resize(c, r)
                elif ctype == "refresh":
                    # Client asks for an immediate repaint of the current screen
                    # (e.g. it just attached and wants live state now, not on the
                    # next output). tmux re-emits the authoritative screen.
                    await session.request_repaint()
                # Unknown control frames are ignored on purpose — keeps the
                # protocol forward-compatible.
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"[Terminal] ws_terminal loop error for {agent_id}: {e}")
    finally:
        await session.detach(client_id)
        try:
            await websocket.close()
        except Exception:
            pass
