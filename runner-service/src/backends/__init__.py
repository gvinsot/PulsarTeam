"""
Backend factory — selects the runner backend based on RUNNER_TYPE.
"""

from config import RUNNER_TYPE
from .base import RunnerBackend


def make_backend() -> RunnerBackend:
    """Instantiate the configured backend.

    Imports are lazy so a misconfigured backend doesn't pull in the
    others' dependencies.
    """
    if RUNNER_TYPE == "claude-code":
        from .claude_code import ClaudeCodeBackend
        return ClaudeCodeBackend()
    if RUNNER_TYPE == "openclaw":
        from .openclaw import OpenClawBackend
        return OpenClawBackend()
    if RUNNER_TYPE == "hermes":
        from .hermes import HermesBackend
        return HermesBackend()
    if RUNNER_TYPE == "opencode":
        from .opencode import OpenCodeBackend
        return OpenCodeBackend()
    if RUNNER_TYPE == "sandbox":
        from .sandbox import SandboxBackend
        return SandboxBackend()
    raise RuntimeError(f"Unknown RUNNER_TYPE: {RUNNER_TYPE!r}")


# Singleton instance — instantiated on first import
BACKEND: RunnerBackend = make_backend()
