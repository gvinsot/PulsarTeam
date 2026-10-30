import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from startup_prompts import PAUSE, STARTUP_PROMPTS, codex_update_answer_keys, trust_answer_keys  # noqa: E402

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


# Codex 0.157 layouts (codex-rs/tui/src/update_prompt.rs, onboarding/trust_directory.rs).
CODEX_UPDATE_SCREEN = """\
  Update available · 0.150.0 → 0.157.1
  Release notes: https://github.com/openai/codex/releases/latest

  › 1. Update now (runs `npm install -g @openai/codex@latest`)
    2. Skip
    3. Skip until next version

  Enter continue · Esc skip
"""

CODEX_TRUST_FOLDER_SCREEN = """\
  Trust this folder? Codex can read, edit, and run files here, subject to your
  permission settings. Folder settings can run code automatically, even without
  a model request. Continue only if you trust these files. Your trust decision
  will be saved.

  › 1. Trust and continue
    2. Quit

  Enter continue · Esc quit
"""


def _prompt(key):
    return next(p for p in STARTUP_PROMPTS if p.key == key)


DOWN = b"\x1b[B"


def test_codex_update_prompt_answers_skip_with_down_enter():
    prompt = _prompt("codex_update")
    assert prompt.pattern.search(CODEX_UPDATE_SCREEN)
    assert prompt.keys(CODEX_UPDATE_SCREEN) == (DOWN, PAUSE, ENTER)


def test_codex_update_prompt_0_166_layout():
    screen = """\
Update available · 0.165.0 → 0.166.0
  Release notes: https://github.com/openai/codex/releases/latest

› 1. Update now (runs `npm install -g @openai/codex`)
  2. Skip
  3. Skip until next version
"""
    assert _prompt("codex_update").pattern.search(screen)
    assert codex_update_answer_keys(screen) == (DOWN, PAUSE, ENTER)


def test_codex_update_prompt_confirms_when_skip_already_selected():
    screen = CODEX_UPDATE_SCREEN.replace("  › 1. Update now", "    1. Update now").replace(
        "    2. Skip\n", "  › 2. Skip\n"
    )
    assert codex_update_answer_keys(screen) == (ENTER,)


def test_codex_update_prompt_sends_nothing_once_dialog_is_gone():
    assert codex_update_answer_keys("› Ask Codex to do anything") == ()


def test_codex_update_prompt_matches_compacted_and_other_installers():
    compacted = CODEX_UPDATE_SCREEN.replace(" ", "").replace(
        "npminstall-g@openai/codex@latest", "brewupgradecodex"
    )
    assert _prompt("codex_update").pattern.search(compacted)


def test_codex_update_prompt_is_checked_before_trust():
    keys = [p.key for p in STARTUP_PROMPTS]
    assert keys.index("codex_update") < keys.index("trust")


def test_codex_trust_folder_prompt_matches():
    assert _trust_prompt().pattern.search(CODEX_TRUST_FOLDER_SCREEN)
    assert _trust_prompt().pattern.search(CODEX_TRUST_FOLDER_SCREEN.replace(" ", ""))


def test_codex_trust_folder_prompt_confirms_trust_and_continue():
    assert trust_answer_keys(CODEX_TRUST_FOLDER_SCREEN) == (ENTER,)


def test_codex_trust_folder_prompt_moves_up_from_quit():
    screen = CODEX_TRUST_FOLDER_SCREEN.replace(
        "› 1. Trust and continue\n    2. Quit",
        "  1. Trust and continue\n  › 2. Quit",
    )
    keys = trust_answer_keys(screen)
    assert keys[0] == b"\x1b[A"
    assert keys[-1] == ENTER
