"""The trust dialog must be accepted, never confirmed blind.

Claude Code 2.1.258 renders the folder-trust screen with the DESTRUCTIVE option
highlighted:

    Quick safety check: Is this a project you created or one you trust? …
    Security guide
    ❯ No, exit
      Yes, I trust this folder
    Enter to confirm · Esc to cancel

Both PTY drivers used to send a bare Enter here, on the assumption that option 1
was "Yes, I trust this folder". Verified in a runner container: after that Enter
the tmux server is gone — the CLI exits at startup — while Down+Enter reaches
the prompt. So the order flipped at some point and the auto-answer became worse
than no auto-answer at all.

Two layers guard it now, both pinned below:
  • `seed_onboarding_state(..., project_dir=…)` pre-accepts the trust dialog for
    the spawn cwd, so the screen normally never renders (verified: with the seed
    the CLI goes straight to its prompt);
  • `trust_answer_keys` derives the move from the screen rather than assuming a
    position, and returns nothing when it can't read it — sending nothing leaves
    the dialog up for the user, guessing exits the CLI.
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

from backends.claude_token_store import seed_onboarding_state  # noqa: E402
from startup_prompts import (  # noqa: E402
    PAUSE,
    STARTUP_PROMPTS,
    build_trust_re,
    trust_answer_keys,
)

DOWN = b"\x1b[B"
UP = b"\x1b[A"
ENTER = b"\r"

# Verbatim `tmux capture-pane` of Claude Code 2.1.258 in an untrusted folder.
SCREEN_2_1_258 = """\
 Accessing workspace:
 /tmp/trustme/work
 Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source
 project, or work from your team). If not, take a moment to review what's in this folder first.
 Claude Code'll be able to read, edit, and execute files here.
 Security guide
 ❯ No, exit
   Yes, I trust this folder
 Enter to confirm · Esc to cancel
"""

# The layout the old recipe assumed — kept so a future flip back is handled too.
SCREEN_ACCEPT_HIGHLIGHTED = """\
 Do you trust this folder?
 ❯ Yes, I trust this folder
   No, exit
 Enter to confirm · Esc to cancel
"""

SCREEN_ACCEPT_ABOVE_MARKER = """\
 Do you trust this folder?
   Yes, I trust this folder
 ❯ No, exit
 Enter to confirm
"""


def _trust_prompt():
    return next(p for p in STARTUP_PROMPTS if p.key == "trust")


# ── The keystrokes follow the screen ────────────────────────────────────────


def test_current_layout_moves_down_to_the_accept_row():
    assert trust_answer_keys(SCREEN_2_1_258) == (DOWN, PAUSE, ENTER)


def test_never_a_bare_enter_when_exit_is_highlighted():
    """The regression: a bare Enter here confirms "No, exit" and the CLI dies."""
    assert trust_answer_keys(SCREEN_2_1_258)[0] != ENTER


def test_accept_already_highlighted_just_confirms():
    assert trust_answer_keys(SCREEN_ACCEPT_HIGHLIGHTED) == (ENTER,)


def test_accept_above_the_marker_moves_up():
    assert trust_answer_keys(SCREEN_ACCEPT_ABOVE_MARKER) == (UP, PAUSE, ENTER)


@pytest.mark.parametrize(
    "screen, why",
    [
        ("Quick safety check: Is this a project you created?", "no accept row yet"),
        (" Yes, I trust this folder\n No, exit\n", "no selection marker"),
        ("❯ x\n" + "\n" * 9 + " Yes, I trust this folder", "marker too far away"),
    ],
    ids=["half-painted", "no-marker", "marker-far"],
)
def test_unreadable_screens_send_nothing(screen, why):
    """Sending nothing leaves the dialog up for the user; sending a guessed
    Enter exits the CLI. Never guess."""
    assert trust_answer_keys(screen) == (), why


def test_the_trust_recipe_is_screen_derived():
    prompt = _trust_prompt()

    assert callable(prompt.keys), (
        "a static recipe cannot survive the option order moving between CLI "
        "versions, which is exactly what happened"
    )
    assert prompt.keys(SCREEN_2_1_258) == (DOWN, PAUSE, ENTER)


def test_the_real_screen_still_matches_the_trust_pattern():
    """If the wording drifts, the auto-answer silently stops firing."""
    assert _trust_prompt().pattern.search(SCREEN_2_1_258)
    assert build_trust_re().search(SCREEN_2_1_258)


# ── The dialog should not appear in the first place ─────────────────────────


def test_seeding_marks_the_spawn_directory_trusted(tmp_path):
    project = "/app/data/agents/agent_x/projects/gvinsot/PulsarTeam"

    seed_onboarding_state({"home": str(tmp_path)}, project_dir=project)

    data = json.loads((tmp_path / ".claude.json").read_text())
    assert data["projects"][project]["hasTrustDialogAccepted"] is True
    assert data["hasCompletedOnboarding"] is True


def test_seeding_keeps_other_projects_and_is_idempotent(tmp_path):
    (tmp_path / ".claude.json").write_text(json.dumps({
        "hasCompletedOnboarding": True,
        "hasAvailableSubscription": True,
        "projects": {"/other": {"hasTrustDialogAccepted": True, "allowedTools": ["Bash"]}},
    }))

    seed_onboarding_state({"home": str(tmp_path)}, project_dir="/new")
    seed_onboarding_state({"home": str(tmp_path)}, project_dir="/new")

    projects = json.loads((tmp_path / ".claude.json").read_text())["projects"]
    assert projects["/other"]["allowedTools"] == ["Bash"]
    assert projects["/new"]["hasTrustDialogAccepted"] is True


def test_seeding_without_a_project_dir_touches_no_projects(tmp_path):
    seed_onboarding_state({"home": str(tmp_path)})

    assert "projects" not in json.loads((tmp_path / ".claude.json").read_text())


# ── Live: the real CLI must survive the dialog ──────────────────────────────
#
# Auto-skips without the binary/tmux, like test_cli_flag_compatibility. Run it
# inside the runner image, which ships both:
#     /opt/venv/bin/python -m pytest tests/test_trust_prompt.py

import shutil  # noqa: E402
import time  # noqa: E402

from pty_session import PtySession, _strip_ansi  # noqa: E402

LIVE_TIMEOUT = float(os.getenv("TRUST_LIVE_TIMEOUT_SEC", "60"))


def _spawn_env(home):
    """Mirror the production spawn env. LANG matters: without a UTF-8 locale the
    CLI falls back to ASCII menu glyphs, which is NOT what the runner sees
    (sanitize_env allowlists LANG/LC_ALL/LC_CTYPE and the image sets C.UTF-8)."""
    return {
        "HOME": str(home),
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "TERM": os.environ.get("TERM", "xterm-256color"),
    }


async def _settled_screen(session):
    """The CLI's screen once the dialog is gone (or the CLI died).

    Deliberately the RENDERED screen — the production `_rendered_screen` — not
    `_strip_ansi(tail_text())`: the raw stream keeps every past frame, so the
    dialog text would still look "on screen" long after it was dismissed.

    Deliberately NOT gated on `wait_until_input_ready` either: its hints depend
    on the CLI's login state (a logged-out claude shows a bare `❯` instead of
    `Try "…"`), and what these tests are about is only whether the dialog was
    survived and cleared.
    """
    import asyncio

    deadline = time.monotonic() + LIVE_TIMEOUT
    screen = ""
    while time.monotonic() < deadline:
        await asyncio.sleep(2.0)
        await session.request_repaint()
        await asyncio.sleep(0.5)
        screen = session._rendered_screen() or _strip_ansi(
            session.tail_text(max_bytes=200_000)
        )
        if not session.is_alive() or "trust this folder" not in screen.lower():
            break
    return screen.strip()


def _live_or_skip():
    if not shutil.which("claude"):
        pytest.skip("claude is not installed")
    if not shutil.which("tmux"):
        pytest.skip("tmux is not installed (required by PtySession)")


def _untrusted_workspace(tmp_path, seed_trust):
    """A HOME past onboarding but with NO trust entry for the workspace, so the
    CLI is forced to render the dialog."""
    home = tmp_path / "home"
    work = home / "work"
    work.mkdir(parents=True)
    seed_onboarding_state(
        {"home": str(home)}, project_dir=str(work) if seed_trust else None
    )
    return home, work


@pytest.mark.asyncio
async def test_broker_accepts_the_trust_dialog_instead_of_exiting(tmp_path):
    """End to end through the production broker: the CLI must still be alive and
    at its input box. Before the fix the auto-answer confirmed "No, exit" and
    the process was gone."""
    _live_or_skip()
    home, work = _untrusted_workspace(tmp_path, seed_trust=False)
    session = PtySession(
        agent_id="agent-trust-live",
        cmd=["claude"],
        cwd=str(work),
        env=_spawn_env(home),
    )
    await session.start()
    try:
        screen = await _settled_screen(session)
        assert session.is_alive(), (
            "the CLI exited during startup — the trust dialog was answered "
            f"'No, exit'.\nLast screen:\n{screen}"
        )
        assert "trust this folder" not in screen.lower(), (
            f"the trust dialog is still up — it was not answered:\n{screen}"
        )
    finally:
        await session.close()


@pytest.mark.asyncio
async def test_seeded_trust_skips_the_dialog_entirely(tmp_path):
    """The primary fix: with the workspace pre-accepted, no dialog renders, so
    the keystroke path is never exercised."""
    _live_or_skip()
    home, work = _untrusted_workspace(tmp_path, seed_trust=True)
    session = PtySession(
        agent_id="agent-trust-seeded",
        cmd=["claude"],
        cwd=str(work),
        env=_spawn_env(home),
    )
    await session.start()
    try:
        screen = await _settled_screen(session)
        assert session.is_alive(), f"CLI never came up:\n{screen}"
        assert "quick safety check" not in screen.lower(), (
            f"the trust dialog rendered despite the seed:\n{screen}"
        )
        assert "trust this folder" not in screen.lower()
    finally:
        await session.close()
