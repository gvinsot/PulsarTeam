import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from auth_error_detect import (  # noqa: E402
    AUTH_ERROR_RE,
    AUTH_ERROR_401_RE,
    HTTP_401_RE,
    looks_like_auth_error,
)


# ── Shared detector: distinctive banners always count ──────────────────────
def test_distinctive_banners_detected():
    assert looks_like_auth_error("Invalid API key · Please run /login")
    assert looks_like_auth_error("OAuth token has expired")
    assert looks_like_auth_error("please run /login to authenticate")
    assert looks_like_auth_error("Invalid authentication credentials")


def test_authentication_error_needs_a_real_401():
    # Bare type string with no 401 is not an auth failure (agent output, source).
    assert not looks_like_auth_error('{"type":"authentication_error"}')
    assert not looks_like_auth_error("grep -rn authentication_error src/")
    # Co-occurring with a genuine 401 it is.
    assert looks_like_auth_error('API error 401: {"type":"authentication_error"}')


def test_401_is_word_boundaried():
    # "401" inside a larger number is not an HTTP 401.
    assert HTTP_401_RE.search("HTTP 401 Unauthorized")
    assert not HTTP_401_RE.search("byte 14012")
    assert not HTTP_401_RE.search("4015 tokens")
    assert not looks_like_auth_error("authentication_error at offset 14012")


# ── claude_code.run_sync channel split: the weak authentication_error+401
# heuristic is restricted to stderr so the agent's OWN reply (echoed into
# stdout's JSON envelope) can never latch a phantom auth failure. This mirrors
# the inline logic in ClaudeCodeBackend.run_sync. ──────────────────────────
def _sync_triggers(stdout: str, stderr: str) -> bool:
    combined = f"{stdout} {stderr}".lower()
    banner = AUTH_ERROR_RE.search(combined)
    api_401 = bool(AUTH_ERROR_401_RE.search(stderr) and HTTP_401_RE.search(stderr))
    return bool(banner or api_401)


def test_agent_reply_quoting_auth_strings_does_not_trigger():
    # The shape of a task that merely *describes* the runner's auth check —
    # both "authentication_error" and a standalone "401" land in the reply
    # (stdout), stderr is clean. Must NOT trigger a re-auth (was the blocking
    # infinite-recursion bug).
    reply = "the check: authentication_error in combined and 401 in combined -> blocking"
    assert not _sync_triggers(reply, "")


def test_genuine_api_auth_failure_on_stderr_triggers():
    assert _sync_triggers("", 'API error 401: {"type":"authentication_error"}')


def test_interactive_tui_banner_on_stdout_triggers():
    assert _sync_triggers("Invalid API key · Please run /login", "")
    assert _sync_triggers("OAuth token has expired", "")


def test_unrelated_401_on_stderr_does_not_trigger():
    assert not _sync_triggers("", "HTTP/1.1 401 Unauthorized from https://example.com/api")
