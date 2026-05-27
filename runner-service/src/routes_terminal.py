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
from typing import Optional

from fastapi import APIRouter, HTTPException, Header, Query, WebSocket, WebSocketDisconnect, status
from fastapi.responses import JSONResponse

from config import API_KEY, logger
from backends import BACKEND
import pty_session


router = APIRouter()


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

    async def factory() -> dict:
        # Per-spawn provisioning (agent HOME, token hydration, project clone,
        # env, preexec_fn for the per-agent UID drop). Each backend that
        # supports interactive mode implements this in its prepare_interactive.
        return await BACKEND.prepare_interactive(agent_id=agent_id, owner_id=owner_id)

    try:
        session = await pty_session.get_or_create_session(
            agent_id=agent_id, factory=factory, cols=cols, rows=rows,
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
                # Control frames piggy-back on text messages (resize, paste-as-input,
                # etc.). Anything that isn't recognised JSON is treated as raw input
                # so a fallback xterm.js client without our addon still works.
                text = msg["text"]
                try:
                    ctrl = json.loads(text)
                except Exception:
                    await session.write(text.encode("utf-8"))
                    continue
                ctype = ctrl.get("type") if isinstance(ctrl, dict) else None
                if ctype == "resize":
                    try:
                        c = int(ctrl.get("cols", session.cols))
                        r = int(ctrl.get("rows", session.rows))
                    except (TypeError, ValueError):
                        continue
                    await session.resize(c, r)
                elif ctype == "input":
                    raw = ctrl.get("data", "")
                    if isinstance(raw, str):
                        await session.write(raw.encode("utf-8"))
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
