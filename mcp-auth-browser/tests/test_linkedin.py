import sys
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import server
from fastapi import HTTPException
from pydantic import ValidationError

STATE = {"cookies": [{"name": "li_at", "value": "synthetic-secret", "path": "/",
                      "httpOnly": True, "expires": -1, "sameSite": "None"}],
         "localStorage": []}


class LinkedInPureTests(unittest.TestCase):
    def test_scope_prefix_is_a_separate_pinned_slot(self):
        self.assertEqual(server.scope_site("linkedin:agent:a"), "https://www.linkedin.com")
        self.assertIsNone(server.scope_site("agent:a"))
        server.Command(scope="linkedin:board:b", operation="status")
        for scope in ["linkedin:user:a", "other:agent:a", "linkedin:linkedin:agent:a"]:
            with self.subTest(scope=scope), self.assertRaises(ValidationError):
                server.Command(scope=scope, operation="status")

    def test_login_wall_detection(self):
        for url in ["https://www.linkedin.com/login?session_redirect=x",
                    "https://www.linkedin.com/authwall?trk=1",
                    "https://www.linkedin.com/checkpoint/challenge/abc",
                    "https://www.linkedin.com/uas/login",
                    "https://evil.test/feed/", "not a url"]:
            with self.subTest(url=url):
                self.assertTrue(server.linkedin_login_wall(url))
        for url in ["https://www.linkedin.com/feed/", "https://www.linkedin.com/in/login-expert/",
                    "https://www.linkedin.com/learning/"]:
            with self.subTest(url=url):
                self.assertFalse(server.linkedin_login_wall(url))

    def test_links_keep_entities_only_without_tracking(self):
        links = server.linkedin_links([
            {"text": "", "url": "https://www.linkedin.com/in/jane-doe?miniProfileUrn=urn%3Ali"},
            {"text": "  Jane\n Doe ", "url": "https://www.linkedin.com/in/jane-doe/details/experience/"},
            {"text": "Acme", "url": "https://www.linkedin.com/company/acme/about/?trk=x"},
            {"text": "Job", "url": "https://www.linkedin.com/jobs/view/4242/?refId=1"},
            {"text": "Settings", "url": "https://www.linkedin.com/mypreferences/d/"},
            {"text": "Search", "url": "https://www.linkedin.com/search/results/people/?keywords=a"},
            {"text": "Evil", "url": "https://evil.test/in/jane-doe"},
            {"text": "Broken", "url": "javascript:alert(1)"},
            "not-a-link",
        ])
        self.assertEqual(links, [
            {"text": "Jane Doe", "url": "https://www.linkedin.com/in/jane-doe/"},
            {"text": "Acme", "url": "https://www.linkedin.com/company/acme/"},
            {"text": "Job", "url": "https://www.linkedin.com/jobs/view/4242/"},
        ])


class LinkedInSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        server.pending_imports.clear()
        server.sessions.clear()

    async def prepare(self, url="https://www.linkedin.com/"):
        with patch.object(server, "public_addresses", AsyncMock(return_value=[])):
            return await server.execute(server.Command(
                scope="linkedin:agent:a", controller="alice", operation="prepare_import", url=url))

    async def test_pinned_to_linkedin_and_no_remote_login(self):
        with self.assertRaises(HTTPException) as err:
            await self.prepare("https://www.site.test/")
        self.assertEqual(err.exception.status_code, 400)
        with patch.object(server, "public_addresses", AsyncMock(return_value=[])), \
                self.assertRaises(HTTPException):
            await server.execute(server.Command(scope="linkedin:agent:a", controller="alice",
                                                operation="start", url="https://www.linkedin.com/"))
        self.assertFalse(server.sessions)
        prepared = await self.prepare()
        self.assertEqual(prepared["site"], "https://www.linkedin.com")
        # The generic slot of the same agent is untouched.
        self.assertFalse((await server.execute(server.Command(scope="agent:a", operation="status")))["exists"])

    async def test_import_opens_feed_and_refuses_login_wall(self):
        for landed, connected in [("https://www.linkedin.com/feed/", True),
                                  ("https://www.linkedin.com/login?session_redirect=feed", False)]:
            prepared = await self.prepare()
            opened = []

            async def open_session(s, playwright, url, storage, landed=landed):
                opened.append(url)
                s.active_page = lambda: SimpleNamespace(url=landed)
            server.app.state.playwright = object()
            with patch.object(server.Session, "open", open_session), \
                    patch.object(server.Session, "close", AsyncMock()) as close:
                command = server.Command(scope="linkedin:agent:a", controller="alice", operation="import",
                                         session_id=prepared["sessionId"], storage=STATE)
                if connected:
                    result = await server.execute(command)
                    self.assertTrue(result["connected"])
                    self.assertEqual(server.sessions["linkedin:agent:a"].kind, "linkedin")
                    server.sessions.clear()
                else:
                    with self.assertRaises(HTTPException) as err:
                        await server.execute(command)
                    self.assertEqual(err.exception.status_code, 401)
                    close.assert_awaited_once()
                    self.assertFalse(server.sessions)
            self.assertEqual(opened, ["https://www.linkedin.com/feed/"])

    def ready_session(self, url="https://www.linkedin.com/feed/"):
        s = server.Session("alice", "https://www.linkedin.com", [], kind="linkedin")
        s.phase = "ready"
        page = SimpleNamespace(url=url, is_closed=lambda: False, goto=AsyncMock(return_value=None),
                               wait_for_selector=AsyncMock(), wait_for_timeout=AsyncMock(),
                               mouse=SimpleNamespace(wheel=AsyncMock()),
                               evaluate=AsyncMock(side_effect=self.evaluate))
        s.page, s.context, s.close = page, SimpleNamespace(pages=[page]), AsyncMock()
        server.sessions["linkedin:agent:a"] = s
        return s, page

    async def evaluate(self, script):
        if script == server.LINKEDIN_SNAPSHOT:
            return {"url": "https://www.linkedin.com/feed/", "title": "Feed", "text": "post",
                    "links": [{"text": "Jane", "url": "https://www.linkedin.com/in/jane/?x=1"}]}
        return 4

    async def test_agent_reads_main_content_and_login_wall_hides_page(self):
        _, page = self.ready_session()
        result = await server.execute(server.Command(scope="linkedin:agent:a", operation="read"))
        self.assertEqual(result["links"], [{"text": "Jane", "url": "https://www.linkedin.com/in/jane/"}])
        page.url = "https://www.linkedin.com/authwall?trk=1"
        page.evaluate.reset_mock()
        result = await server.execute(server.Command(scope="linkedin:agent:a", operation="read"))
        self.assertEqual(result, {"loginRequired": True})
        page.evaluate.assert_not_awaited()

    async def test_navigation_is_paced_and_capped(self):
        s, page = self.ready_session()
        nav = server.Command(scope="linkedin:agent:a", operation="navigate",
                             url="https://www.linkedin.com/in/jane/")
        with patch.object(server.asyncio, "sleep", AsyncMock()) as sleep:
            await server.execute(nav)
            sleep.assert_not_awaited()
            await server.execute(nav)
            self.assertGreater(sleep.await_args.args[0], 0)
        s.page_loads.extend([time.time() - 60] * server.LINKEDIN_PAGES_PER_HOUR)
        page.goto.reset_mock()
        result = await server.execute(nav)
        self.assertTrue(result["limited"])
        self.assertGreater(result["retryAfterSeconds"], 3000)
        page.goto.assert_not_awaited()
        with self.assertRaises(HTTPException) as err:
            await server.execute(server.Command(scope="linkedin:agent:a", operation="navigate",
                                                url="https://evil.test/in/jane/"))
        self.assertEqual(err.exception.status_code, 403)


if __name__ == "__main__":
    unittest.main()
