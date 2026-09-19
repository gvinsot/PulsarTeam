"""FlareSolverr fallback for pages behind an anti-bot challenge (Cloudflare…).

crawl4ai calls `fallback_fetch_function(url)` only after it judged the page
blocked, then turns the returned HTML into Markdown against the original URL.
FlareSolverr drives its own Chrome from the `backend` network, so the page it
finally landed on is re-checked: content from a redirect inward is withheld.
"""
import asyncio
import json
import logging
import os
import urllib.request

FLARESOLVERR_URL = os.getenv("FLARESOLVERR_URL", "")
# FlareSolverr solves in its single Chrome; queue beyond a few tabs at once.
_slots = asyncio.Semaphore(2)
logger = logging.getLogger("mcp-browser")


def _request(url: str) -> dict:
    body = json.dumps({"cmd": "request.get", "url": url, "maxTimeout": 60000}).encode()
    request = urllib.request.Request(FLARESOLVERR_URL, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=90) as response:
        return json.load(response)


def make_fallback(assert_public):
    """The crawl4ai fallback, or None when FlareSolverr is not configured."""
    if not FLARESOLVERR_URL:
        return None

    async def fetch(url: str) -> str:
        async with _slots:
            data = await asyncio.to_thread(_request, url)
        solution = data.get("solution") or {}
        if data.get("status") != "ok" or not solution.get("response"):
            raise RuntimeError(f"FlareSolverr could not load the page: {data.get('message', '')[:200]}")
        await assert_public(solution.get("url") or url)
        logger.info("🧩 FlareSolverr fallback used for %s", url)
        return solution["response"]

    return fetch
