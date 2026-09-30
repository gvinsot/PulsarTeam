"""
Runner Service — task attachments materialized in the agent's HOME.

The API stores the files attached to a task (Postgres) and, before handing the
task to an agent, mirrors them into ``$HOME/task-files/<task_id>/`` on the
runner so a CLI agent can open them with its own tools (Read, cat, python...).

The directory lives OUTSIDE every git clone on purpose: an attachment inside a
working tree gets committed by the agent and then shows up in the commit/task
association detectors.

Every filesystem operation runs in a subprocess dropped to the agent's UID
(``get_subprocess_kwargs``): the agent HOME is 0700 and owned by that UID, and
running as the agent keeps a crafted symlink inside the directory from turning
this endpoint into a write primitive outside the agent's own sandbox.
"""

import asyncio
import json
import os
import re
import sys
from typing import Optional

TASK_FILES_DIRNAME = "task-files"

# Must match what the API sends: task ids are UUIDs.
_TASK_ID_RE = re.compile(r"^[A-Za-z0-9-]{1,64}$")
# The API already sanitizes names; the runner only rejects, it never rewrites,
# so both sides always agree on the on-disk name.
_MAX_NAME_BYTES = 255
MAX_TASK_FILE_BYTES = 10 * 1024 * 1024


def valid_task_id(task_id: str) -> bool:
    return bool(task_id) and bool(_TASK_ID_RE.match(task_id))


def valid_file_name(name: str) -> bool:
    if not name or name in (".", "..") or name.startswith("."):
        return False
    if "/" in name or "\\" in name or "\x00" in name:
        return False
    if any(ord(c) < 32 or ord(c) == 127 for c in name):
        return False
    return len(name.encode("utf-8")) <= _MAX_NAME_BYTES


def task_files_dir(home: str, task_id: str) -> str:
    return os.path.join(home, TASK_FILES_DIRNAME, task_id)


# Executed as the agent user. argv: op, dir, [name | json manifest].
#   write  <dir> <name>   stdin → <dir>/<name> (atomic rename), prints {"path"}
#   sync   <dir> <json>   deletes files absent from the manifest and returns the
#                         names whose content differs (missing or other sha256)
_HELPER = r'''
import hashlib, json, os, sys

op, d = sys.argv[1], sys.argv[2]

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for b in iter(lambda: f.read(1 << 16), b""):
            h.update(b)
    return h.hexdigest()

if op == "write":
    name = sys.argv[3]
    os.makedirs(d, mode=0o700, exist_ok=True)
    tmp = os.path.join(d, "." + name + ".part")
    with open(tmp, "wb") as f:
        while True:
            b = sys.stdin.buffer.read(1 << 16)
            if not b:
                break
            f.write(b)
    dest = os.path.join(d, name)
    os.replace(tmp, dest)
    print(json.dumps({"path": dest}))
elif op == "sync":
    wanted = {f["name"]: f["sha256"] for f in json.loads(sys.argv[3])}
    have = {}
    if os.path.isdir(d):
        for n in os.listdir(d):
            p = os.path.join(d, n)
            if os.path.islink(p) or not os.path.isfile(p) or n not in wanted:
                if os.path.islink(p) or os.path.isfile(p):
                    os.unlink(p)
                continue
            have[n] = sha(p)
    missing = [n for n, h in wanted.items() if have.get(n) != h]
    if not wanted and os.path.isdir(d):
        try:
            os.rmdir(d)
        except OSError:
            pass
    print(json.dumps({"dir": d, "missing": missing}))
else:
    sys.exit("unknown op")
'''


async def run_helper(
    args: list,
    subprocess_kwargs: dict,
    env: dict,
    stdin_bytes: Optional[bytes] = None,
    timeout: float = 60,
) -> dict:
    """Run the helper as the agent user; return its JSON output or raise."""
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-c", _HELPER, *args,
        stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        env=env,
        **subprocess_kwargs,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(stdin_bytes), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"task-files helper timed out after {timeout}s")
    if proc.returncode != 0:
        raise RuntimeError((err or b"").decode("utf-8", errors="replace").strip()[-500:] or
                           f"task-files helper exited {proc.returncode}")
    return json.loads(out.decode("utf-8"))
