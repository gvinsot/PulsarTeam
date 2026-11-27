"""Private API transport. PostgreSQL and encryption keys remain in the API."""
import asyncio
import contextlib
import json
import os
from urllib.request import Request, build_opener, HTTPRedirectHandler, ProxyHandler


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


class SessionStore:
    def __init__(self, secret):
        self.url = os.environ.get("AUTH_BROWSER_STATE_API_URL", "").rstrip("/")
        self.secret = secret

    @property
    def enabled(self):
        return bool(self.url)

    async def request(self, method, payload=None, path=""):
        if not self.enabled:
            return {"sessions": []}
        data = json.dumps(payload).encode() if payload is not None else None
        if data and len(data) > 5 * 1024 * 1024:
            raise RuntimeError("Browser snapshot exceeds storage limit")

        def send():
            request = Request(self.url + path, data=data, method=method, headers={
                "Authorization": "Bearer " + self.secret(), "Content-Type": "application/json"})
            # Never forward the worker credential through a redirect or an
            # environment-configured proxy. URL is deployment configuration.
            with build_opener(ProxyHandler({}), NoRedirects()).open(request, timeout=10) as response:
                body = response.read(32 * 1024 * 1024 + 1)
                if len(body) > 32 * 1024 * 1024:
                    raise RuntimeError("Browser snapshot response exceeds limit")
                return json.loads(body) if body else {}
        task = asyncio.create_task(asyncio.to_thread(send))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            # Do not release a session lock with a PUT still in flight: it could
            # complete after a subsequent disconnect and resurrect credentials.
            with contextlib.suppress(Exception):
                await task
            raise
        except Exception:
            raise RuntimeError("Browser session storage unavailable") from None

    async def load(self):
        return (await self.request("GET"))["sessions"]

    async def save(self, snapshot):
        await self.request("PUT", snapshot)

    async def delete(self, key):
        await self.request("DELETE", {"key": key})

    async def credentials(self, key):
        """Sign-in credentials the human stored for this session, or None.
        Fetched only for an automatic sign-in, never cached by the caller."""
        if not self.enabled:
            return None
        return (await self.request("POST", {"key": key}, "/credentials")).get("credentials")
