"""Codex backend: model selection must defer to codex's own default unless an
explicit per-agent model is configured (no RUNNER_MODEL / hardcoded pin)."""

import os
import sys
from pathlib import Path

os.environ.setdefault("RUNNER_TYPE", "codex")
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from backends.codex import CodexBackend, _resolve_codex_model  # noqa: E402


def test_resolve_codex_model_empty_without_config():
    assert _resolve_codex_model(None) == ""
    assert _resolve_codex_model({}) == ""
    assert _resolve_codex_model({"provider": "openai"}) == ""  # no model
    assert _resolve_codex_model({"model": "  "}) == ""


def test_resolve_codex_model_uses_explicit_model():
    assert _resolve_codex_model({"model": "o3"}) == "o3"


def test_build_command_omits_model_by_default():
    cmd = CodexBackend()._build_command("hi", stream=False, system_prompt=None,
                                        agent_id="a", task_id=None, permissions=None)
    assert "--model" not in cmd            # codex uses its own default
    assert cmd[:2] == ["codex", "exec"]
    assert "--skip-git-repo-check" in cmd
    assert "--dangerously-bypass-approvals-and-sandbox" in cmd


def test_build_command_passes_explicit_model():
    b = CodexBackend()
    b.set_agent_llm_config("a", {"provider": "openai", "model": "gpt-5.1-codex"})
    cmd = b._build_command("hi", stream=True, system_prompt=None,
                           agent_id="a", task_id=None, permissions=None)
    assert cmd[cmd.index("--model") + 1] == "gpt-5.1-codex"
    assert "--json" in cmd


def test_build_command_uses_full_auto_when_dangerous_permissions_disabled():
    cmd = CodexBackend()._build_command(
        "hi",
        stream=False,
        system_prompt=None,
        agent_id="a",
        task_id=None,
        permissions={"execution": {"dangerousSkipPermissions": False}},
    )

    assert "--dangerously-bypass-approvals-and-sandbox" not in cmd
    assert "--full-auto" in cmd
