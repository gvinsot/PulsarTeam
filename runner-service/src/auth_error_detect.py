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

So we only treat output as an auth failure when EITHER:
  * a distinctive CLI/login banner appears (``AUTH_ERROR_RE``), OR
  * the ``authentication_error`` type co-occurs with a real, word-boundaried
    HTTP ``401`` (``AUTH_ERROR_401_RE`` + ``HTTP_401_RE``).
"""

import re

# Distinctive CLI / login banners. These phrases are emitted by the CLI itself
# on an auth failure and effectively never appear verbatim in an agent's reply.
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


def looks_like_auth_error(text: str) -> bool:
    """True when ``text`` carries a genuine CLI auth-failure signal.

    Matches a distinctive login/API-key banner, or the ``authentication_error``
    type co-occurring with a word-boundaried HTTP 401 somewhere in ``text``.
    """
    if not text:
        return False
    if AUTH_ERROR_RE.search(text):
        return True
    return bool(AUTH_ERROR_401_RE.search(text) and HTTP_401_RE.search(text))
