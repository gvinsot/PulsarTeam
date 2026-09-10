import asyncio
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import agent_user as projects


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    monkeypatch.setattr(projects, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(projects, "_agent_projects", {})
    monkeypatch.setattr(projects, "_agent_users", {
        "test": {"uid": 1000, "gid": 1000, "home": str(tmp_path / "home")},
    })
    monkeypatch.setattr(os, "chown", lambda *args: None, raising=False)
    monkeypatch.setattr(projects, "_chown_recursive", lambda *args: None)
    close = AsyncMock()
    monkeypatch.setattr(projects, "_close_project_terminal", close)

    async def clone(base, target, *args):
        Path(target, ".git").mkdir(parents=True, exist_ok=True)
        return target

    monkeypatch.setattr(projects, "_clone_or_update_one", clone)
    return close, clone


def test_switch_return_and_detach_preserve_work(workspace):
    close, _ = workspace

    async def run():
        first = await projects.ensure_agent_project("test", "owner/a", "url-a")
        work = Path(first, "unfinished.txt")
        work.write_text("local work")
        await projects.ensure_agent_project("test", "owner/b", "url-b")
        assert close.await_count == 2
        await projects.ensure_agent_project("test", "owner/a", "url-a")
        assert work.read_text() == "local work"
        assert projects.get_agent_project_dir("test") == first
        await projects.ensure_agent_project("test", None, None)
        projects._agent_projects.clear()  # restart
        assert projects.get_agent_project_dir("test") is None
        assert work.exists()
        count = close.await_count
        await projects.ensure_agent_project("test", None, None)
        assert close.await_count == count

    asyncio.run(run())


def test_secondary_preparation_does_not_restart_primary(workspace):
    close, _ = workspace

    async def run():
        first = await projects.ensure_agent_project("test", "owner/a", "url-a")
        close.reset_mock()
        await projects.ensure_agent_project("test", "owner/a", "url-a", secondary_repos=[
            {"full_name": "owner/b", "git_url": "url-b"},
        ])
        close.assert_not_awaited()
        assert projects.get_agent_project_dir("test") == first

    asyncio.run(run())


@pytest.mark.parametrize("previous", [None, "owner/a"])
def test_failed_switch_keeps_previous_selection(workspace, monkeypatch, previous):
    close, clone = workspace

    async def fail_secondary(base, target, *args):
        if target.endswith("broken"):
            raise RuntimeError("clone failed")
        return await clone(base, target, *args)

    async def run():
        old = await projects.ensure_agent_project("test", previous, "url") if previous else None
        close.reset_mock()
        monkeypatch.setattr(projects, "_clone_or_update_one", fail_secondary)
        with pytest.raises(RuntimeError, match="clone failed"):
            await projects.ensure_agent_project("test", "owner/b", "url-b", secondary_repos=[
                {"full_name": "owner/broken", "git_url": "broken"},
            ])
        close.assert_not_awaited()
        projects._agent_projects.clear()
        assert projects.get_agent_project_dir("test") == old

    asyncio.run(run())


def test_existing_git_worktree_is_untouched(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()

    def git(*args):
        return subprocess.check_output(["git", "-C", str(repo), *args], text=True).strip()

    git("init")
    git("config", "user.email", "test@example.com")
    git("config", "user.name", "Test")
    file = repo / "file.txt"
    file.write_text("base")
    git("add", ".")
    git("commit", "-m", "base")
    git("update-ref", "refs/remotes/origin/HEAD", "HEAD")
    git("checkout", "-b", "agent-work")
    file.write_text("local commit")
    git("commit", "-am", "local")
    file.write_text("staged")
    git("add", ".")
    file.write_text("unstaged")
    before = (git("rev-parse", "HEAD"), git("diff"), git("diff", "--cached"))
    monkeypatch.setattr(projects, "_chown_recursive", lambda *args: None)
    asyncio.run(projects._clone_or_update_one(str(tmp_path), str(repo), "unused", None, 0, 0))
    assert (git("rev-parse", "HEAD"), git("diff"), git("diff", "--cached")) == before
    assert git("branch", "--show-current") == "agent-work"
