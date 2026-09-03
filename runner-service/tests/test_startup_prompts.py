import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from startup_prompts import STARTUP_PROMPTS, trust_answer_keys  # noqa: E402

ENTER = b"\r"

CODEX_TRUST_DIRECTORY_SCREEN = """\
You are in /app/data/agents/agent_b7eb62bd42e54217b79c770d/projects/gvinsot/PulsarTeam

Do you trust the contents of this directory?
Working with untrusted contents comes with higher risk of prompt injection.
Trusting the directory allows project-local config, hooks, and exec policies to load.

› 1. Yes, continue
  2. No, quit

Press enter to continue
"""


def _trust_prompt():
    return next(p for p in STARTUP_PROMPTS if p.key == "trust")


def test_codex_trust_directory_prompt_matches_startup_recipe():
    assert _trust_prompt().pattern.search(CODEX_TRUST_DIRECTORY_SCREEN)


def test_codex_trust_directory_prompt_confirms_when_yes_continue_is_selected():
    assert trust_answer_keys(CODEX_TRUST_DIRECTORY_SCREEN) == (ENTER,)


def test_codex_trust_directory_prompt_does_not_confirm_quit_selection():
    screen = CODEX_TRUST_DIRECTORY_SCREEN.replace(
        "› 1. Yes, continue\n  2. No, quit",
        "  1. Yes, continue\n› 2. No, quit",
    )

    assert trust_answer_keys(screen) != (ENTER,)
