"""Credential scrubbing for terminal text that leaves the runner.

Anything captured from a CLI's terminal can contain the operator's own
credentials: a `/login` screen prints a device-code URL, a failed API call
echoes an `Authorization: Bearer …` header, an env dump shows `GITHUB_TOKEN=…`.
That text is persisted into task history and broadcast over websockets, so it
must be scrubbed at the source — the broker — and again on the API side (an
older runner may not have this module).

The patterns below intentionally err towards over-redaction: a mangled log line
is a cosmetic problem, a leaked token is not. Two consequences of that stance
are worth spelling out, because both were live bypasses:

  • A quoted value is consumed WHOLE — spaces, punctuation and backslash
    escapes included. Stopping at the first space left `password="hunter two"`
    as `password="[redacted] two"`, and a value quoted with apostrophes
    (`API_TOKEN='…'`, `{'password': '…'}`) was not matched at all.
  • Key material whose delimiters were cut off is still key material. The PEM
    rule needs BEGIN *and* END, so a block truncated by a capture window, a
    line limit or a ring-buffer eviction slipped through as readable base64.
    Surviving half-delimiters and undelimited key bodies are handled
    separately, and callers can ask (via `find_truncated_secret`) whether the
    text carried such a fragment at all — text that cannot be bounded with
    confidence is better withheld than scrubbed and hoped about.
"""
import re
from typing import Optional

REDACTED = "[redacted]"

# The *name* half of an assignment: a token whose name says it holds a secret.
_SECRET_NAME = (
    r"[A-Za-z0-9_.\-]*(?:token|secret|password|passwd|api[_-]?key"
    r"|access[_-]?key|private[_-]?key|credential|auth[_-]?key)[A-Za-z0-9_.\-]*"
)

# The *value* half. Quoted forms (shell, JSON, Python dict, JS template) are
# matched to their closing quote so spaces and escaped quotes stay inside the
# secret; an unterminated quote deliberately runs to end of line rather than
# leaving the remainder readable. The bare form stops at whitespace or a
# statement separator, as before.
_SECRET_VALUE = (
    r"(?:"
    r'"(?:\\.|[^"\\\r\n])*"?'
    r"|'(?:\\.|[^'\\\r\n])*'?"
    r"|`(?:\\.|[^`\\\r\n])*`?"
    r"|[^\s,;]+"
    r")"
)

# Ordered: the more specific rules run first so a token inside a URL is masked
# as a parameter (keeping the parameter name readable) rather than by shape.
_RULES: list[tuple[re.Pattern, str]] = [
    # PEM blocks — replace the whole body, not line by line. Fragments that
    # lost a delimiter are handled by _scrub_key_fragments, after this rule has
    # taken every COMPLETE block out of the way.
    (
        re.compile(
            r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
            re.DOTALL,
        ),
        REDACTED,
    ),
    # Authentication parameters in a URL or query string: ?code=…, &token=…
    (
        re.compile(
            r"(?i)([?&#;](?:access_token|refresh_token|id_token|session_token|token|code"
            r"|api[_-]?key|apikey|client_secret|secret|password|passwd|pwd|auth"
            r"|authorization|credential|sig|signature|state|user_code|device_code)=)"
            r"[^\s&#\"'<>]+"
        ),
        r"\1" + REDACTED,
    ),
    # Credentials embedded in a URL authority: https://user:pass@host
    (
        re.compile(r"(?i)\b([a-z][a-z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@"),
        r"\1" + REDACTED + "@",
    ),
    # HTTP auth headers and their CLI equivalents: Bearer …, Basic …, token …
    (
        re.compile(r"(?i)\b(bearer|basic|token)\s+[A-Za-z0-9._\-~+/=]{8,}"),
        r"\1 " + REDACTED,
    ),
    (
        re.compile(r"(?i)\b(authorization|proxy-authorization)(\s*[:=]\s*)" + _SECRET_VALUE),
        r"\1\2" + REDACTED,
    ),
    # KEY=value / "key": "value" / {'key': 'value'} where the *name* says it is
    # a secret. The leading and trailing quote groups let the name itself be
    # quoted (JSON, Python dicts) instead of only the value.
    (
        re.compile(r"(?i)(['\"]?)\b(" + _SECRET_NAME + r")(['\"]?\s*[:=]\s*)" + _SECRET_VALUE),
        r"\1\2\3" + REDACTED,
    ),
    # Well-known token shapes, for text that carries no name at all.
    (re.compile(r"\bsk-(?:ant-)?[A-Za-z0-9_\-]{12,}"), REDACTED),
    (re.compile(r"\bgh[pousr]_[A-Za-z0-9]{16,}"), REDACTED),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}"), REDACTED),
    (re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"), REDACTED),
    (re.compile(r"\bnpm_[A-Za-z0-9]{20,}"), REDACTED),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), REDACTED),
    (re.compile(r"\bAIza[0-9A-Za-z_\-]{30,}"), REDACTED),
    # JWTs (header.payload.signature)
    (
        re.compile(r"\beyJ[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{6,}\.[A-Za-z0-9_\-]{4,}"),
        REDACTED,
    ),
]


# ── Truncated key material ──────────────────────────────────────────────────
#
# Terminal text reaches us already shortened: tmux renders a bounded pane, the
# broker keeps a ring buffer, and the history capture keeps a tail. Any of
# those can cut a PEM block's header away and leave its body — perfectly
# readable key material that the paired BEGIN…END rule cannot see.

_PEM_BEGIN_RE = re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----")
_PEM_END_RE = re.compile(r"-----END [A-Z ]*PRIVATE KEY-----")
# One line of an encoded key body: base64 or base64url, no spaces, long.
_KEY_BODY_LINE_RE = re.compile(r"[A-Za-z0-9+/=_\-]{20,}")
# How many consecutive body-shaped lines make a run key material rather than
# coincidence (hashes, ids, a short base64 blob).
_KEY_BODY_MIN_LINES = 8


def _mask_orphan_delimiters(text: str) -> tuple[str, Optional[str]]:
    """Mask around a PEM delimiter left without its counterpart.

    Complete blocks are already gone by the time this runs, so a surviving
    footer means the body above it was cut from a key, and a surviving header
    means the body below it is one.
    """
    reason: Optional[str] = None
    end = _PEM_END_RE.search(text)
    if end:
        text = REDACTED + text[end.end():]
        reason = "private-key footer with no header in the captured text"
    begin = _PEM_BEGIN_RE.search(text)
    if begin:
        text = text[: begin.start()] + REDACTED
        reason = "private-key header with no footer in the captured text"
    return text, reason


def _mask_undelimited_bodies(text: str) -> tuple[str, Optional[str]]:
    """Mask runs of encoded-key-looking lines that carry no delimiter at all.

    This is the case where BOTH markers were cut away — the middle of a key,
    which no marker-based rule can recognise.
    """
    reason: Optional[str] = None
    out: list[str] = []
    run: list[str] = []

    def flush() -> None:
        nonlocal reason
        if len(run) >= _KEY_BODY_MIN_LINES:
            out.append(REDACTED)
            reason = "encoded key body with no delimiters in the captured text"
        else:
            out.extend(run)
        run.clear()

    for line in text.split("\n"):
        if _KEY_BODY_LINE_RE.fullmatch(line.strip()):
            run.append(line)
            continue
        flush()
        out.append(line)
    flush()
    return "\n".join(out), reason


def scrub(text: str) -> tuple[str, Optional[str]]:
    """Return `(scrubbed_text, truncated_secret_reason)`.

    The reason is non-None when the text carried key material whose extent
    could not be determined from the text itself (a half-delimited or
    undelimited PEM body). It is masked either way; the reason lets a caller
    that cannot vouch for its own input — a bounded terminal capture — withhold
    the text entirely instead of trusting a heuristic with a private key.
    """
    if not text:
        return text, None
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    text, orphan_reason = _mask_orphan_delimiters(text)
    text, body_reason = _mask_undelimited_bodies(text)
    return text, orphan_reason or body_reason


def redact_secrets(text: str) -> str:
    """Return `text` with every credential-looking substring masked."""
    return scrub(text)[0]


def find_truncated_secret(text: str) -> Optional[str]:
    """Why `text` carries key material that cannot be bounded, or None."""
    return scrub(text)[1]
