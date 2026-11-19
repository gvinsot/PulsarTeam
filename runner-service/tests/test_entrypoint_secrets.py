"""Secret-hardening block of src/entrypoint.sh.

Swarm mounts secret files on a read-only tmpfs: chmod on the files always
fails while chmod on /run/secrets succeeds. The entrypoint must not log a
WARNING per secret in that (safe) case, and must still warn loudly when the
directory itself could not be locked.

The block is extracted from the real script and run against a temp dir, with
``chmod`` stubbed by a shell function so the read-only mount is reproducible
without root or a tmpfs.
"""

import re
import subprocess
from pathlib import Path

ENTRYPOINT = Path(__file__).resolve().parent.parent / "src" / "entrypoint.sh"


def _secrets_block() -> str:
    text = ENTRYPOINT.read_text()
    match = re.search(r"^if \[ -d /run/secrets \]; then\n.*?^fi\n", text, re.S | re.M)
    assert match, "secrets block not found in entrypoint.sh"
    return match.group(0)


def _run(tmp_path: Path, chmod_stub: str) -> str:
    secrets = tmp_path / "secrets"
    secrets.mkdir()
    for name in ("ENCRYPTION_KEY", "CODER_API_KEY"):
        (secrets / name).write_text("x")
    block = _secrets_block().replace("/run/secrets", str(secrets))
    script = f"set -e\nchown() {{ :; }}\n{chmod_stub}\n{block}"
    out = subprocess.run(["bash", "-c", script], capture_output=True, text=True, check=True)
    return out.stdout


def test_read_only_files_with_locked_dir_do_not_warn(tmp_path):
    # dir chmod succeeds, file chmod fails (Swarm read-only secret files)
    stub = 'chmod() { [ -d "$2" ]; }'
    out = _run(tmp_path, stub)
    assert "WARNING" not in out
    assert "0700 dir; 2 read-only secret file(s)" in out


def test_all_chmods_succeed(tmp_path):
    out = _run(tmp_path, "chmod() { :; }")
    assert "WARNING" not in out
    assert "(0700 dir / 0400 files)" in out


def test_unlocked_dir_and_files_warn_per_secret(tmp_path):
    out = _run(tmp_path, "chmod() { return 1; }")
    assert "WARNING: could not chmod" in out
    assert out.count("readable by agent UIDs") == 2
    assert "locked to root-only" not in out
