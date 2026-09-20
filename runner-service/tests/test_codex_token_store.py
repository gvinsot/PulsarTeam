"""Codex auth.json mirroring: which copy of a rotating credential wins.

OpenAI rotates the refresh_token on every grant and revokes the one it
replaces, so the store and the agent's local auth.json must converge on the
NEWEST copy. Losing a rotation (or overwriting it with an older stored copy)
is what produces "your refresh token was revoked" on the next spawn.
"""

import asyncio
import base64
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

import backends.codex_token_store as token_store  # noqa: E402


def _jwt(exp: int) -> str:
    """An access_token whose `exp` claim is all _blob_freshness reads."""
    payload = base64.urlsafe_b64encode(json.dumps({"exp": exp}).encode()).rstrip(b"=")
    return f"header.{payload.decode()}.signature"


def _blob(exp: int, refresh: str) -> dict:
    return {
        "OPENAI_API_KEY": None,
        "tokens": {
            "id_token": "",
            "access_token": _jwt(exp),
            "refresh_token": refresh,
            "account_id": "acct-1",
        },
        "last_refresh": "2026-09-20T16:28:39.032978469Z",
    }


def _write_local(home: Path, blob: dict) -> None:
    codex_dir = home / ".codex"
    codex_dir.mkdir(parents=True, exist_ok=True)
    (codex_dir / "auth.json").write_text(json.dumps(blob), encoding="utf-8")


def test_freshness_orders_by_access_token_expiry():
    older = _blob(1_700_000_000, "refresh-old")
    newer = _blob(1_700_086_400, "refresh-new")

    assert token_store._blob_freshness(newer) > token_store._blob_freshness(older)


def test_freshness_falls_back_to_last_refresh_without_a_jwt():
    blob = {"tokens": {"access_token": ""}, "last_refresh": "2026-09-20T16:28:39Z"}

    assert token_store._blob_freshness(blob) > 0
    assert token_store._blob_freshness({}) == 0.0
    assert token_store._blob_freshness(None) == 0.0


def test_save_if_newer_skips_when_the_store_is_ahead(monkeypatch):
    stored = _blob(1_700_086_400, "refresh-new")
    saved = []
    monkeypatch.setattr(token_store, "_fetch_owner_record", lambda owner_id: stored)
    monkeypatch.setattr(token_store, "save_owner_blob",
                        lambda owner_id, blob: saved.append(blob) or True)

    # A replica that spawned before someone else's refresh tries to push its
    # now-revoked copy back over the live one.
    assert token_store.save_owner_blob_if_newer("owner-1", _blob(1_700_000_000, "revoked")) is True
    assert saved == []


def test_save_if_newer_pushes_a_rotated_token(monkeypatch):
    stored = _blob(1_700_000_000, "refresh-old")
    saved = []
    monkeypatch.setattr(token_store, "_fetch_owner_record", lambda owner_id: stored)
    monkeypatch.setattr(token_store, "save_owner_blob",
                        lambda owner_id, blob: saved.append(blob) or True)

    rotated = _blob(1_700_086_400, "refresh-new")

    assert token_store.save_owner_blob_if_newer("owner-1", rotated) is True
    assert saved == [rotated]


def test_hydrate_does_not_overwrite_a_locally_rotated_token(tmp_path, monkeypatch):
    """The store still serves the copy the CLI's own refresh just revoked.
    Hydration must mirror the local one up, not hand the CLI the dead one."""
    agent_user = {"home": str(tmp_path), "uid": None, "gid": None}
    rotated = _blob(1_700_086_400, "refresh-new")
    _write_local(tmp_path, rotated)
    pushed = []
    monkeypatch.setattr(token_store, "load_owner_blob",
                        lambda owner_id: _blob(1_700_000_000, "refresh-old"))
    monkeypatch.setattr(token_store, "save_owner_blob_if_newer",
                        lambda owner_id, blob: pushed.append(blob) or True)

    assert asyncio.run(token_store.hydrate_agent_auth(agent_user, "owner-1")) is True

    with open(tmp_path / ".codex" / "auth.json", encoding="utf-8") as f:
        assert json.load(f) == rotated
    assert pushed == [rotated]


def test_hydrate_writes_the_stored_blob_when_it_is_newer(tmp_path, monkeypatch):
    agent_user = {"home": str(tmp_path), "uid": None, "gid": None}
    _write_local(tmp_path, _blob(1_700_000_000, "refresh-old"))
    stored = _blob(1_700_086_400, "refresh-new")
    monkeypatch.setattr(token_store, "load_owner_blob", lambda owner_id: stored)

    assert asyncio.run(token_store.hydrate_agent_auth(agent_user, "owner-1")) is True

    with open(tmp_path / ".codex" / "auth.json", encoding="utf-8") as f:
        assert json.load(f) == stored


def test_push_after_exec_refuses_to_move_the_store_backwards(tmp_path, monkeypatch):
    agent_user = {"home": str(tmp_path), "uid": None, "gid": None}
    stale = _blob(1_700_000_000, "refresh-old")
    _write_local(tmp_path, stale)
    calls = []
    monkeypatch.setattr(token_store, "save_owner_blob_if_newer",
                        lambda owner_id, blob: calls.append(blob) or True)

    # mtime newer than the baseline → the push-back path runs, but it goes
    # through the monotonic save rather than save_owner_blob.
    mtime = os.path.getmtime(tmp_path / ".codex" / "auth.json")
    assert asyncio.run(
        token_store.push_agent_auth_if_changed(agent_user, "owner-1", mtime - 10)
    ) is True
    assert calls == [stale]
