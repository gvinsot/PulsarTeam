"""
Runner Service — Direct code execution (bypass any LLM agent).
Includes sandboxing for Python exec and command validation for shell.
"""

import io
import os
import subprocess
import traceback
from contextlib import redirect_stdout, redirect_stderr

from config import PROJECTS_DIR
from command_security import validate_command

MAX_OUTPUT = 2000

# Restricted builtins for Python exec — blocks dangerous functions
_BLOCKED_BUILTINS = {"__import__", "exec", "eval", "compile", "open", "breakpoint", "input", "memoryview"}

def _make_safe_builtins():
    import builtins as _builtins
    safe = {}
    for name in dir(_builtins):
        if name in _BLOCKED_BUILTINS:
            continue
        safe[name] = getattr(_builtins, name)
    # Replace __import__ with a restricted version that only allows safe modules
    _SAFE_MODULES = {
        "math", "random", "datetime", "json", "re", "string", "collections",
        "itertools", "functools", "operator", "decimal", "fractions",
        "statistics", "textwrap", "unicodedata", "hashlib", "base64",
        "copy", "pprint", "enum", "dataclasses", "typing", "abc",
        "csv", "io", "pathlib", "urllib.parse",
    }
    def safe_import(name, *args, **kwargs):
        top_level = name.split(".")[0]
        if top_level not in _SAFE_MODULES:
            raise ImportError(f"Import of '{name}' is not allowed in sandboxed execution. Allowed: {sorted(_SAFE_MODULES)}")
        return _builtins.__import__(name, *args, **kwargs)
    safe["__import__"] = safe_import
    return safe

_SAFE_BUILTINS = _make_safe_builtins()


def execute_python(code: str) -> str:
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    try:
        with redirect_stdout(stdout_buf), redirect_stderr(stderr_buf):
            exec(code, {"__builtins__": _SAFE_BUILTINS})
        out = stdout_buf.getvalue()
        err = stderr_buf.getvalue()
        result = out
        if err:
            result += f"\n[stderr] {err}"
        return result[:MAX_OUTPUT] if result else "(no output)"
    except Exception:
        return traceback.format_exc()[:MAX_OUTPUT]


def execute_shell(code: str) -> str:
    # Validate command against security rules
    block_reason = validate_command(code)
    if block_reason:
        return f"[blocked] {block_reason}"

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
