"""Cross-CLI flag-compatibility tests (integration).

The Dockerfile installs each agent CLI at `@latest`, so a plain image rebuild
can pull a new CLI version that renamed or removed a flag. When that happens the
runner keeps emitting the old flag, the CLI rejects it at startup, and the
terminal "ne charge plus" — exactly the failure mode that motivated these tests.

For every backend whose CLI is actually installed, this asserts that:
  • each `--long` flag the launch recipe emits is still advertised by the CLI's
    own `--help`, and
  • the backend's "bypass approvals" flag still exists in the CLI.

Auto-skips when a CLI is absent or is the build-time stub (install failed), so
it is safe in environments without the binaries; it does real work inside the
runner image / deployed containers, which ship every CLI. Run there with e.g.
`python -m pytest tests/test_cli_flag_compatibility.py`.
"""

import shutil
import subprocess

import pytest

from _cli_matrix import CLIS, build_recipe, emitted_long_flags


def _help_text(binary):
    """Combined stdout+stderr of the CLI's help, trying the common variants so
    we don't miss flags a CLI only lists under one of them."""
    chunks = []
    for args in (["--help"], ["help"], ["-h"]):
        try:
            proc = subprocess.run(
                [binary, *args], capture_output=True, text=True, timeout=20
            )
        except (OSError, subprocess.SubprocessError):
            continue
        chunks.append((proc.stdout or "") + "\n" + (proc.stderr or ""))
    return "\n".join(chunks)


def _resolve_or_skip(spec):
    binary = shutil.which(spec["binary"])
    if not binary:
        pytest.skip(f"{spec['binary']} is not installed")
    help_text = _help_text(spec["binary"])
    if not help_text.strip():
        pytest.skip(f"{spec['binary']} produced no help output")
    # The Dockerfile falls back to a stub ("<name>-stub … install failed") that
    # emits no flags — nothing to check against.
    if "stub" in help_text.lower() and "--" not in help_text:
        pytest.skip(f"{spec['binary']} is the build-time stub (install failed)")
    return help_text


@pytest.mark.parametrize("spec", CLIS, ids=lambda s: s["name"])
def test_installed_cli_accepts_emitted_flags(spec, tmp_path, monkeypatch):
    help_text = _resolve_or_skip(spec)
    recipe = build_recipe(spec["name"], tmp_path, monkeypatch)

    missing = [f for f in emitted_long_flags(recipe["cmd"]) if f not in help_text]
    assert not missing, (
        f"{spec['name']} ({spec['binary']}) emits flag(s) its installed CLI no "
        f"longer advertises: {missing}. The runner would hand the CLI an option "
        f"it rejects at startup, so the terminal never reaches the prompt."
    )


@pytest.mark.parametrize(
    "spec", [s for s in CLIS if s["danger_flag"]], ids=lambda s: s["name"]
)
def test_installed_cli_still_has_bypass_flag(spec, tmp_path, monkeypatch):
    # The bypass/approval flag is what lets the runner drive the CLI unattended.
    # If the CLI drops/renames it, agents silently start prompting for input.
    help_text = _resolve_or_skip(spec)
    assert spec["danger_flag"] in help_text, (
        f"{spec['name']} ({spec['binary']}) no longer advertises its bypass flag "
        f"{spec['danger_flag']!r} — the runner can no longer run it unattended."
    )
