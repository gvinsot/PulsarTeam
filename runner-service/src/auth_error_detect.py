"""Shared heuristics for spotting a *genuine* Claude CLI auth failure in its
output — used by both the interactive PTY session (``pty_session.py``) and the
headless sync driver (``backends/claude_code.py``) so the two never drift.

Why this is fiddly: the CLI's output routinely *contains* the words we key on
without being an auth failure at all. ``authentication_error`` is the Anthropic
API error *type* string — it shows up in the agent's OWN streamed reply, in
tool/command results, in logs, and in any source it reads (this repo included).
A bare ``401`` likewise appears inside byte counts, line numbers, hashes and
unrelated HTTP responses the agent makes. Latching on either substring alone
spuriously fails a perfectly authenticated task with "please re-authenticate"
— and, in the sync driver, kicks off a token refresh + retry that can recurse.

Terminal detection additionally requires a diagnostic at the start of a line,
after optional TUI decoration. Source listings, diffs and quoted strings can
contain even the distinctive login banners without indicating a failure.
"""

import re

# CLI / login phrases. These also occur in source and replies: a substring match
# alone is not sufficient evidence when inspecting mixed terminal output.
AUTH_ERROR_RE = re.compile(
    r"(invalid\s+api\s+key"
    r"|please\s+run\s+/login"
    r"|run\s+/login\s+to\s+(authenticate|log\s*in)"
    r"|oauth\s+token\s+(has\s+)?expired"
    r"|invalid\s+authentication\s+credentials)",
    re.IGNORECASE,
)

# The bare Anthropic API error *type*. Only meaningful alongside a real 401.
AUTH_ERROR_401_RE = re.compile(r"authentication_error", re.IGNORECASE)

# A standalone HTTP 401 — word-boundaried so "1401", "4012", byte counts and
# line numbers don't count as a 401.
HTTP_401_RE = re.compile(r"(?<!\d)401(?!\d)")


_TUI_PREFIX_RE = re.compile(r"^[ \t]*(?:[⎿●✗✘×!][ \t]*)?")
_ERROR_PREFIX_RE = re.compile(r"^(?:API[ \t]+)?Error[ \t]*:[ \t]*(?:401[ \t]*[:·-]?[ \t]*)?", re.IGNORECASE)
_API_401_PREFIX_RE = re.compile(r"^(?:API[ \t]+error[ \t]*:?[ \t]*401\b|HTTP(?:/\d(?:\.\d)?)?[ \t]+401\b)", re.IGNORECASE)


def find_auth_error_line(text: str) -> str | None:
    """Return a CLI diagnostic line, excluding embedded code/prose matches.

    A 401 and authentication_error must belong to the same diagnostic line;
    unrelated line numbers or tool output elsewhere must not complete a match.
    """
    for line in text.splitlines():
        diagnostic = _TUI_PREFIX_RE.sub("", line, count=1)
        banner = _ERROR_PREFIX_RE.sub("", diagnostic, count=1)
        if AUTH_ERROR_RE.match(banner):
            return line.strip()
        if _API_401_PREFIX_RE.match(diagnostic) and AUTH_ERROR_401_RE.search(diagnostic):
            return line.strip()
    return None


def looks_like_auth_error(text: str) -> bool:
    """True when mixed terminal output carries an auth diagnostic line."""
    return find_auth_error_line(text) is not None
