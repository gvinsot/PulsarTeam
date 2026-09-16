"""Every credential below is synthetic — invented for the test, never a real key."""
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
os.environ.setdefault("RUNNER_TYPE", "codex")

from secret_filter import redact_secrets  # noqa: E402


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
