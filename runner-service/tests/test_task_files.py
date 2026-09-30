import asyncio
import hashlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from task_files import run_helper, task_files_dir, valid_file_name, valid_task_id  # noqa: E402


def _run(args, stdin=None):
    return asyncio.run(run_helper(args, {}, dict(os.environ), stdin_bytes=stdin))


def test_names_are_validated_not_rewritten():
    assert valid_file_name("report.pdf")
    assert valid_file_name("plan (2).xlsx")
    for bad in ("", ".", "..", ".bashrc", "a/b", "..\\x", "a\x00b", "a\nb", "x" * 256):
        assert not valid_file_name(bad), bad
    assert valid_task_id("0b3c1f2e-9a4d-4c1e-8f00-123456789abc")
    assert not valid_task_id("../etc")


def test_write_then_sync_prunes_and_reports_missing(tmp_path):
    d = task_files_dir(str(tmp_path), "t1")
    data = bytes(range(256)) * 10  # binary, NUL bytes included
    out = _run(["write", d, "img.png"], stdin=data)
    assert Path(out["path"]).read_bytes() == data
    _run(["write", d, "stale.txt"], stdin=b"old")

    digest = hashlib.sha256(data).hexdigest()
    manifest = '[{"name": "img.png", "sha256": "%s"}, {"name": "new.pdf", "sha256": "00"}]' % digest
    res = _run(["sync", d, manifest])
    assert res["missing"] == ["new.pdf"]
    assert sorted(os.listdir(d)) == ["img.png"]


def test_sync_with_empty_manifest_removes_directory(tmp_path):
    d = task_files_dir(str(tmp_path), "t2")
    _run(["write", d, "a.txt"], stdin=b"a")
    assert _run(["sync", d, "[]"])["missing"] == []
    assert not os.path.exists(d)
