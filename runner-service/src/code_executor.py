"""
Runner Service — Direct code execution (bypass any LLM agent).
"""

import io
import os
import subprocess
import traceback
from contextlib import redirect_stdout, redirect_stderr

from config import PROJECTS_DIR

MAX_OUTPUT = 2000


def execute_python(code: str) -> str:
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, {"__builtins__": __builtins__})
        out = stdout_buf.getvalue()
        err = stderr_buf.getvalue()
        result = out
        if err:
            result += f"\n[stderr] {err}"
        return result[:MAX_OUTPUT] if result else "(no output)"
    except Exception:
        return traceback.format_exc()[:MAX_OUTPUT]


def execute_shell(code: str) -> str:
    try:
        result = subprocess.run(
            code,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60,
            cwd=PROJECTS_DIR if os.path.isdir(PROJECTS_DIR) else None,
        )
        out = result.stdout
        if result.stderr:
            out += f"\n[stderr] {result.stderr}"
        if result.returncode != 0:
            out += f"\n[exit code: {result.returncode}]"
        return out[:MAX_OUTPUT] if out else "(no output)"
    except subprocess.TimeoutExpired:
        return "[error] Command timed out after 60s"
    except Exception:
        return traceback.format_exc()[:MAX_OUTPUT]
