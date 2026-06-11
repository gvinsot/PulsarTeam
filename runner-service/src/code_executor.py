"""
Runner Service — Direct code execution (bypass any LLM agent).
Includes sandboxing for Python exec and command validation for shell.
"""

import os
import sys
import subprocess
import traceback

from config import PROJECTS_DIR
from command_security import validate_command, sanitize_env

MAX_OUTPUT = 2000
# Hard cap on command length — defends against absurd payloads that would slow
# down the regex-based blocklist or exhaust shell argv limits.
MAX_COMMAND_LENGTH = 16_384

# Restricted builtins for Python exec — blocks dangerous functions
_BLOCKED_BUILTINS = {"__import__", "exec", "eval", "compile", "open", "breakpoint", "input", "memoryview"}
# Modules the restricted __import__ allows inside the sandbox
_SAFE_MODULES = {
    "math", "random", "datetime", "json", "re", "string", "collections",
    "itertools", "functools", "operator", "decimal", "fractions",
    "statistics", "textwrap", "unicodedata", "hashlib", "base64",
    "copy", "pprint", "enum", "dataclasses", "typing", "abc",
    "csv", "io", "pathlib", "urllib.parse",
}

# Bootstrap executed in a killable child interpreter. It re-imposes the
# restricted builtins/imports, then runs the user payload (read from stdin —
# never string-interpolated, so payload content cannot escape the wrapper).
# On any payload exception it prints the traceback to stderr and exits 1.
_SANDBOX_BOOTSTRAP = f"""
import sys, traceback
import builtins as _builtins

_BLOCKED_BUILTINS = {_BLOCKED_BUILTINS!r}
_SAFE_MODULES = {_SAFE_MODULES!r}

def _safe_import(name, *args, **kwargs):
    top_level = name.split(".")[0]
    if top_level not in _SAFE_MODULES:
        raise ImportError(
            "Import of '%s' is not allowed in sandboxed execution. Allowed: %s"
            % (name, sorted(_SAFE_MODULES))
        )
    return _builtins.__import__(name, *args, **kwargs)

_safe = {{
    name: getattr(_builtins, name)
    for name in dir(_builtins)
    if name not in _BLOCKED_BUILTINS
}}
_safe["__import__"] = _safe_import
_code = sys.stdin.read()
try:
    exec(_code, {{"__builtins__": _safe}})
except BaseException:
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
"""


def execute_python(code: str) -> str:
    # Run the payload in a subprocess so a runaway script (`while True:`,
    # long sleeps) can be killed via timeout instead of wedging the caller.
    # sanitize_env keeps runner secrets out of the child's environment.
    try:
        result = subprocess.run(
            [sys.executable, "-c", _SANDBOX_BOOTSTRAP],
            input=code,
            capture_output=True,
            text=True,
            timeout=60,
            env=sanitize_env(os.environ),
        )
    except subprocess.TimeoutExpired:
        return "[error] Code timed out after 60s"
    except Exception:
        return traceback.format_exc()[:MAX_OUTPUT]
    if result.returncode != 0:
        err = result.stderr or f"[error] exited with code {result.returncode}"
        return err[:MAX_OUTPUT]
    out = result.stdout
    err = result.stderr
    output = out
    if err:
        output += f"\n[stderr] {err}"
    return output[:MAX_OUTPUT] if output else "(no output)"


def execute_shell(code: str) -> str:
    if not code or not code.strip():
        return "[blocked] Empty command"
    if len(code) > MAX_COMMAND_LENGTH:
        return f"[blocked] Command exceeds maximum length ({MAX_COMMAND_LENGTH} chars)"

    # Validate command against security rules (blocklist + dangerous patterns).
    block_reason = validate_command(code)
    if block_reason:
        return f"[blocked] {block_reason}"

    # Use the array form (`["bash", "-c", code]`) instead of `shell=True`. Both
    # invoke a shell that interprets the command, but the array form does not
    # spawn an extra `/bin/sh -c "bash -c '...'"` wrapper and avoids any chance
    # of the parent shell expanding the command before bash sees it. Coupled
    # with sanitize_env(), runner secrets (ANTHROPIC_API_KEY, JWT_SECRET, …)
    # are not exported into the child's environment.
    try:
        result = subprocess.run(
            ["bash", "-c", code],
            capture_output=True,
            text=True,
            timeout=60,
            cwd=PROJECTS_DIR if os.path.isdir(PROJECTS_DIR) else None,
            env=sanitize_env(os.environ),
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
