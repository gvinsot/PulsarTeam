"""OAuth callback relay: a pasted dead 127.0.0.1:1455 URL reaches the CLI's
loopback login server — and nothing else."""
import asyncio
import sys
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from oauth_callback_relay import parse_callback_url, relay_callback  # noqa: E402

CALLBACK = "http://127.0.0.1:1455/auth/callback?code=ac_abc123&scope=openid+profile&state=st_XYZ"


def _run(coro):
    return asyncio.run(coro)


class _Recorder:
    """A fake CLI login server: records requests, answers from `routes`."""

    def __init__(self, routes):
        self.routes = routes
        self.requests = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        handler = self.routes.get(request.url.path)
        if handler is None:
            return httpx.Response(404, text="Not Found")
        return handler(request)

    def transport(self):
        return httpx.MockTransport(self)


# ── parse_callback_url ────────────────────────────────────────────────────

def test_parse_accepts_loopback_callbacks():
    assert parse_callback_url(CALLBACK) == (1455, "code=ac_abc123&scope=openid+profile&state=st_XYZ")
    assert parse_callback_url("http://localhost:1455/auth/callback?code=c&state=s")[0] == 1455
    # codex's fallback port when 1455 stays busy
    assert parse_callback_url("http://127.0.0.1:1457/auth/callback?code=c&state=s")[0] == 1457
    # surrounding whitespace from a paste
    assert parse_callback_url(f"  {CALLBACK}\n") is not None


def test_parse_accepts_an_authorization_error():
    assert parse_callback_url(
        "http://127.0.0.1:1455/auth/callback?error=access_denied&state=s"
    ) is not None


def test_parse_rejects_anything_that_is_not_a_loopback_callback():
    for url in (
        "https://evil.example/auth/callback?code=c&state=s",
        "http://127.0.0.2:1455/auth/callback?code=c&state=s",
        "http://127.0.0.1:8000/auth/callback?code=c&state=s",
        "http://127.0.0.1/auth/callback?code=c&state=s",
        "http://127.0.0.1:1455/success?code=c&state=s",
        "http://127.0.0.1:1455/auth/callback?code=c",          # no state
        "http://127.0.0.1:1455/auth/callback?state=s",         # no code/error
        "http://127.0.0.1:1455/auth/callback?code=c&state=s extra text",
        "file:///etc/passwd",
        "http://127.0.0.1:99999/auth/callback?code=c&state=s",  # invalid port
        "",
        None,
    ):
        assert parse_callback_url(url) is None, url


# ── relay_callback ────────────────────────────────────────────────────────

def test_relay_hits_the_loopback_listener_then_follows_to_success():
    server = _Recorder({
        "/auth/callback": lambda r: httpx.Response(
            302, headers={"Location": "http://127.0.0.1:1455/success?id_token=x&plan_type=pro"}
        ),
        "/success": lambda r: httpx.Response(200, text="Signed in"),
    })
    result = _run(relay_callback(CALLBACK, transport=server.transport()))
    assert result["ok"] is True
    urls = [str(r.url) for r in server.requests]
    assert urls == [
        "http://127.0.0.1:1455/auth/callback?code=ac_abc123&scope=openid+profile&state=st_XYZ",
        "http://127.0.0.1:1455/success?id_token=x&plan_type=pro",
    ]


def test_relay_always_targets_127_0_0_1_even_when_localhost_was_pasted():
    server = _Recorder({
        "/auth/callback": lambda r: httpx.Response(302, headers={"Location": "/success"}),
        "/success": lambda r: httpx.Response(200, text="Signed in"),
    })
    result = _run(relay_callback(
        "http://localhost:1457/auth/callback?code=c&state=s", transport=server.transport()
    ))
    assert result["ok"] is True
    assert [str(r.url) for r in server.requests] == [
        "http://127.0.0.1:1457/auth/callback?code=c&state=s",
        "http://127.0.0.1:1457/success",
    ]


# Trimmed from what codex 0.159.2 really answers when the code exchange fails.
CODEX_ERROR_PAGE = """<!doctype html><html><head><title>Codex Sign-in Error</title>
<style>body { margin: 0; }</style></head><body><div class="card">
<h1>Sign-in could not be completed</h1>
<p class="message">Token exchange failed: token endpoint returned status 401 Unauthorized:
 Could not validate your token. Please try signing in again.</p>
<code>token_exchange_failed</code></div></body></html>"""


def test_relay_reports_a_failed_exchange_served_as_a_200_page():
    server = _Recorder({"/auth/callback": lambda r: httpx.Response(200, html=CODEX_ERROR_PAGE)})
    result = _run(relay_callback(CALLBACK, transport=server.transport()))
    assert result["ok"] is False
    assert "Token exchange failed: token endpoint returned status 401 Unauthorized: Could not" in result["message"]
    assert "<" not in result["message"]
    assert "start the sign-in again" in result["message"]


def test_relay_does_not_follow_a_hosted_success_redirect():
    server = _Recorder({
        "/auth/callback": lambda r: httpx.Response(
            302, headers={"Location": "https://chatgpt.com/codex/success?source=login"}
        ),
    })
    result = _run(relay_callback(CALLBACK, transport=server.transport()))
    assert result["ok"] is True
    assert len(server.requests) == 1


def test_relay_reports_the_cli_rejection():
    server = _Recorder({"/auth/callback": lambda r: httpx.Response(400, text="State mismatch")})
    result = _run(relay_callback(CALLBACK, transport=server.transport()))
    assert result["ok"] is False
    assert "State mismatch" in result["message"]
    # the CLI keeps waiting after a bad state: point at the right URL, not a restart
    assert "latest link" in result["message"]


def test_relay_explains_when_no_login_is_waiting():
    def refuse(request):
        raise httpx.ConnectError("connection refused", request=request)

    result = _run(relay_callback(CALLBACK, transport=httpx.MockTransport(refuse)))
    assert result["ok"] is False
    assert "No sign-in is waiting on port 1455" in result["message"]


def test_relay_refuses_a_non_callback_url_without_any_request():
    server = _Recorder({})
    result = _run(relay_callback("https://evil.example/x", transport=server.transport()))
    assert result["ok"] is False
    assert server.requests == []
