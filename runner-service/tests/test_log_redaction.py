"""Every credential below is synthetic — invented for the test, never a real key."""
import logging
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from log_redaction import (  # noqa: E402
    REDACTED,
    SecretRedactingFilter,
    redact_log_text,
)

SYNTHETIC_KEY = "SYNTHETIC-runner-key-0123456789abcdef"


def _record(msg, args=()):
    return logging.LogRecord(
        name="uvicorn.error", level=logging.INFO, pathname=__file__, lineno=1,
        msg=msg, args=args, exc_info=None,
    )


@pytest.mark.parametrize(
    "text",
    [
        # The exact shape uvicorn logs for a WebSocket handshake.
        f"('10.0.1.7', 52344) - \"WebSocket /ws/terminal/abc?api_key={SYNTHETIC_KEY}"
        "&cols=120&rows=40\" [accepted]",
        f"GET /terminal/sessions?apikey={SYNTHETIC_KEY} HTTP/1.1",
        f"dialling wss://runner:8000/ws?token={SYNTHETIC_KEY}",
        f"Authorization: Bearer {SYNTHETIC_KEY}",
        f"x-api-key: {SYNTHETIC_KEY}",
        f"https://user:{SYNTHETIC_KEY}@runner.internal/ws",
    ],
)
def test_credentials_never_survive_a_log_line(text):
    scrubbed = redact_log_text(text)
    assert SYNTHETIC_KEY not in scrubbed
    assert REDACTED in scrubbed


def test_parameter_names_and_the_rest_of_the_line_stay_readable():
    scrubbed = redact_log_text(
        f"('10.0.1.7', 52344) - \"WebSocket /ws/terminal/abc?api_key={SYNTHETIC_KEY}"
        "&cols=120&rows=40\" [accepted]"
    )
    assert "/ws/terminal/abc?api_key=" in scrubbed
    assert "cols=120&rows=40" in scrubbed
    assert "[accepted]" in scrubbed


@pytest.mark.parametrize(
    "text",
    [
        "Runner Service starting (backend=claude-code)...",
        '127.0.0.1:0 - "GET /health HTTP/1.1" 200',
        "[Terminal] Created tmux session agent-42 for agent 42",
        "",
    ],
)
def test_ordinary_lines_are_untouched(text):
    assert redact_log_text(text) == text


def test_filter_redacts_arguments_without_reshaping_the_record():
    """uvicorn's access formatter unpacks record.args positionally.

    Redacting must therefore happen inside the tuple: dropping it (or changing
    its length) raises in the formatter instead of printing a log line.
    """
    record = _record(
        '%s - "WebSocket %s" [accepted]',
        (("10.0.1.7", 52344), f"/ws/terminal/abc?api_key={SYNTHETIC_KEY}"),
    )
    assert SecretRedactingFilter().filter(record) is True
    assert len(record.args) == 2
    assert record.msg == '%s - "WebSocket %s" [accepted]'
    assert SYNTHETIC_KEY not in record.getMessage()
    assert f"api_key={REDACTED}" in record.getMessage()


def test_filter_handles_a_secret_baked_into_the_format_string():
    record = _record(f"dialled runner ?api_key={SYNTHETIC_KEY} for agent %s", ("abc",))
    assert SecretRedactingFilter().filter(record) is True
    message = record.getMessage()
    assert SYNTHETIC_KEY not in message
    assert "for agent abc" in message


def test_filter_handles_dict_style_arguments():
    # A mapping is passed as the sole positional arg; LogRecord unwraps it.
    record = _record("%(line)s", ({"line": f"?api_key={SYNTHETIC_KEY}"},))
    assert isinstance(record.args, dict)
    assert SecretRedactingFilter().filter(record) is True
    assert SYNTHETIC_KEY not in record.getMessage()


def test_filter_keeps_clean_records_exactly_as_they_were():
    record = _record("worker %s ready", ("1",))
    assert SecretRedactingFilter().filter(record) is True
    assert record.msg == "worker %s ready"
    assert record.args == ("1",)
