"""Claude Code's user-level settings must survive a stateless restart.

The bug this pins: an agent's model, picked in the terminal with `/model`
("saved as your default for new sessions" → `"model": "opus"` in
~/.claude/settings.json), came back as the container-wide RUNNER_MODEL after a
restart. Two independent causes, one test module:

  1. `_build_cmd` pinned `--model RUNNER_MODEL --effort high` on every spawn.
     The CLI documents --model as "Model for the current session", and that
     session flag beats settings.json — so the pick was overridden on the next
     spawn whether or not the container had restarted. Verified against the
     real CLI (2.1.257): with `--model claude-sonnet-4-20250514` the TUI header
     reads "Sonnet 4"; without it, "Opus 5" — the persisted choice.
  2. The runner is stateless (/app/data is not volumed), so settings.json was
     gone on the next boot. It is now saved to team-api by the PTY session's
     file watcher and restored before each spawn, like hermes' ~/.hermes.

Pure unit tests: no CLI binary, network or DB (see _cli_matrix for the
stubbing). Linux-only, like the rest of the suite.
"""

import json
import os
import sys
from pathlib import Path

import pytest

if os.name == "nt":
    pytest.skip("the claude backend imports pty/termios", allow_module_level=True)

os.environ.setdefault("RUNNER_TYPE", "claude-code")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from _cli_matrix import build_recipe  # noqa: E402
import backends.claude_code as claude_code  # noqa: E402
from backends.claude_code import (  # noqa: E402
    ClaudeCodeBackend,
    _strip_managed_settings,
    claude_settings_path,
)

SETTINGS_FILE = "settings.json"


def _agent_user(tmp_path, uid=20001):
    return {"username": "agent_x", "home": str(tmp_path), "uid": uid, "gid": uid}


def _write_settings(tmp_path, data):
    path = Path(claude_settings_path(str(tmp_path)))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


# ── 1. The spawn must not pin a model over the user's pick ──────────────────


def test_launch_command_pins_no_model_or_effort(tmp_path, monkeypatch):
    cmd = build_recipe("claude-code", tmp_path, monkeypatch, uid=20001)["cmd"]

    assert "--model" not in cmd, (
        "--model is session-scoped and overrides the `model` key the TUI writes "
        f"to settings.json, so the user's /model pick is reverted: {cmd}"
    )
    assert "--effort" not in cmd, f"--effort overrides the user's /effort pick: {cmd}"


# ── 2. Persist / restore across a stateless restart ─────────────────────────


def test_recipe_watches_settings_for_live_sync(tmp_path, monkeypatch):
    recipe = build_recipe("claude-code", tmp_path, monkeypatch, uid=20001)

    assert recipe["files_watch_paths"] == [claude_settings_path(str(tmp_path))], (
        "without a watch on settings.json a /model change inside the terminal is "
        "never persisted, so the next boot loses it"
    )
    assert callable(recipe["files_on_change"])


def test_restore_writes_the_persisted_settings(tmp_path, monkeypatch):
    saved = json.dumps({"model": "opus", "theme": "dark"})
    monkeypatch.setattr(
        claude_code, "fetch_runner_config",
        lambda runner, agent_id: {SETTINGS_FILE: saved} if runner == "claude-code" else None,
    )

    ClaudeCodeBackend()._restore_settings(_agent_user(tmp_path, uid=None), "agent-1")

    restored = json.loads(Path(claude_settings_path(str(tmp_path))).read_text())
    assert restored["model"] == "opus"


def test_restore_does_not_clobber_a_live_terminal_session(tmp_path, monkeypatch):
    """The fetch is cached for 15 s, so restoring under a live PTY could write
    stale content over a model the user just changed — which the session's own
    live-sync would then persist back."""
    import pty_session

    _write_settings(tmp_path, {"model": "fable"})
    monkeypatch.setattr(
        claude_code, "fetch_runner_config",
        lambda runner, agent_id: {SETTINGS_FILE: json.dumps({"model": "stale"})},
    )
    monkeypatch.setattr(pty_session, "get_session", lambda agent_id: object())

    ClaudeCodeBackend()._restore_settings(_agent_user(tmp_path, uid=None), "agent-1")

    on_disk = json.loads(Path(claude_settings_path(str(tmp_path))).read_text())
    assert on_disk["model"] == "fable"


def test_permission_writer_keeps_the_restored_model(tmp_path):
    """The permission writer runs right after the restore on every spawn; it
    must merge into the restored file, not replace it."""
    _write_settings(tmp_path, {"model": "opus", "theme": "dark"})

    ClaudeCodeBackend()._apply_permissions_to_settings(
        _agent_user(tmp_path, uid=None),
        {"execution": {"shellAccess": False}},
    )

    settings = json.loads(Path(claude_settings_path(str(tmp_path))).read_text())
    assert settings["model"] == "opus"
    assert "Bash" in settings["permissions"]["deny"]


# ── 3. Only the user's own keys are persisted ───────────────────────────────


def test_managed_permissions_are_not_persisted():
    """`permissions` is rebuilt from team-api at every spawn and the writer only
    ever ADDS rules — persisting it would make a revoked deny rule immortal."""
    raw = json.dumps({
        "model": "opus",
        "theme": "dark",
        "permissions": {"deny": ["Bash"]},
    })

    kept = json.loads(_strip_managed_settings(raw))

    assert kept == {"model": "opus", "theme": "dark"}


def test_strip_returns_none_when_nothing_user_owned_is_left():
    assert _strip_managed_settings(json.dumps({"permissions": {"deny": ["Bash"]}})) is None
    assert _strip_managed_settings("not json") is None


def test_live_sync_saves_only_user_owned_keys(tmp_path, monkeypatch):
    """End of the loop: what the watcher hands over is what reaches team-api."""
    recipe = build_recipe("claude-code", tmp_path, monkeypatch, uid=20001)
    captured = {}

    def _fake_save(runner, agent_id, files):
        captured["runner"] = runner
        captured["files"] = files
        return True

    monkeypatch.setattr(claude_code, "save_runner_config", _fake_save)

    recipe["files_on_change"]({SETTINGS_FILE: json.dumps({
        "model": "opus",
        "permissions": {"deny": ["Bash"]},
    })})

    assert captured["runner"] == "claude-code"
    assert json.loads(captured["files"][SETTINGS_FILE]) == {"model": "opus"}


def test_live_sync_raises_when_the_save_fails(tmp_path, monkeypatch):
    """PtySession's watcher keys its retry on this raising — a swallowed failure
    would mark the config synced and silently drop the user's change."""
    recipe = build_recipe("claude-code", tmp_path, monkeypatch, uid=20001)
    monkeypatch.setattr(claude_code, "save_runner_config", lambda *a, **k: False)

    with pytest.raises(RuntimeError):
        recipe["files_on_change"]({SETTINGS_FILE: json.dumps({"model": "opus"})})
