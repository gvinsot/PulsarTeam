"""Every credential below is synthetic — invented for the test, never a real key."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
os.environ.setdefault("RUNNER_TYPE", "codex")

from secret_filter import find_truncated_secret, redact_secrets  # noqa: E402


def _pem(body_lines: int, *, header: bool = True, footer: bool = True) -> str:
    """A synthetic PEM block. The body lines are invented markers, never a key."""
    lines = [f"SYNTHETIC_KEY_BODY_{i:03d}" for i in range(body_lines)]
    if header:
        lines.insert(0, "-----BEGIN PRIVATE KEY-----")
    if footer:
        lines.append("-----END PRIVATE KEY-----")
    return "\n".join(lines)


@pytest.mark.parametrize(
    "text,leak",
    [
        ("Authorization: Bearer SYNTHETIC0123456789abcdef", "SYNTHETIC0123456789abcdef"),
        ("curl -H 'authorization: token SYNTHETICtoken123456'", "SYNTHETICtoken123456"),
        (
            "Open https://example.invalid/device?user_code=SYNTH-0000&state=xyz",
            "SYNTH-0000",
        ),
        ("callback https://example.invalid/cb?code=SYNTHETICAUTHCODE", "SYNTHETICAUTHCODE"),
        ("git remote: https://user:SYNTHETICpass@example.invalid/repo.git", "SYNTHETICpass"),
        ("export GITHUB_TOKEN=ghp_SYNTHETIC0000000000000000000000", "ghp_SYNTHETIC"),
        ('{"api_key": "SYNTHETIC-key-value"}', "SYNTHETIC-key-value"),
        ("ANTHROPIC_API_KEY=sk-ant-SYNTHETIC0123456789", "sk-ant-SYNTHETIC"),
        ("slack hook xoxb-SYNTHETIC-0000-abcdef", "xoxb-SYNTHETIC"),
        ("aws key AKIASYNTHETIC00000AA", "AKIASYNTHETIC00000AA"),
        (
            "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJTWU5USEVUSUMifQ.SYNTHETICsig",
            "SYNTHETICsig",
        ),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nSYNTHETICBODY\n-----END RSA PRIVATE KEY-----",
            "SYNTHETICBODY",
        ),
    ],
)
def test_credentials_are_masked(text, leak):
    cleaned = redact_secrets(text)
    assert leak not in cleaned
    assert "[redacted]" in cleaned


def test_ordinary_output_is_left_readable():
    text = "Tests passed (42 assertions)\nPushed 3 commits to origin/main\nsee https://example.invalid/pr/7"
    assert redact_secrets(text) == text


def test_empty_input_is_returned_unchanged():
    assert redact_secrets("") == ""


# ── Quoted values: consumed whole, whatever the quote style ─────────────────
#
# The assignment rule used to accept only an optional DOUBLE quote and to stop
# the value at the first space, which left three bypasses open.


@pytest.mark.parametrize(
    "text,leak",
    [
        # Single-quoted shell assignment: previously not matched at all.
        ("API_TOKEN='SYNTHETIC_VALUE_123456'", "SYNTHETIC_VALUE_123456"),
        ("export api_key='SYNTHETIC_VALUE_123456'", "SYNTHETIC_VALUE_123456"),
        # Quoted NAME as well as value (Python dict / JSON).
        ("{'password': 'SYNTHETIC_VALUE_123456'}", "SYNTHETIC_VALUE_123456"),
        ('{"client_secret": "SYNTHETIC_VALUE_123456"}', "SYNTHETIC_VALUE_123456"),
        # Values containing spaces: previously only the first word was masked.
        ('password="SYNTHETIC FIRST SECOND"', "FIRST"),
        ("password='SYNTHETIC FIRST SECOND'", "SECOND"),
        ("PASSWORD = 'SYNTHETIC FIRST SECOND'", "FIRST"),
        # Escaped quote inside the value must not end it early.
        ('{"password": "SYNTHETIC\\" STILL SECRET"}', "STILL"),
        # Backtick (JS template / shell substitution).
        ("const token = `SYNTHETIC FIRST SECOND`", "FIRST"),
        # An unterminated quote runs to end of line rather than leaking the rest.
        ('password="SYNTHETIC FIRST SECOND', "SECOND"),
    ],
)
def test_quoted_values_are_consumed_whole(text, leak):
    cleaned = redact_secrets(text)
    assert leak not in cleaned
    assert "[redacted]" in cleaned


def test_quoted_value_masking_stops_at_the_closing_quote():
    """Over-redaction is fine; swallowing the rest of the line is not."""
    cleaned = redact_secrets('{"password": "SYNTHETIC VALUE", "host": "db.example.invalid"}')
    assert "SYNTHETIC" not in cleaned
    assert "db.example.invalid" in cleaned


# ── Truncated private keys ──────────────────────────────────────────────────
#
# A PEM block reaches the filter already cut: tmux renders a bounded pane, the
# broker keeps a ring buffer, the history capture keeps a tail. The paired
# BEGIN…END rule sees none of those fragments.


def test_complete_pem_block_is_masked_and_not_flagged():
    text = _pem(65)
    assert "SYNTHETIC_KEY_BODY" not in redact_secrets(text)
    assert find_truncated_secret(text) is None


@pytest.mark.parametrize(
    "text,reason_fragment",
    [
        # Line-limit truncation: the last 60 lines of a 67-line block keep the
        # footer but lose the header.
        ("\n".join(_pem(65).splitlines()[-60:]), "footer"),
        # Ring-buffer eviction / pane too short: header kept, footer never seen.
        ("\n".join(_pem(65).splitlines()[:30]), "header"),
        # Both delimiters gone — the middle of a key.
        (_pem(40, header=False, footer=False), "no delimiters"),
    ],
)
def test_truncated_pem_fragments_are_masked_and_flagged(text, reason_fragment):
    assert "SYNTHETIC_KEY_BODY" in text  # the fragment really is readable input
    assert "SYNTHETIC_KEY_BODY" not in redact_secrets(text)
    reason = find_truncated_secret(text)
    assert reason is not None and reason_fragment in reason


def test_surrounding_output_survives_a_truncated_key():
    text = "Deploy finished\n" + "\n".join(_pem(65).splitlines()[-60:])
    assert "SYNTHETIC_KEY_BODY" not in redact_secrets(text)


def test_short_base64_runs_are_not_treated_as_key_material():
    """Eight lines is the threshold; a couple of hashes must stay readable."""
    text = "abc123def456abc123def456\ndeadbeefdeadbeefdeadbeef0000"
    assert redact_secrets(text) == text
    assert find_truncated_secret(text) is None
