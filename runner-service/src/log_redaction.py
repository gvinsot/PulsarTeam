"""Credential scrubbing for the runner's own log stream.

`secret_filter` scrubs terminal text that leaves the runner. This module
covers the other direction: text the runner *writes about itself*. The case
that motivated it is uvicorn's handshake line

    ('10.0.1.7', 52344) - "WebSocket /ws/terminal/abc?api_key=<CODER_API_KEY>…" [accepted]

which put the shared runner API key, in clear, into `docker service logs` and
into whatever ships them off the node. The key is also accepted on the
`Authorization` header (and the team-api proxy now uses it), but the query
parameter stays supported for older proxies — so the log line has to be safe
regardless of how the caller authenticated.

Installed as a `logging.Filter`, which every record passes through before a
handler formats it. Two rules keep the filter from corrupting records:

  • Arguments are redacted before the format string. uvicorn's access
    formatter unpacks `record.args` positionally, so the tuple must keep its
    shape — replacing the rendered message and clearing `args` would raise
    inside the formatter.
  • The format string is only rewritten when redacting the arguments was not
    enough (the secret was baked into the literal), and then `args` is cleared
    so the surviving `%s` placeholders cannot fail to render.
"""
from __future__ import annotations

import logging
import re
from typing import Any

REDACTED = "[redacted]"

# Cheap gate: a record whose text contains none of these cannot match any rule
# below, and the great majority of log lines don't. One scan instead of five.
_HINT_RE = re.compile(
    r"(?i)key|token|secret|pass|auth|credential|bearer|signature|sig=|code=|://"
)

_RULES: list[tuple[re.Pattern, str]] = [
    # Query/fragment parameters carrying a credential: ?api_key=…, &token=…
    # The parameter *name* is kept so the line stays diagnosable.
    (
        re.compile(
            r"(?i)([?&#;](?:access_token|refresh_token|id_token|session_token|token|code"
            r"|api[_-]?key|apikey|client_secret|secret|password|passwd|pwd|auth"
            r"|authorization|credential|sig|signature|user_code|device_code)=)"
            r"[^\s&#\"'<>]+"
        ),
        r"\1" + REDACTED,
    ),
    # Credentials in a URL authority: https://user:pass@host
    (
        re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@"),
        r"\1" + REDACTED + "@",
    ),
    # Authorization headers and their CLI equivalents.
    (
        re.compile(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._\-~+/=]{8,}"),
        r"\1 " + REDACTED,
    ),
    (
        re.compile(
            r"(?i)\b(authorization|proxy-authorization|x-api-key)(\s*[:=]\s*)"
            r"(?:\"[^\"\r\n]*\"?|'[^'\r\n]*'?|[^\s,;]+)"
        ),
        r"\1\2" + REDACTED,
    ),
]

# Loggers whose records are emitted by libraries, i.e. not through our own
# logger and therefore not covered by the filters we put on root's handlers.
# A filter on a logger runs for records logged *to that logger*; propagation
# to an ancestor re-runs the ancestor's handlers, not its filters.
_LIBRARY_LOGGERS = (
    "uvicorn",
    "uvicorn.error",
    "uvicorn.access",
    "uvicorn.asgi",
    "websockets",
    "websockets.server",
    "fastapi",
    "httpx",
    "httpcore",
    "urllib3",
)


def redact_log_text(text: str) -> str:
    """Return `text` with credentials that leak through log lines masked."""
    if not text or not _HINT_RE.search(text):
        return text
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    return text


def _redact_value(value: Any) -> Any:
    return redact_log_text(value) if isinstance(value, str) else value


class SecretRedactingFilter(logging.Filter):
    """Mask credentials in every record that reaches a handler."""

    def filter(self, record: logging.LogRecord) -> bool:
        try:
            message = record.getMessage()
        except Exception:  # pragma: no cover - a broken record is the app's problem
            return True

        if redact_log_text(message) == message:
            return True

        # Prefer redacting the arguments: formatters (uvicorn's access
        # formatter in particular) may depend on record.args keeping its shape.
        if record.args:
            if isinstance(record.args, dict):
                record.args = {k: _redact_value(v) for k, v in record.args.items()}
            else:
                record.args = tuple(_redact_value(a) for a in record.args)
            try:
                message = record.getMessage()
            except Exception:  # pragma: no cover
                return True
            if redact_log_text(message) == message:
                return True

        # The secret was in the format string itself. Replace the rendered
        # message wholesale; the args are consumed, so they must be dropped.
        record.msg = redact_log_text(message)
        record.args = ()
        return True


def install(extra_logger_names: tuple[str, ...] = ()) -> SecretRedactingFilter:
    """Attach the filter to root's handlers and to the noisy library loggers.

    Returns the filter so a caller (tests, a later `basicConfig`) can re-attach
    it to a handler created after this ran.
    """
    log_filter = SecretRedactingFilter()
    root = logging.getLogger()
    for handler in root.handlers:
        handler.addFilter(log_filter)
    for name in _LIBRARY_LOGGERS + tuple(extra_logger_names):
        logging.getLogger(name).addFilter(log_filter)
    return log_filter
