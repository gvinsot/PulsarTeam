"""
Runner Service — Backend abstraction.

A `RunnerBackend` encapsulates everything that differs between agent
runtimes (claude-code, openclaw, hermes, opencode, sandbox). The rest of
the service (HTTP routes, agent isolation, project management) is shared.

Backends should be lightweight singletons — instantiated once at startup
based on the RUNNER_TYPE env var.
"""

from typing import Any, AsyncIterator, Optional


class RunnerBackend:
    """Abstract base. Subclasses override the methods they support.

    Methods left unimplemented raise NotImplementedError; the matching HTTP
    routes will return 501 instead of crashing.
    """

    name: str = "base"

    # ── Capabilities ──────────────────────────────────────────────────────
    # Drive which HTTP routes the service exposes for this backend.

    supports_agent: bool = True       # /execute, /stream, /v1/chat/completions
    supports_oauth_login: bool = False  # /auth/login, /auth/agent/.../login, /auth/owner/.../login
    supports_token_set: bool = False    # /auth/token, /auth/agent/.../token, /auth/owner/.../token

    # ── Lifecycle ─────────────────────────────────────────────────────────

    async def startup(self) -> None:
        """Called once after FastAPI starts. Use to validate CLI presence,
        load saved tokens, etc."""

    async def shutdown(self) -> None:
        """Called once when FastAPI shuts down."""

    # ── Health ────────────────────────────────────────────────────────────

    def health(self) -> dict:
        """Return a dict with at least {"status": "healthy"|"degraded"}.

        Backends typically include CLI version, model, etc.
        """
        return {"status": "healthy", "backend": self.name}

    # ── Permissions ───────────────────────────────────────────────────────

    def set_agent_permissions(self, agent_id: str, permissions: dict) -> None:
        """Store permissions for an agent (sent via X-Agent-Permissions header)."""

    # ── Sessions (per-agent, per-task) ────────────────────────────────────

    def reset_agent_sessions(self, agent_id: str, task_id: Optional[str] = None) -> int:
        """Forget any cached session for an agent. Returns count cleared."""
        return 0

    # ── Agent execution ───────────────────────────────────────────────────

    async def run_sync(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> dict:
        """Run an agent turn synchronously and return a result dict.

        Result dict keys:
          status: "success" | "error" | "auth_required" | "timeout"
          output: str (the assistant's final reply)
          error: str | None
          login_url: str | None
          cost_usd / duration_ms / total_tokens / input_tokens / output_tokens
        """
        raise NotImplementedError(f"{self.name} backend does not support run_sync")

    async def stream_events(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
    ) -> AsyncIterator[dict]:
        """Async generator yielding event dicts.

        Event types: "text", "thinking", "status", "result", "error".
        The final event is typically "result" carrying token/cost metadata.
        """
        raise NotImplementedError(f"{self.name} backend does not support stream_events")
        yield  # pragma: no cover — make this an async generator

    # ── Auth (only for backends with supports_oauth_login or supports_token_set) ──

    async def auth_status(self) -> dict:
        """Global auth status. Return at least {"authenticated": bool, "method": str}."""
        return {"authenticated": False, "method": "none"}

    async def auth_login_url(self) -> Optional[str]:
        """Generate or return a pending login URL. None if no flow active."""
        return None

    async def auth_set_token(self, token: str) -> None:
        """Persist a manually-supplied token (e.g. from `claude setup-token`)."""
        raise NotImplementedError(f"{self.name} backend does not support setting tokens")

    # ── Agent / Owner OAuth (Claude-specific, optional) ───────────────────

    async def agent_auth_status(self, agent_id: str) -> dict:
        return {"authenticated": False, "agent_id": agent_id}

    async def agent_auth_login_url(self, agent_id: str) -> Optional[str]:
        return None

    async def agent_auth_callback(self, agent_id: str, code: str) -> dict:
        raise NotImplementedError

    async def agent_set_token(self, agent_id: str, token: str) -> None:
        raise NotImplementedError

    async def owner_auth_status(self, owner_id: str) -> dict:
        return {"authenticated": False, "owner_id": owner_id}

    async def owner_auth_login_url(self, owner_id: str) -> Optional[str]:
        return None

    async def owner_auth_callback(self, owner_id: str, code: str) -> dict:
        raise NotImplementedError

    async def owner_set_token(self, owner_id: str, token: str) -> None:
        raise NotImplementedError
