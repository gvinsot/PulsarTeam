"""
Runner Service — relay a browser OAuth callback to a CLI's loopback server.

`codex` (and any CLI that copies its flow) signs in by opening
auth.openai.com with `redirect_uri=http://127.0.0.1:1455/auth/callback` and
listening on that port INSIDE this container. The user's browser can't reach
it: after authenticating, it lands on a dead `127.0.0.1:1455` page. The
redirect_uri can't be rewritten to a PulsarTeam address either — OpenAI only
accepts the loopback URIs registered for the public codex client, and the CLI
repeats the same value when it exchanges the code.

So the user pastes that dead callback URL into the terminal, the frontend
forwards it as a `{type: "oauth_callback"}` control frame, and this module
replays it against the CLI's listener — the CLI then exchanges the code with
its own PKCE verifier and writes auth.json, exactly as if the browser had
reached it.

Only the query string of the pasted URL is used. The target is always
`http://127.0.0.1:<allowed port>/auth/callback`, so the relay can't be aimed
at any other host, port or path.
"""
from __future__ import annotations

import html
import re
import urllib.parse
from typing import Optional

import httpx


# codex binds 1455 and falls back to 1457 when 1455 stays busy (another
# agent's login in progress): see codex-rs/login/src/server.rs.
ALLOWED_PORTS = (1455, 1457)
_LOOPBACK_HOSTS = ("127.0.0.1", "localhost")
_CALLBACK_PATH = "/auth/callback"
_SUCCESS_PATH = "/success"
# The CLI exchanges the code with auth.openai.com before it answers.
_TIMEOUT = 30.0


def parse_callback_url(raw: str) -> Optional[tuple[int, str]]:
    """Return (port, normalized query) when `raw` is a loopback OAuth
    callback URL a CLI could be listening for, else None."""
    if not isinstance(raw, str):
        return None
    raw = raw.strip()
    if not raw or any(c.isspace() for c in raw):
        return None
    try:
        parts = urllib.parse.urlsplit(raw)
        port = parts.port
    except ValueError:
        return None
    if parts.scheme not in ("http", "https"):
        return None
    if (parts.hostname or "").lower() not in _LOOPBACK_HOSTS:
        return None
    if port not in ALLOWED_PORTS or parts.path != _CALLBACK_PATH:
        return None
    pairs = urllib.parse.parse_qsl(parts.query, keep_blank_values=True)
    keys = {k for k, _ in pairs}
    # A successful authorization carries code+state; a refused one carries
    # error(+state) — relaying that lets the CLI report it and stop waiting.
    if "state" not in keys or not ({"code", "error"} & keys):
        return None
    return port, urllib.parse.urlencode(pairs)


def _success_target(location: str, port: int) -> Optional[str]:
    """The loopback /success URL to follow after the callback, or None when
    the CLI redirected elsewhere (its hosted success page — the login has
    already completed in that case)."""
    if not location:
        return None
    parts = urllib.parse.urlsplit(urllib.parse.urljoin(f"http://127.0.0.1:{port}/", location))
    if (parts.hostname or "").lower() not in _LOOPBACK_HOSTS or parts.port != port:
        return None
    if parts.path != _SUCCESS_PATH:
        return None
    query = f"?{parts.query}" if parts.query else ""
    return f"http://127.0.0.1:{port}{_SUCCESS_PATH}{query}"


_MESSAGE_RE = re.compile(r'<p class="message">(.*?)</p>', re.S)
_HEADING_RE = re.compile(r"<h1>(.*?)</h1>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def _error_detail(resp: httpx.Response) -> str:
    """The CLI's own explanation: its error page's message paragraph (codex
    renders one), else the raw body (plain-text errors like "State
    mismatch"), else the status."""
    body = resp.text or ""
    for pattern in (_MESSAGE_RE, _HEADING_RE):
        m = pattern.search(body)
        if m:
            text = html.unescape(_TAG_RE.sub("", m.group(1))).strip()
            if text:
                return " ".join(text.split())[:300]
    if "<" not in body:
        text = " ".join(body.split())
        if text:
            return text[:300]
    return f"HTTP {resp.status_code}"


async def relay_callback(raw_url: str, transport: Optional[httpx.AsyncBaseTransport] = None) -> dict:
    """Replay a pasted callback URL against the CLI's loopback listener.

    Returns {"ok": bool, "message": str}. Never raises."""
    parsed = parse_callback_url(raw_url)
    if parsed is None:
        return {"ok": False, "message": "Not a CLI sign-in callback URL."}
    port, query = parsed
    target = f"http://127.0.0.1:{port}{_CALLBACK_PATH}?{query}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False,
                                     transport=transport) as client:
            resp = await client.get(target)
            # Only a redirect means success: codex answers a failed code
            # exchange with a 200 "Sign-in could not be completed" page, which
            # abandons that login; a bad state gets a 400 and the login keeps
            # waiting for the right callback.
            if not resp.is_redirect:
                hint = (
                    "this URL is from another sign-in attempt — paste the one from the latest link."
                    if resp.status_code == 400 else
                    "start the sign-in again in the terminal and use the new link."
                )
                return {"ok": False, "message": f"Sign-in failed: {_error_detail(resp)} — {hint}"}
            # The CLI only finishes its login once /success is served; the
            # tokens were already written while handling the callback.
            follow = _success_target(resp.headers.get("location", ""), port)
            if follow:
                try:
                    await client.get(follow)
                except httpx.HTTPError:
                    pass
    except httpx.ConnectError:
        return {
            "ok": False,
            "message": f"No sign-in is waiting on port {port} — it was cancelled or timed out. "
                       "Start the sign-in again in the terminal and use the new link.",
        }
    except httpx.HTTPError as e:
        return {"ok": False, "message": f"Relaying the callback failed: {e}"}
    return {"ok": True, "message": "Signed in."}
