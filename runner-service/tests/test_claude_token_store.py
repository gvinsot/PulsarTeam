import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import backends.claude_token_store as token_store  # noqa: E402


def _write_credentials(home: Path, oauth: dict) -> None:
    claude_dir = home / ".claude"
    claude_dir.mkdir(parents=True)
    (claude_dir / ".credentials.json").write_text(
        json.dumps({"claudeAiOauth": oauth}),
        encoding="utf-8",
    )


def test_agent_refresh_token_falls_back_to_cli_credentials(tmp_path):
    _write_credentials(tmp_path, {
        "accessToken": "access-1",
        "refreshToken": "refresh-from-creds",
        "expiresAt": int((time.time() + 3600) * 1000),
    })

    token = token_store.get_agent_refresh_token({"home": str(tmp_path)})

    assert token == "refresh-from-creds"


def test_agent_expiry_falls_back_to_cli_credentials(tmp_path):
    _write_credentials(tmp_path, {
        "accessToken": "access-1",
        "refreshToken": "refresh-from-creds",
        "expiresAt": int((time.time() - 60) * 1000),
    })

    assert token_store.is_agent_token_expired({"home": str(tmp_path)}) is True


def test_agent_oauth_json_takes_precedence_over_cli_credentials(tmp_path, monkeypatch):
    _write_credentials(tmp_path, {
        "accessToken": "access-1",
        "refreshToken": "refresh-from-creds",
        "expiresAt": int((time.time() - 60) * 1000),
    })
    monkeypatch.setattr(
        token_store,
        "_read_secret_json",
        lambda path: {
            "refreshToken": "refresh-from-json",
            "expiresAt": int((time.time() + 3600) * 1000),
        }
        if os.path.basename(path) == "oauth_token.json"
        else None,
    )

    agent_user = {"home": str(tmp_path)}

    assert token_store.get_agent_refresh_token(agent_user) == "refresh-from-json"
    assert token_store.is_agent_token_expired(agent_user) is False
