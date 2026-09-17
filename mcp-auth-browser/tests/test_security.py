import asyncio
import socket
import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import egress
import server
from fastapi import HTTPException


class NetworkTests(unittest.IsolatedAsyncioTestCase):
    def test_private_and_transition_addresses_blocked(self):
        for ip in ["127.0.0.1", "10.0.0.1", "172.20.1.1", "192.168.1.50",
                   "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
                   "::1", "fc00::1", "fe80::1", "::ffff:7f00:1",
                   "64:ff9b::a00:1", "2002:0a00:0001::1"]:
            with self.subTest(ip=ip):
                self.assertFalse(egress.public_ip(ip))
        self.assertTrue(egress.public_ip("1.1.1.1"))

    def test_url_credentials_ports_and_schemes(self):
        for url in ["http://example.com", "file:///etc/passwd", "https://u:p@example.com",
                    "https://example.com:444", "https://example.com\\@localhost"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                egress.https_origin(url)
        self.assertEqual(egress.https_origin("https://EXAMPLE.com:443/a"), "https://example.com")

    async def test_mixed_dns_answer_rejected(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 443))
                   for ip in ["1.1.1.1", "127.0.0.1"]]
        with patch.object(asyncio.get_running_loop(), "getaddrinfo", AsyncMock(return_value=records)):
            with self.assertRaises(ValueError):
                await egress.public_addresses("mixed.test")

    async def test_proxy_pins_validated_ip_and_refuses_http(self):
        records = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", ("1.1.1.1", 443))]
        for header, allowed in [(b"CONNECT public.test:443 HTTP/1.1\r\n\r\n", True),
                                (b"GET http://public.test/ HTTP/1.1\r\n\r\n", False),
                                (b"CONNECT public.test:22 HTTP/1.1\r\n\r\n", False)]:
            reader = asyncio.StreamReader()
            reader.feed_data(header)
            reader.feed_eof()
            writer = SimpleNamespace(write=lambda _: None, drain=AsyncMock(), close=lambda: None)
            upstream = asyncio.StreamReader()
            upstream.feed_eof()
            with patch.object(egress, "public_addresses", AsyncMock(return_value=records)), \
                    patch.object(asyncio, "open_connection", AsyncMock(return_value=(upstream, writer))) as connect:
                await egress.PublicProxy().handle(reader, writer)
                if allowed:
                    connect.assert_awaited_once_with("1.1.1.1", 443, family=socket.AF_INET)
                else:
                    connect.assert_not_called()


class SessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.s = server.Session("alice", "https://site.test", ["https://login.test"])
        self.page = SimpleNamespace(url="https://site.test/feed", is_closed=lambda: False,
                                    evaluate=AsyncMock(return_value={"text": "private page"}),
                                    screenshot=AsyncMock(return_value=b"image"),
                                    goto=AsyncMock(), close=AsyncMock())
        self.s.page = self.page
        self.s.context = SimpleNamespace(pages=[self.page])
        self.s.close = AsyncMock()
        server.sessions["agent:a"] = self.s

    async def asyncTearDown(self):
        server.sessions.clear()

    def cmd(self, operation, **args):
        return server.Command(scope="agent:a", operation=operation, **args)

    async def expect_denied(self, cmd, status):
        with self.assertRaises(HTTPException) as err:
            await server.execute(cmd)
        self.assertEqual(err.exception.status_code, status)

    async def test_no_agent_access_until_human_shares(self):
        await self.expect_denied(self.cmd("read"), 409)
        await self.expect_denied(self.cmd("activate"), 403)
        await self.expect_denied(self.cmd("activate", controller="bob", session_id=self.s.id), 403)
        await server.execute(self.cmd("activate", controller="alice", session_id=self.s.id))
        self.assertEqual(await server.execute(self.cmd("read")), {"text": "private page"})
        await server.execute(self.cmd("takeover", controller="alice", session_id=self.s.id))
        await self.expect_denied(self.cmd("read"), 409)

    async def test_cannot_read_other_scope_or_user_login(self):
        await self.expect_denied(server.Command(scope="agent:b", operation="read"), 409)
        await self.expect_denied(self.cmd("frame", controller="bob", session_id=self.s.id), 403)
        await self.expect_denied(self.cmd("frame", controller="alice", session_id="stale"), 403)
        self.page.screenshot.assert_not_awaited()

    async def test_login_provider_and_oauth_callback_cannot_be_shared(self):
        for url in ["https://login.test/", "https://site.test/callback?code=secret"]:
            self.page.url = url
            await self.expect_denied(self.cmd("activate", controller="alice", session_id=self.s.id), 409)
        self.assertEqual(self.s.phase, "login")

    async def test_no_cross_origin_navigation_after_sharing(self):
        self.s.phase = "ready"
        await self.expect_denied(self.cmd("navigate", url="https://evil.test/"), 403)
        self.page.goto.assert_not_awaited()

    async def test_polling_does_not_prolong_lifetime_and_expiry_destroys(self):
        old = self.s.used = time.time() - 500
        await server.execute(self.cmd("status"))
        await server.execute(self.cmd("frame", controller="alice", session_id=self.s.id))
        self.assertEqual(old, self.s.used)
        self.s.created = time.time() - server.SESSION_SECONDS - 1
        self.assertFalse((await server.execute(self.cmd("status")))["exists"])
        self.s.close.assert_awaited_once()
        self.assertNotIn("agent:a", server.sessions)

    async def test_another_editor_can_revoke_but_not_reuse_session(self):
        await self.expect_denied(self.cmd("disconnect", controller="bob", session_id="stale"), 403)
        await server.execute(self.cmd("disconnect", controller="bob", session_id=self.s.id))
        self.assertNotIn("agent:a", server.sessions)
        await self.expect_denied(self.cmd("read"), 409)

    async def test_worker_rejects_missing_or_wrong_service_key(self):
        with patch.object(server, "secret", return_value="k" * 32):
            for auth in ["", "Bearer wrong"]:
                with self.assertRaises(HTTPException) as err:
                    await server.command(self.cmd("status"), auth)
                self.assertEqual(err.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
