"""Cross-CLI launch-command contract tests.

Each interactive runner must hand the PTY a launch command that (a) invokes the
right binary and (b) carries the flags that put the CLI into its non-interactive
"just run, don't prompt me" mode. A backend that silently drops one of these
leaves the runner hung at a prompt or burning API credits — the kind of
"le CLI ne charge plus correctement" regression these tests guard against.

Pure unit tests: no CLI binary, network or DB required (see _cli_matrix for the
stubbing). Linux-only, like the rest of the runner-service suite (the backends
import termios/pty).
"""

import pytest

from _cli_matrix import CLIS, build_recipe


@pytest.mark.parametrize("spec", CLIS, ids=lambda s: s["name"])
def test_launch_recipe_command(spec, tmp_path, monkeypatch):
    recipe = build_recipe(spec["name"], tmp_path, monkeypatch)
    cmd = recipe["cmd"]

    prefix = spec["cmd_prefix"]
    assert cmd[: len(prefix)] == prefix, f"{spec['name']} cmd should start with {prefix}: {cmd}"
    for flag in spec["required_flags"]:
        assert flag in cmd, f"{spec['name']} recipe is missing required flag {flag}: {cmd}"


@pytest.mark.parametrize("spec", CLIS, ids=lambda s: s["name"])
def test_launch_recipe_contract(spec, tmp_path, monkeypatch):
    """The recipe shape consumed by pty_session: a real cwd, an env with a HOME
    the CLI can write its config/credentials into, and the preexec_fn key present
    (the PTY spawn reads it to drop privileges to the per-agent UID).

    Every agent recipe keeps its isolated HOME."""
    recipe = build_recipe(spec["name"], tmp_path, monkeypatch)

    assert isinstance(recipe["cwd"], str) and recipe["cwd"]
    assert isinstance(recipe["env"], dict)
    assert recipe["env"].get("HOME")
    assert "preexec_fn" in recipe


@pytest.mark.parametrize("spec", CLIS, ids=lambda s: s["name"])
@pytest.mark.parametrize("uid", [None, 0, -1])
def test_launch_rejects_missing_or_root_identity(spec, uid, tmp_path, monkeypatch):
    with pytest.raises(RuntimeError, match="non-root UID and GID"):
        build_recipe(spec["name"], tmp_path, monkeypatch, uid=uid)


def test_claude_keeps_skip_permissions_with_agent_uid(tmp_path, monkeypatch):
    # With a dedicated non-root agent UID the privilege drop fires, so the flag
    # is safe to pass and the CLI runs unattended.
    recipe = build_recipe("claude-code", tmp_path, monkeypatch, uid=20001)
    assert "--dangerously-skip-permissions" in recipe["cmd"]
