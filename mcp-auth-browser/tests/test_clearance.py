import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import server
from fastapi import HTTPException

UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
CLEARANCE = [{"name": "cf_clearance", "value": "solved.token-1", "expires": 1893456000}]


def response(challenge=False):
    return SimpleNamespace(headers={"cf-mitigated": "challenge"} if challenge else {})


class ClearanceCookieTests(unittest.TestCase):
    def test_only_cloudflare_cookies_scoped_to_the_shared_host(self):
        cookies = server.clearance_cookies(CLEARANCE + [{"name": "__cf_bm", "value": "b"}],
                                           "https://www.site.test")
        self.assertEqual({c["domain"] for c in cookies}, {"www.site.test"})
        self.assertTrue(all(c["secure"] and c["httpOnly"] for c in cookies))
        for bad in [
            [],
            [{"name": "__cf_bm", "value": "b"}],
            [{"name": "session", "value": "steal"}] + CLEARANCE,
            CLEARANCE * 2,
            [{**CLEARANCE[0], "domain": ".evil.test"}],
            [{**CLEARANCE[0], "value": "a;b"}],
            [{**CLEARANCE[0], "expires": float("nan")}],
            "cf_clearance=x",
        ]:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                server.clearance_cookies(bad, "https://www.site.test")


class ClearanceFlowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.s = server.Session("alice", "https://site.test", [])
        self.s.phase = "ready"
        self.old_page = self.page(challenge=True)
        self.s.page = self.old_page
        user_cookie = {"name": "session", "value": "user-secret", "domain": "site.test", "path": "/"}
        stale = {"name": "cf_clearance", "value": "stale", "domain": "site.test", "path": "/"}
        self.s.context = SimpleNamespace(
            pages=[self.old_page],
            storage_state=AsyncMock(return_value={"cookies": [user_cookie, stale], "origins": []}))
        self.new_page = self.page(challenge=False)

        async def new_context(storage=None, user_agent=None):
            self.rebuilt = (storage, user_agent)
            self.s.context = SimpleNamespace(pages=[self.new_page])
            self.s.page = self.new_page
        self.s.new_context = new_context
        self.s.close = AsyncMock()
        server.sessions["agent:a"] = self.s

    async def asyncTearDown(self):
        server.sessions.clear()

    def page(self, challenge):
        return SimpleNamespace(url="https://site.test/private", is_closed=lambda: False,
                               goto=AsyncMock(return_value=response(challenge)),
                               evaluate=AsyncMock(return_value={"text": "private page"}))

    def cmd(self, operation, **args):
        return server.Command(scope="agent:a", operation=operation, url="https://site.test/private", **args)

    async def test_challenge_is_reported_not_read(self):
        self.assertEqual(await server.execute(self.cmd("navigate")), {"challenge": True})
        self.old_page.evaluate.assert_not_awaited()

    async def test_clearance_keeps_user_session_and_adopts_solver_agent(self):
        result = await server.execute(self.cmd("clearance", cookies=CLEARANCE, user_agent=UA))
        self.assertEqual(result, {"text": "private page"})
        storage, user_agent = self.rebuilt
        self.assertEqual(user_agent, UA)
        self.assertEqual([(c["name"], c["value"]) for c in storage["cookies"]],
                         [("session", "user-secret"), ("cf_clearance", "solved.token-1")])
        self.new_page.goto.assert_awaited_once()

    async def test_unsolved_clearance_and_invalid_input(self):
        self.new_page.goto.return_value = response(challenge=True)
        self.assertEqual(await server.execute(self.cmd("clearance", cookies=CLEARANCE, user_agent=UA)),
                         {"challenge": True})
        with self.assertRaises(HTTPException) as err:
            await server.execute(self.cmd("clearance", cookies=CLEARANCE, user_agent="curl/8"))
        self.assertEqual(err.exception.status_code, 400)
        with self.assertRaises(HTTPException) as err:
            await server.execute(server.Command(scope="agent:a", operation="clearance",
                                                url="https://evil.test/", cookies=CLEARANCE, user_agent=UA))
        self.assertEqual(err.exception.status_code, 403)
        self.s.phase = "login"
        with self.assertRaises(HTTPException) as err:
            await server.execute(self.cmd("clearance", cookies=CLEARANCE, user_agent=UA))
        self.assertEqual(err.exception.status_code, 409)


if __name__ == "__main__":
    unittest.main()
