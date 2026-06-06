"""
Fetch an agent's base instructions from team-api and write them into each CLI's
native *global* instructions file before a spawn.

Companion to `runner_mcp_config.py`: where that module materializes MCP wiring
into the CLI's native config, this one materializes the agent's base
instructions ("complet sans protocole chat" — see
agentManager.buildRunnerInstructions) into the file the CLI auto-loads as
project/agent guidance, so the instructions land in the agent's context in BOTH
the interactive PTY and the headless execution paths.

Why HOME-level (global) files rather than a project-root CLAUDE.md/AGENTS.md:
  - The per-agent HOME is isolated and re-provisioned at every spawn (stateless
    runners), exactly like the MCP config — so it is the natural, per-agent,
    non-shared place. The generic CLI cwd (/app) is shared across agents.
  - Writing CLAUDE.md/AGENTS.md into the project working tree risks clobbering a
    file the repo legitimately tracks and polluting git status. Global memory
    files avoid that entirely.

Native global instruction files. claude (~/.claude/CLAUDE.md) and codex
(~/.codex/AGENTS.md, i.e. $CODEX_HOME/AGENTS.md) are documented global-memory
conventions; opencode/hermes/openclaw use a best-guess AGENTS.md under their
config home and should be confirmed by introspecting the runner image (see the
cli_mcp_config_schemas introspection technique — write the file, then check the
CLI actually picks it up):
  - claude    → ~/.claude/CLAUDE.md            (documented)
  - codex     → ~/.codex/AGENTS.md             (documented)
  - opencode  → ~/.config/opencode/AGENTS.md   (CONFIRM AT DEPLOY)
  - hermes    → ~/.hermes/AGENTS.md            (CONFIRM AT DEPLOY)
  - openclaw  → ~/.openclaw/AGENTS.md          (CONFIRM AT DEPLOY)

Fetch contract (mirrors runner_mcp_config):
  - team-api unreachable / 404 / error  → return None → leave the file untouched
    (never wipe instructions on a transient outage).
  - configured == False / empty body    → return "" → remove our managed file.
  - non-empty instructions              → write them.
"""

from __future__ import annotations

import os
from typing import Optional

import httpx

from config import logger
from .runner_mcp_config import _API_BASE, _API_KEY, _resolve_home, _atomic_write


_PATH = "/api/internal/runner-instructions/agents"
# Leading line written at the top of every managed file. We only ever remove a
# file that starts with this marker, so a user-authored global instructions file
# is never deleted by mistake.
_MARKER = "<!-- pulsarteam-managed: do not edit; regenerated on each spawn -->"


def _fetch_agent_instructions(agent_id: Optional[str]) -> Optional[str]:
    """Return the agent's base instructions string, "" to clear, or None to
    leave the existing file untouched (unreachable / 404 / malformed)."""
    if not agent_id or not _API_KEY:
        return None
    try:
        r = httpx.get(
            f"{_API_BASE}{_PATH}/{agent_id}",
            headers={"X-Api-Key": _API_KEY},
            timeout=5.0,
        )
    except httpx.HTTPError as e:
        logger.warning(f"[Runner Instructions] api unreachable for agent {agent_id[:12]}: {e}")
        return None
    if r.status_code == 404:
        return None
    if r.status_code >= 400:
        logger.warning(
            f"[Runner Instructions] api {r.status_code} for agent {agent_id[:12]}: {r.text[:200]}"
        )
        return None
    try:
        data = r.json()
    except ValueError:
        return None
    if not isinstance(data, dict):
        return None
    instructions = data.get("instructions")
    if not isinstance(instructions, str):
        return ""
    return instructions


def _write_instructions(
    agent_user: Optional[dict],
    agent_id: Optional[str],
    cfg_subpath: tuple[str, ...],
    label: str,
) -> None:
    """Resolve the agent's HOME, then write/clear the native instructions file at
    `<home>/<*cfg_subpath>`. Idempotent; chowned to the agent UID."""
    if not agent_id:
        return
    instructions = _fetch_agent_instructions(agent_id)
    if instructions is None:
        return  # transient failure — keep whatever is on disk

    home, uid, gid = _resolve_home(agent_user, agent_id)
    if not home:
        logger.warning(f"[{label}] no HOME for agent {(agent_id or '?')[:12]} — skipping instructions write")
        return

    cfg_dir = os.path.join(home, *cfg_subpath[:-1])
    cfg_path = os.path.join(home, *cfg_subpath)

    if not instructions.strip():
        # Nothing to inject — remove our managed file if (and only if) it's ours.
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                head = f.read(len(_MARKER) + 4)
            if head.startswith(_MARKER):
                os.remove(cfg_path)
                logger.info(f"[{label}] cleared instructions for agent {(agent_id or '?')[:12]}")
        except OSError:
            pass
        return

    text = f"{_MARKER}\n\n{instructions.strip()}\n"
    try:
        _atomic_write(cfg_path, cfg_dir, text, uid, gid)
        logger.info(
            f"[{label}] wrote {len(text)} chars of base instructions for agent {(agent_id or '?')[:12]}"
        )
    except OSError as e:
        logger.warning(f"[{label}] failed to write {cfg_path}: {e}")


# ── Per-CLI writers ─────────────────────────────────────────────────────────

def configure_claude_instructions(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    _write_instructions(agent_user, agent_id, (".claude", "CLAUDE.md"), "Claude Instructions")


def configure_codex_instructions(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    _write_instructions(agent_user, agent_id, (".codex", "AGENTS.md"), "Codex Instructions")


def configure_opencode_instructions(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    _write_instructions(agent_user, agent_id, (".config", "opencode", "AGENTS.md"), "OpenCode Instructions")


def configure_hermes_instructions(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    # UNVERIFIED native path — best-guess AGENTS.md under ~/.hermes. Confirm by
    # introspecting the runner image (see cli_mcp_config_schemas notes) and
    # adjust the subpath / mechanism if hermes reads a different file or a
    # `system_prompt` key in ~/.hermes/config.yaml.
    _write_instructions(agent_user, agent_id, (".hermes", "AGENTS.md"), "Hermes Instructions")


def configure_openclaw_instructions(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    # UNVERIFIED native path — best-guess AGENTS.md under ~/.openclaw. Confirm by
    # introspecting the runner image and adjust if openclaw reads a different
    # file or an instructions key in ~/.openclaw/openclaw.json.
    _write_instructions(agent_user, agent_id, (".openclaw", "AGENTS.md"), "OpenClaw Instructions")


def configure_aider_instructions(agent_user: Optional[dict], agent_id: Optional[str]) -> None:
    # aider has no auto-loaded global instructions file; we write a managed
    # AGENTS.md under ~/.aider and pass it to the CLI as a read-only context
    # file via --read (see backends/aider.py).
    _write_instructions(agent_user, agent_id, (".aider", "AGENTS.md"), "Aider Instructions")
