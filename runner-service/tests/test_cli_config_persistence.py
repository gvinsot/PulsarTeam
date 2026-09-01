"""Every CLI runner must keep the config the user set in its terminal.

Runners are stateless — `/app/data` is not volumed — so the agent HOME, and
with it the model the user picked inside the TUI, is gone on the next boot.
`PersistedConfigMixin` saves the files holding those choices to team-api and
restores them before every spawn.

The paths below are not guesses; each was read off the real CLI in a runner
container:

  opencode    ~/.local/state/opencode/model.json   — the TUI's model picker
              writes {"recent":[{"providerID":…,"modelID":…}], …} HERE, not in
              config.json (which the runner regenerates every spawn).
  codex       ~/.codex/config.toml                 — `/model` + project trust,
              alongside our marker-delimited MCP block.
  openclaw    ~/.openclaw/openclaw.json            — CLI config; our `mcp` and
              `tools` keys are rewritten each spawn.
  hermes      ~/.hermes/{config.yaml,.env}         — `hermes setup` output.
  aider       ~/.aider.conf.yml                    — hand-written; aider has no
              in-chat "save my model" flow, so this is the only sticky config.
  claude-code ~/.claude/settings.json              — covered in its own module,
              test_claude_settings_persistence.py.

Pure unit tests: no CLI binary, network or DB (see _cli_matrix for the
stubbing). Linux-only, like the rest of the suite.
"""

import json
import os
import sys
from pathlib import Path

import pytest

if os.name == "nt":
    pytest.skip("the backends import pty/termios", allow_module_level=True)

os.environ.setdefault("RUNNER_TYPE", "opencode")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from _cli_matrix import build_recipe  # noqa: E402
import backends.runner_config_store as config_store  # noqa: E402
from agent_user import _agent_users  # noqa: E402
from backends.aider import AiderBackend  # noqa: E402
from backends.codex import CodexBackend  # noqa: E402
from backends.hermes import HermesBackend  # noqa: E402
from backends.openclaw import OpenClawBackend  # noqa: E402
from backends.opencode import OpenCodeBackend  # noqa: E402

# (backend name, backend class, expected relative paths)
BACKENDS = [
    ("opencode", OpenCodeBackend, [".local/state/opencode/model.json"]),
    ("codex", CodexBackend, [".codex/config.toml"]),
    ("openclaw", OpenClawBackend, [".openclaw/openclaw.json"]),
    ("hermes", HermesBackend, [".hermes/config.yaml", ".hermes/.env"]),
    ("aider", AiderBackend, [".aider.conf.yml"]),
]
IDS = [b[0] for b in BACKENDS]


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_backend_declares_its_user_owned_config(name, cls, rel_paths):
    assert list(cls.persisted_config_files) == rel_paths, (
        f"{name} must persist exactly the file(s) the CLI writes on the user's "
        f"behalf — anything else is either lost on restart or fights the "
        f"runner's own per-spawn writes"
    )


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_stored_keys_are_unique_basenames(name, cls, rel_paths):
    """PtySession's watcher reports files by basename, so two declared paths
    sharing one would silently overwrite each other in the store."""
    basenames = [os.path.basename(p) for p in cls.persisted_config_files]
    assert len(basenames) == len(set(basenames))


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_restore_writes_every_declared_file(name, cls, rel_paths, tmp_path, monkeypatch):
    agent_id = f"agent-{name}-restore"
    saved = {os.path.basename(p): f"content-of-{os.path.basename(p)}" for p in rel_paths}
    monkeypatch.setattr(
        config_store, "fetch_runner_config",
        lambda runner, aid: saved if runner == name else None,
    )
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": None, "gid": None}

    try:
        cls()._restore_persisted_config(None, agent_id)
    finally:
        _agent_users.pop(agent_id, None)

    for rel in rel_paths:
        restored = tmp_path / rel
        assert restored.read_text() == saved[os.path.basename(rel)], (
            f"{name} did not restore {rel} — the user's terminal setup is lost "
            f"on the next stateless spawn"
        )


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_restore_skips_a_live_terminal_session(name, cls, rel_paths, tmp_path, monkeypatch):
    """fetch_runner_config caches for 15 s, so restoring under a live PTY could
    overwrite a model the user just changed — which the session's own live-sync
    would then persist back as the truth."""
    import pty_session

    agent_id = f"agent-{name}-live"
    monkeypatch.setattr(
        config_store, "fetch_runner_config",
        lambda runner, aid: {os.path.basename(p): "stale" for p in rel_paths},
    )
    monkeypatch.setattr(pty_session, "get_session", lambda aid: object())
    _agent_users[agent_id] = {"home": str(tmp_path), "uid": None, "gid": None}

    try:
        cls()._restore_persisted_config(None, agent_id)
    finally:
        _agent_users.pop(agent_id, None)

    for rel in rel_paths:
        assert not (tmp_path / rel).exists()


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_recipe_watches_the_declared_files(name, cls, rel_paths, tmp_path, monkeypatch):
    recipe = build_recipe(name, tmp_path, monkeypatch)

    assert recipe.get("files_watch_paths") == [str(tmp_path / rel) for rel in rel_paths]
    assert callable(recipe.get("files_on_change"))


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_live_sync_saves_under_the_backend_name(name, cls, rel_paths, tmp_path, monkeypatch):
    recipe = build_recipe(name, tmp_path, monkeypatch)
    captured = {}

    def _fake_save(runner, agent_id, files):
        captured["runner"] = runner
        return True

    monkeypatch.setattr(config_store, "save_runner_config", _fake_save)
    # Content that survives every backend's sanitizer.
    payload = {os.path.basename(rel_paths[0]): json.dumps({"model": "x"})}
    if name == "codex":
        payload = {"config.toml": 'model = "gpt-5-codex"\n'}

    recipe["files_on_change"](payload)

    assert captured["runner"] == name


@pytest.mark.parametrize("name, cls, rel_paths", BACKENDS, ids=IDS)
def test_live_sync_raises_when_the_save_fails(name, cls, rel_paths, tmp_path, monkeypatch):
    """PtySession's watcher keys its retry on this raising — a swallowed failure
    would mark the config synced and silently drop the user's change."""
    recipe = build_recipe(name, tmp_path, monkeypatch)
    monkeypatch.setattr(config_store, "save_runner_config", lambda *a, **k: False)
    payload = {os.path.basename(rel_paths[0]): json.dumps({"model": "x"})}
    if name == "codex":
        payload = {"config.toml": 'model = "gpt-5-codex"\n'}

    with pytest.raises(RuntimeError):
        recipe["files_on_change"](payload)


# ── Sanitizers: never archive runner-managed content ────────────────────────


def test_codex_persists_config_without_the_managed_mcp_block():
    """The block is rewritten each spawn and embeds a short-lived gateway
    token, so saving it would only archive a stale credential."""
    raw = (
        'model = "gpt-5-codex"\n\n'
        "# >>> pulsarteam-managed-mcp (do not edit) >>>\n"
        "[mcp_servers.pulsar-gateway]\n"
        'url = "http://team-api:3001/api/pulsar-gateway/mcp"\n'
        'http_headers = { "Authorization" = "Bearer secret.jwt.value" }\n'
        "# <<< pulsarteam-managed-mcp <<<\n"
    )

    saved = CodexBackend()._sanitize_persisted_config("config.toml", raw)

    assert 'model = "gpt-5-codex"' in saved
    assert "secret.jwt.value" not in saved
    assert "pulsarteam-managed-mcp" not in saved


def test_codex_skips_a_config_that_was_only_our_block():
    raw = (
        "# >>> pulsarteam-managed-mcp (do not edit) >>>\n"
        "[mcp_servers.pulsar-gateway]\n"
        "# <<< pulsarteam-managed-mcp <<<\n"
    )

    assert CodexBackend()._sanitize_persisted_config("config.toml", raw) is None


def test_openclaw_persists_config_without_mcp_or_tools():
    """`mcp` carries the gateway token; `tools.exec.mode` is the permissions
    writer's — a saved copy would resurrect an access level after it was
    revoked in Settings."""
    raw = json.dumps({
        "model": "some-model",
        "mcp": {"servers": {"pulsar-gateway": {"headers": {"Authorization": "Bearer secret"}}}},
        "tools": {"exec": {"mode": "full"}},
    })

    kept = json.loads(OpenClawBackend()._sanitize_persisted_config("openclaw.json", raw))

    assert kept == {"model": "some-model"}


def test_openclaw_skips_a_config_that_was_only_managed_keys():
    raw = json.dumps({"mcp": {"servers": {}}, "tools": {"exec": {"mode": "full"}}})

    assert OpenClawBackend()._sanitize_persisted_config("openclaw.json", raw) is None


def test_opencode_persists_its_model_state_verbatim():
    """opencode's model.json is entirely the user's — nothing to strip."""
    raw = json.dumps({
        "recent": [{"providerID": "opencode", "modelID": "mimo-v2.5-free"}],
        "favorite": [],
        "variant": {},
    })

    assert OpenCodeBackend()._sanitize_persisted_config("model.json", raw) == raw


def test_opencode_config_json_is_not_persisted():
    """It is regenerated from team-api on every spawn (model pin, provider
    blocks, MCP, permissions); persisting it would fight the runner."""
    assert ".config/opencode/config.json" not in OpenCodeBackend.persisted_config_files
