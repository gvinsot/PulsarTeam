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

Reporting is fire-and-forget — failures are logged at debug level and never
block the agent. The endpoint dedups internally and writes to token_usage_log,
which BudgetDashboard reads from.
"""

from __future__ import annotations

import os
from typing import Optional

import httpx
from swarm_secrets import read as read_secret

from config import logger


_API_BASE = os.getenv("SWARM_API_BASE_URL", "http://team-api:3001").rstrip("/")
_API_KEY = read_secret("CODER_API_KEY", default="")
_PATH_TEMPLATE = "/api/internal/token-usage/agents/{agent_id}"
_TIMEOUT = 5.0


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
    """Best-effort POST of a token-usage record. Returns True on 2xx."""
    if not agent_id:
        return False
    # No-op if nothing was consumed.
    if not input_tokens and not output_tokens and not cost_usd:
        return False
    if not _API_KEY:
        logger.debug(f"[Usage] CODER_API_KEY missing — skipping report for agent {agent_id[:8]}")
        return False

    url = f"{_API_BASE}{_PATH_TEMPLATE.format(agent_id=agent_id)}"
    payload = {
        "input_tokens": int(input_tokens or 0),
        "output_tokens": int(output_tokens or 0),
        "cost_usd": float(cost_usd or 0.0),
        "context_tokens": int(context_tokens or 0),
        "provider": provider or "",
        "model": model or "",
    }
    headers = {
        "Content-Type": "application/json",
        "X-Api-Key": _API_KEY,
        "Authorization": f"Bearer {_API_KEY}",
    }
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.status_code >= 400:
                logger.debug(
                    f"[Usage] report failed for agent {agent_id[:8]}: "
                    f"{resp.status_code} {resp.text[:200]}"
                )
                return False
            logger.info(
                f"[Usage] reported agent={agent_id[:8]} "
                f"in={payload['input_tokens']} out={payload['output_tokens']} "
                f"cost=${payload['cost_usd']:.4f} provider={payload['provider']}"
            )
            return True
    except Exception as e:
        logger.debug(f"[Usage] report POST raised for agent {agent_id[:8]}: {e}")
        return False
