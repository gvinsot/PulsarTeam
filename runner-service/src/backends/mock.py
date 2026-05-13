"""
Mock backend — simulates an LLM service with hard-coded responses.

Used for testing the runner-service without spending API credits, without
requiring CLI tools to be installed, and without network access. Responses
are deterministic and based on simple keyword matching against the prompt.

Configuration via env vars:
  MOCK_DELAY_MS        per-chunk delay when streaming (default: 50)
  MOCK_FAIL_ON         substring that triggers a simulated error response
  MOCK_TIMEOUT_ON      substring that triggers a simulated timeout
"""

import os
import time
import asyncio
from typing import AsyncIterator, Optional

from config import RUNNER_MODEL, logger
from .base import RunnerBackend


MOCK_DELAY_MS = int(os.getenv("MOCK_DELAY_MS", "50"))
MOCK_FAIL_ON = os.getenv("MOCK_FAIL_ON", "").strip()
MOCK_TIMEOUT_ON = os.getenv("MOCK_TIMEOUT_ON", "").strip()


CANNED_RESPONSES: list[tuple[tuple[str, ...], str]] = [
    (
        ("hello", "hi ", "hey", "salut", "bonjour"),
        "Hello! I'm a mock LLM running inside the runner-service for testing. "
        "I respond with hard-coded answers — no real model is called.",
    ),
    (
        ("python", "def ", "fizzbuzz"),
        "Here is a small Python example:\n\n"
        "```python\n"
        "def fizzbuzz(n: int) -> str:\n"
        "    if n % 15 == 0: return 'FizzBuzz'\n"
        "    if n % 3 == 0:  return 'Fizz'\n"
        "    if n % 5 == 0:  return 'Buzz'\n"
        "    return str(n)\n"
        "```\n",
    ),
    (
        ("test", "unit test", "pytest"),
        "Sure — here's a minimal pytest example:\n\n"
        "```python\n"
        "def test_addition():\n"
        "    assert 1 + 1 == 2\n"
        "```\n",
    ),
    (
        ("list files", "ls", "directory"),
        "I would normally call a shell tool to list files, but in mock mode I "
        "return a fixed sample:\n- README.md\n- src/\n- tests/\n",
    ),
    (
        ("error", "exception", "stacktrace"),
        "It looks like you're asking about an error. In mock mode I always "
        "respond with: 'Check the stacktrace, then narrow down by bisection.'",
    ),
    (
        ("explain", "what is", "how does"),
        "In mock mode, every explanation is the same: this is the runner-service "
        "mock backend, which returns canned responses keyed off the prompt.",
    ),
]


DEFAULT_RESPONSE = (
    "[mock] I received your prompt and produced this canned response. "
    "The mock backend does not call any real LLM; it is intended for "
    "integration testing of the runner-service HTTP surface."
)


def _pick_response(prompt: str) -> str:
    p = (prompt or "").lower()
    for keywords, reply in CANNED_RESPONSES:
        if any(k in p for k in keywords):
            return reply
    return DEFAULT_RESPONSE


def _estimate_tokens(text: str) -> int:
    return max(1, len(text) // 4)


class MockBackend(RunnerBackend):
    """Hard-coded LLM simulator.

    Returns deterministic responses based on simple keyword matching, with
    realistic-looking token counts, costs, and durations. Streaming splits
    the canned response into word-sized chunks separated by a small delay
    so SSE consumers can be exercised end-to-end.
    """

    name = "mock"
    supports_agent = True
    supports_oauth_login = False
    supports_token_set = False

    def __init__(self):
        self._permissions: dict[str, dict] = {}

    async def startup(self) -> None:
        logger.info("Mock backend starting (no real LLM — returns canned responses)")
        logger.info(f"  Stream chunk delay: {MOCK_DELAY_MS}ms")
        if MOCK_FAIL_ON:
            logger.info(f"  Will simulate errors for prompts containing: {MOCK_FAIL_ON!r}")
        if MOCK_TIMEOUT_ON:
            logger.info(f"  Will simulate timeouts for prompts containing: {MOCK_TIMEOUT_ON!r}")

    def health(self) -> dict:
        return {
            "status": "healthy",
            "backend": self.name,
            "model": RUNNER_MODEL,
            "mode": "canned-responses",
        }

    def set_agent_permissions(self, agent_id: str, permissions: dict) -> None:
        if agent_id and permissions:
            self._permissions[agent_id] = permissions

    def _maybe_simulate_failure(self, prompt: str) -> Optional[dict]:
        if MOCK_FAIL_ON and MOCK_FAIL_ON.lower() in prompt.lower():
            return {
                "status": "error",
                "output": "",
                "error": f"[mock] Simulated failure (prompt contained {MOCK_FAIL_ON!r})",
            }
        return None

    async def _maybe_simulate_timeout(self, prompt: str) -> Optional[dict]:
        if MOCK_TIMEOUT_ON and MOCK_TIMEOUT_ON.lower() in prompt.lower():
            await asyncio.sleep(0.05)
            return {
                "status": "timeout",
                "output": "",
                "error": f"[mock] Simulated timeout (prompt contained {MOCK_TIMEOUT_ON!r})",
            }
        return None

    async def run_sync(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        messages: Optional[list] = None,
    ) -> dict:
        logger.info(f"[mock] run_sync: {prompt[:80]!r}")
        start = time.monotonic()

        failure = self._maybe_simulate_failure(prompt)
        if failure:
            return failure
        timeout = await self._maybe_simulate_timeout(prompt)
        if timeout:
            return timeout

        await asyncio.sleep(MOCK_DELAY_MS / 1000.0)

        output = _pick_response(prompt)
        input_tokens = _estimate_tokens(prompt) + _estimate_tokens(system_prompt or "")
        output_tokens = _estimate_tokens(output)
        total_tokens = input_tokens + output_tokens
        duration_ms = int((time.monotonic() - start) * 1000)

        return {
            "status": "success",
            "output": output,
            "cost_usd": round(total_tokens * 0.000003, 6),
            "duration_ms": duration_ms,
            "total_tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    async def stream_events(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        agent_id: Optional[str] = None,
        owner_id: Optional[str] = None,
        task_id: Optional[str] = None,
        session_id: Optional[str] = None,
        messages: Optional[list] = None,
    ) -> AsyncIterator[dict]:
        logger.info(f"[mock] stream_events: {prompt[:80]!r}")
        start = time.monotonic()

        failure = self._maybe_simulate_failure(prompt)
        if failure:
            yield {"type": "error", "content": failure["error"]}
            return

        timeout = await self._maybe_simulate_timeout(prompt)
        if timeout:
            yield {"type": "error", "content": timeout["error"]}
            return

        yield {"type": "status", "content": "mock backend received prompt"}
        await asyncio.sleep(MOCK_DELAY_MS / 1000.0)

        yield {"type": "thinking", "content": "Picking a canned response based on prompt keywords..."}
        await asyncio.sleep(MOCK_DELAY_MS / 1000.0)

        output = _pick_response(prompt)

        # Stream the response word-by-word so SSE consumers see incremental output.
        words = output.split(" ")
        for i, word in enumerate(words):
            chunk = word if i == 0 else " " + word
            yield {"type": "text", "content": chunk}
            if MOCK_DELAY_MS > 0:
                await asyncio.sleep(MOCK_DELAY_MS / 1000.0)

        input_tokens = _estimate_tokens(prompt) + _estimate_tokens(system_prompt or "")
        output_tokens = _estimate_tokens(output)
        total_tokens = input_tokens + output_tokens
        duration_ms = int((time.monotonic() - start) * 1000)

        yield {
            "type": "result",
            "content": "",
            "cost_usd": round(total_tokens * 0.000003, 6),
            "duration_ms": duration_ms,
            "total_tokens": total_tokens,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }
