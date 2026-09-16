"""Credential scrubbing for terminal text that leaves the runner.

Anything captured from a CLI's terminal can contain the operator's own
credentials: a `/login` screen prints a device-code URL, a failed API call
echoes an `Authorization: Bearer …` header, an env dump shows `GITHUB_TOKEN=…`.
That text is persisted into task history and broadcast over websockets, so it
must be scrubbed at the source — the broker — and again on the API side (an
older runner may not have this module).

The patterns below intentionally err towards over-redaction: a mangled log line
is a cosmetic problem, a leaked token is not.
"""
import re

REDACTED = "[redacted]"

# Ordered: the more specific rules run first so a token inside a URL is masked
# as a parameter (keeping the parameter name readable) rather than by shape.
_RULES: list[tuple[re.Pattern, str]] = [
    # PEM blocks — replace the whole body, not line by line.
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
        re.compile(r"(?i)\b(authorization|proxy-authorization)(\s*[:=]\s*)\S+"),
        r"\1\2" + REDACTED,
    ),
    # KEY=value / "key": "value" where the *name* says it is a secret.
    (
        re.compile(
            r"(?i)\b([A-Za-z0-9_.\-]*(?:token|secret|password|passwd|api[_-]?key"
            r"|access[_-]?key|private[_-]?key|credential|auth[_-]?key)[A-Za-z0-9_.\-]*)"
            r"(\"?\s*[:=]\s*\"?)[^\s\"',;]+"
        ),
        r"\1\2" + REDACTED,
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


def redact_secrets(text: str) -> str:
    """Return `text` with every credential-looking substring masked."""
    if not text:
        return text
    for pattern, replacement in _RULES:
        text = pattern.sub(replacement, text)
    return text
