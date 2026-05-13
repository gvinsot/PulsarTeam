"""
Sandbox backend — no LLM agent, just bare exec/file ops.

Used when the API server orchestrates the LLM directly and only needs
the runner-service for shell exec, file operations, and project setup
(via the shared HTTP routes — /exec-shell, /projects/ensure, ...).

run_sync / stream_events return a clear "not supported" error so callers
fall back to direct LLM invocation.
"""

from typing import AsyncIterator, Optional

from config import logger
from .base import RunnerBackend


class SandboxBackend(RunnerBackend):
    name = "sandbox"
    supports_agent = False           # /execute, /stream return 501
    supports_oauth_login = False
    supports_token_set = False

    async def startup(self) -> None:
        logger.info("Sandbox backend starting (no LLM — exec/file ops only)")

    def health(self) -> dict:
        return {"status": "healthy", "backend": self.name, "mode": "exec-only"}

    async def run_sync(self, prompt, system_prompt=None, agent_id=None, owner_id=None, task_id=None, session_id=None, messages=None) -> dict:
        return {
            "status": "error",
            "output": "",
            "error": "Sandbox runner has no LLM agent. Use /exec-shell or call your LLM provider directly.",
        }

    async def stream_events(self, prompt, system_prompt=None, agent_id=None, owner_id=None, task_id=None, session_id=None, messages=None) -> AsyncIterator[dict]:
        yield {
            "type": "error",
            "content": "Sandbox runner has no LLM agent. Use /exec-shell or call your LLM provider directly.",
        }
