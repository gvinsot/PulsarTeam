"""
Usage reporter — pushes token-usage events from the runner-service back to
team-api so the budget screen reflects the LLM consumption of CLI runner
agents (claudecode, opencode, codex, hermes, openclaw).

Three call sites feed this module:
  - The CLI backend's run_sync/stream_events paths (covers /v1/chat/completions
    when the API doesn't proxy the response itself — i.e. for non-claudecode
    runners which the API never hits over HTTP today).
  - The PTY shared session, which scans CLI TUI output for known
    "Total cost: $X" / "input N, output M" patterns and reports best-effort.
  - Backend-specific hooks that already parse usage events (e.g. codex
    `token_count` JSONL events) can call report() directly.

Reporting is fire-and-forget — delivery runs in a background task that
retries transient failures (network errors, HTTP 5xx) with a short backoff
and never blocks the agent. Each event carries a uuid4 idempotency key so
the API dedups retries and writes each event to token_usage_log exactly
once, which BudgetDashboard reads from.
"""

from __future__ import annotations

import asyncio
import os
import uuid
from typing import Optional

import httpx
from swarm_secrets import read as read_secret

from config import logger


_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH_TEMPLATE = "/api/internal/token-usage/agents/{agent_id}"
_TIMEOUT = 5.0
_MAX_ATTEMPTS = 3
_RETRY_DELAYS = (1.0, 3.0)
_MAX_PENDING = 256

# Strong refs to in-flight delivery tasks (asyncio only keeps weak ones).
_pending_tasks: set = set()


async def report_usage(
    agent_id: Optional[str],
    *,
    input_tokens: int = 0,
    output_tokens: int = 0,
    cost_usd: float = 0.0,
    context_tokens: int = 0,
    provider: Optional[str] = None,
    model: Optional[str] = None,
) -> bool:
    """Best-effort POST of a token-usage record. Returns True once the
    report is scheduled; delivery (with retries) happens in the background."""
    if not agent_id:
        return False
    # No-op if nothing was consumed.
    if not input_tokens and not output_tokens and not cost_usd:
        return False
    if not _API_KEY:
        logger.debug(f"[Usage] CODER_API_KEY missing — skipping report for agent {agent_id[:8]}")
        return False

    # One key per event (not per attempt) so the API dedups retries.
    idempotency_key = str(uuid.uuid4())
    url = f"{_API_BASE}{_PATH_TEMPLATE.format(agent_id=agent_id)}"
    payload = {
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "cost_usd": float(cost_usd or 0.0),
        "context_tokens": int(context_tokens or 0),
        "provider": provider or "",
        "model": model or "",
        "idempotency_key": idempotency_key,
    }
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": _API_KEY,
        "Authorization": f"Bearer {_API_KEY}",
    }

    if len(_pending_tasks) >= _MAX_PENDING:
        logger.warning(
            f"[Usage] {len(_pending_tasks)} reports already pending — dropping "
            f"report for agent {agent_id[:8]} (idempotency_key={idempotency_key})"
        )
        return False

    task = asyncio.create_task(_deliver(agent_id, url, payload, headers, idempotency_key))
    _pending_tasks.add(task)
    task.add_done_callback(_pending_tasks.discard)
    return True


async def _deliver(agent_id: str, url: str, payload: dict, headers: dict, idempotency_key: str) -> None:
    """Retry loop: transient failures (network, 5xx) are retried with a short
    backoff; 4xx responses and exhausted retries drop the event."""
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        try:
            async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
                resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code < 400:
                logger.info(
                    f"[Usage] reported agent={agent_id[:8]} "
                    f"in={payload['input_tokens']} out={payload['output_tokens']} "
                    f"cost=${payload['cost_usd']:.4f} provider={payload['provider']}"
                )
                return
            if resp.status_code < 500:
                logger.debug(
                    f"[Usage] report rejected for agent {agent_id[:8]}: "
                    f"{resp.status_code} {resp.text[:200]}"
                )
                return
            logger.debug(
                f"[Usage] report failed for agent {agent_id[:8]} "
                f"(attempt {attempt}/{_MAX_ATTEMPTS}): {resp.status_code} {resp.text[:200]}"
            )
        except Exception as e:
            logger.debug(
                f"[Usage] report POST raised for agent {agent_id[:8]} "
                f"(attempt {attempt}/{_MAX_ATTEMPTS}): {e}"
            )
        if attempt < _MAX_ATTEMPTS:
            await asyncio.sleep(_RETRY_DELAYS[min(attempt - 1, len(_RETRY_DELAYS) - 1)])
    logger.warning(
        f"[Usage] dropping report for agent {agent_id[:8]} after "
        f"{_MAX_ATTEMPTS} attempts (idempotency_key={idempotency_key})"
    )
