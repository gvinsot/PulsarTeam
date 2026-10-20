"""exec-shell's working directory for an agent with no project.

The CLI runner images have no /projects. Falling back to it made every
/exec-shell of a project-less agent fail with "Directory not found: /projects"
— the LLM API's answer file and email attachments could not be read.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

import routes_api  # noqa: E402


def test_falls_back_to_the_cli_cwd_when_the_image_has_no_projects_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(routes_api, "PROJECTS_DIR", str(tmp_path / "missing"))
    monkeypatch.setattr(routes_api, "CLI_CWD", str(tmp_path))
    assert routes_api.default_exec_cwd() == str(tmp_path)


def test_keeps_the_projects_dir_where_it_exists(monkeypatch, tmp_path):
    projects = tmp_path / "projects"
    projects.mkdir()
    monkeypatch.setattr(routes_api, "PROJECTS_DIR", str(projects))
    monkeypatch.setattr(routes_api, "CLI_CWD", str(tmp_path / "app"))
    assert routes_api.default_exec_cwd() == str(projects)
