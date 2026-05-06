"""
Runner Service — Per-agent Linux user isolation and project management.

Each agent gets:
  - An isolated HOME directory under DATA_DIR/agents/<username>
  - A unique UID/GID drawn from a reserved range (AGENT_UID_BASE..AGENT_UID_MAX)
    so that CLI subprocesses launched on its behalf cannot read other agents'
    files via filesystem access. The HOME is chowned to that UID and chmod-ed
    to 0700.

The parent server process must carry ambient CAP_CHOWN / CAP_SETUID / CAP_SETGID
(granted by the entrypoint via setpriv) for this isolation to work. Without
those caps `os.chown` and `subprocess.Popen(user=...)` will fail with EPERM.

Backend-specific credentials (e.g. Claude OAuth tokens) are stored per owner
(PulsarTeam user) when an owner_id is provided.
"""

import os
import re
import asyncio
import shutil
import hashlib
from typing import Optional

from config import DATA_DIR, logger


# --- UID allocation -----------------------------------------------------------

# Reserved UID range for agent CLI subprocesses. Keep above 10000 to avoid
# collisions with system users and below 65000 to stay under the typical
# /etc/login.defs UID_MAX. Each agent_id deterministically maps to a UID in
# this range — re-using the same UID for the same agent across restarts so
# the on-disk HOME (chowned at first creation) stays accessible.
_AGENT_UID_BASE = 20000
_AGENT_UID_MAX = 60000
_AGENT_UID_RANGE = _AGENT_UID_MAX - _AGENT_UID_BASE


def _allocate_agent_uid(agent_id: str) -> int:
    """Deterministic UID for a given agent_id, in [_AGENT_UID_BASE, _AGENT_UID_MAX)."""
    digest = hashlib.sha256(agent_id.encode("utf-8")).digest()
    offset = int.from_bytes(digest[:4], "big") % _AGENT_UID_RANGE
    return _AGENT_UID_BASE + offset


# --- In-memory caches ---------------------------------------------------------

_agent_user_lock = None  # Lazily initialized (asyncio.Lock needs a running event loop)
_agent_users: dict[str, dict] = {}
_agent_projects: dict[str, dict] = {}


# --- Helpers ------------------------------------------------------------------

def _sanitize_agent_id(agent_id: str) -> str:
    sanitized = re.sub(r'[^a-zA-Z0-9]', '', agent_id)[:24]
    return f"agent_{sanitized}" if sanitized else "agent_default"


# --- Agent user management ----------------------------------------------------

async def ensure_agent_user(agent_id: str, owner_id: str = None) -> dict:
    """Create an isolated home directory for the given agent ID.

    Instead of creating Linux users (requires root), we create separate
    home directories and override HOME/USER env vars. CLI tools use $HOME
    to find their config files, so this provides effective isolation.
    """
    if not agent_id:
        return None
    if agent_id in _agent_users:
        cached = _agent_users[agent_id]
        if owner_id and cached.get("owner_id") != owner_id:
            cached["owner_id"] = owner_id
        return cached
    global _agent_user_lock
    if _agent_user_lock is None:
        _agent_user_lock = asyncio.Lock()
    async with _agent_user_lock:
        if agent_id in _agent_users:
            cached = _agent_users[agent_id]
            if owner_id and cached.get("owner_id") != owner_id:
                cached["owner_id"] = owner_id
            return cached
        username = _sanitize_agent_id(agent_id)
        home_dir = os.path.join(DATA_DIR, "agents", username)
        agent_uid = _allocate_agent_uid(agent_id)
        agent_gid = agent_uid
        try:
            agent_claude_dir = os.path.join(home_dir, ".claude")
            os.makedirs(agent_claude_dir, mode=0o700, exist_ok=True)
            coder_home = os.path.expanduser("~")
            coder_settings = os.path.join(coder_home, ".claude", "settings.json")
            if os.path.exists(coder_settings):
                shutil.copy2(coder_settings, os.path.join(agent_claude_dir, "settings.json"))
            coder_claude_json = os.path.join(coder_home, ".claude.json")
            if os.path.exists(coder_claude_json):
                shutil.copy2(coder_claude_json, os.path.join(home_dir, ".claude.json"))
            # Mirror the root .gitconfig (notably safe.directory='*') so git
            # subcommands launched under the agent's UID don't refuse the repo.
            coder_gitconfig = os.path.join(coder_home, ".gitconfig")
            if os.path.exists(coder_gitconfig):
                shutil.copy2(coder_gitconfig, os.path.join(home_dir, ".gitconfig"))
            # Hand ownership to the agent's UID and lock down the HOME so other
            # agents (or anything else running in this container) cannot peek.
            try:
                for root, dirs, files in os.walk(home_dir):
                    os.chown(root, agent_uid, agent_gid)
                    os.chmod(root, 0o700)
                    for name in files:
                        path = os.path.join(root, name)
                        os.chown(path, agent_uid, agent_gid)
                        try:
                            os.chmod(path, 0o600)
                        except OSError:
                            pass
            except PermissionError as e:
                logger.warning(
                    f"[Agent User] chown to uid={agent_uid} failed for {home_dir}: {e}. "
                    "The server is missing CAP_CHOWN — falling back to parent UID. "
                    "Per-agent filesystem isolation is DEGRADED."
                )
                agent_uid = os.getuid()
                agent_gid = os.getgid()
            user_info = {"username": username, "uid": agent_uid, "gid": agent_gid, "home": home_dir, "owner_id": owner_id}
            _agent_users[agent_id] = user_info
            logger.info(f"[Agent User] Created isolated home for agent {agent_id[:12]} at {home_dir} (uid={agent_uid}, owner={owner_id})")
            return user_info
        except Exception as e:
            logger.error(f"[Agent User] Failed to create home for agent {agent_id}: {e}")
            return None


# --- Agent project management -------------------------------------------------

def get_agent_project_dir(agent_id: str) -> Optional[str]:
    entry = _agent_projects.get(agent_id)
    return entry["path"] if entry else None


def _chown_recursive(path: str, uid: int, gid: int):
    """Best-effort recursive chown — silently no-op if the server lacks CAP_CHOWN."""
    if uid == os.getuid():
        return
    try:
        for root, dirs, files in os.walk(path):
            os.chown(root, uid, gid)
            for name in files:
                try:
                    os.chown(os.path.join(root, name), uid, gid)
                except OSError:
                    pass
    except OSError as e:
        logger.warning(f"[Agent User] chown {path} -> uid={uid} failed: {e}")


async def ensure_agent_project(agent_id: str, project: str, git_url: str) -> str:
    """Clone or update a project repo for a specific agent.

    Each agent gets its own clone at DATA_DIR/agents/<username>/projects/<project>.
    """
    username = _sanitize_agent_id(agent_id)
    agent_data_dir = os.path.join(DATA_DIR, "agents", username)
    projects_base = os.path.join(agent_data_dir, "projects")
    project_dir = os.path.join(projects_base, project)
    cached_user = _agent_users.get(agent_id) or {}
    agent_uid = cached_user.get("uid", os.getuid())
    agent_gid = cached_user.get("gid", os.getgid())

    cached = _agent_projects.get(agent_id)
    if cached and cached["project"] == project and os.path.isdir(os.path.join(project_dir, ".git")):
        try:
            proc = await asyncio.create_subprocess_exec(
                "git", "fetch", "--all",
                cwd=project_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=30)
            proc = await asyncio.create_subprocess_exec(
                "git", "reset", "--hard", "origin/HEAD",
                cwd=project_dir,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await asyncio.wait_for(proc.communicate(), timeout=15)
            logger.info(f"[Project] Updated {project} for agent {agent_id[:12]}")
        except Exception as e:
            logger.warning(f"[Project] Failed to update {project} for agent {agent_id[:12]}: {e}")
        return project_dir

    os.makedirs(projects_base, exist_ok=True)

    if os.path.exists(project_dir):
        shutil.rmtree(project_dir, ignore_errors=True)

    ssh_cmd = "ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
    env = {**os.environ, "GIT_SSH_COMMAND": ssh_cmd}

    proc = await asyncio.create_subprocess_exec(
        "git", "clone", git_url, project_dir,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
    )
    stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=120)
    if proc.returncode != 0:
        err_msg = stderr.decode("utf-8", errors="replace").strip()
        raise RuntimeError(f"git clone failed: {err_msg}")

    git_name = os.getenv("GIT_USER_NAME", "PulsarTeam")
    git_email = os.getenv("GIT_USER_EMAIL", "agent@pulsarteam.local")
    for config_cmd in [
        ["git", "config", "user.name", git_name],
        ["git", "config", "user.email", git_email],
    ]:
        p = await asyncio.create_subprocess_exec(*config_cmd, cwd=project_dir)
        await p.wait()

    # Hand the freshly cloned tree over to the agent's UID so the CLI
    # subprocess (which runs under that UID) can read/write it.
    _chown_recursive(project_dir, agent_uid, agent_gid)

    _agent_projects[agent_id] = {"project": project, "path": project_dir}
    logger.info(f"[Project] Cloned {project} for agent {agent_id[:12]} at {project_dir}")
    return project_dir
