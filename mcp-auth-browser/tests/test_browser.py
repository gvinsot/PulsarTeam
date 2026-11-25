"""Real Chromium contract test with a synthetic site/identity provider, no accounts.
Run with BROWSER_E2E=1 after `playwright install chromium`.
"""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
import server
from fastapi import HTTPException
from playwright.async_api import async_playwright


@unittest.skipUnless(os.environ.get("BROWSER_E2E") == "1", "Set BROWSER_E2E=1 for real Chromium")
class BrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_instagram_api_receives_parent_cookies_but_not_host_only_cookies(self):
        origin = 'https://www.instagram.com'
        async with async_playwright() as pw:
            sent = []
            async def launch(**kwargs):
                browser = await pw.chromium.launch(**kwargs)
                async def new_context(**options):
                    ctx = await browser.new_context(**options)
                    async def fixture(route):
                        if route.request.url.startswith('https://i.instagram.com/'):
                            cookie = (await route.request.all_headers()).get('cookie', '')
                            sent.append(cookie)
                            body = '{"status":"ok"}' if 'sid=synthetic' in cookie else '{"message":"login_required"}'
                            await route.fulfill(status=200, body=body, headers={
                                'content-type': 'application/json', 'content-length': str(len(body)),
                                'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true'})
                        else:
                            await route.fulfill(content_type='text/html', body='''<html><body><main>Editor</main>
                              <button onclick="fetch('https://i.instagram.com/api/v1/media/configure/', {credentials:'include'})
                                .then(r=>r.json()).then(r=>document.querySelector('main').innerText=r.message||'Accepted')">Share</button>
                              </body></html>''')
                    await ctx.route('**/*', fixture)
                    return ctx
                return SimpleNamespace(new_context=new_context, close=browser.close)
            server.app.state.playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch))
            for parent in [False, True]:
                cookie = {'name': 'sid', 'value': 'synthetic', 'httpOnly': True, 'sameSite': 'None',
                          **({'domain': '.instagram.com'} if parent else {})}
                with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
                    pending = await server.execute(server.Command(scope='board:instagram-test', controller='alice',
                        operation='prepare_import', url=origin))
                state = await server.execute(server.Command(scope='board:instagram-test', controller='alice',
                    operation='import', session_id=pending['sessionId'], url=origin + '/editor',
                    storage={'cookies': [cookie]}))
                try:
                    result = await server.execute(server.Command(scope='board:instagram-test', operation='agent_click',
                        target={'by': 'role', 'value': 'button', 'name': 'Share'}))
                    self.assertEqual('sid=synthetic' in sent[-1], parent)
                    if parent:
                        self.assertIn('Accepted', result['text'])
                        self.assertNotIn('requiresReauthentication', result)
                    else:
                        self.assertTrue(result['requiresReauthentication'])
                finally:
                    await server.execute(server.Command(scope='board:instagram-test', operation='disconnect',
                        controller='alice', session_id=state['sessionId']))

    async def test_human_login_handoff_and_site_boundary(self):
        async with async_playwright() as pw:
            # Install a synthetic upstream UNDER the production navigation guard.
            # fallback() reaches it only if the guard permits the request.
            async def launch(**kwargs):
                browser = await pw.chromium.launch(**kwargs)

                async def new_context(**options):
                    ctx = await browser.new_context(**options)

                    async def fixture(route):
                        u = route.request.url
                        if u == "https://site.test/":
                            html = '<a href="https://identity.test/">Sign in with OAuth</a>'
                        elif u == "https://identity.test/":
                            html = '<button onclick="location.href=\'https://site.test/feed\'">Authorize</button>'
                        elif u == "https://site.test/feed":
                            html = '<h1>Private feed</h1><input type="password" hidden value="secret-not-for-agent"><a href="/next">Next</a><a href="https://evil.test/">External</a>'
                        else:
                            html = '<h1>Next private page</h1>'
                        await route.fulfill(status=200, content_type="text/html", body=html)
                    await ctx.route("**/*", fixture)
                    return ctx
                return SimpleNamespace(new_context=new_context, close=browser.close)

            server.app.state.playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch))
            with patch.object(server, "public_addresses", AsyncMock(return_value=[])):
                state = await server.execute(server.Command(scope="agent:e2e", operation="start",
                    controller="alice", url="https://site.test/", login_origins=["https://identity.test"]))
            sid = state["sessionId"]
            s = server.sessions["agent:e2e@site.test"]
            human = dict(scope="agent:e2e", controller="alice", session_id=sid)
            try:
                with self.assertRaises(HTTPException):
                    await server.execute(server.Command(scope="agent:e2e", operation="read"))
                # UI controls are exercised through the same worker commands.
                await server.execute(server.Command(**human, operation="click", x=60, y=15))
                await s.page.wait_for_url("https://identity.test/")
                await server.execute(server.Command(**human, operation="click", x=40, y=15))
                await s.page.wait_for_url("https://site.test/feed")
                frame = await server.execute(server.Command(**human, operation="frame"))
                self.assertGreater(len(frame["image"]), 100)
                await server.execute(server.Command(**human, operation="activate"))
                page = await server.execute(server.Command(scope="agent:e2e", operation="read"))
                self.assertIn("Private feed", page["text"])
                self.assertNotIn("secret-not-for-agent", str(page))
                self.assertEqual([l["url"] for l in page["links"]], ["https://site.test/next"])
                await server.execute(server.Command(scope="agent:e2e", operation="navigate", url="https://site.test/next"))
                self.assertIn("Next private page", (await server.execute(server.Command(scope="agent:e2e", operation="read")))["text"])
                # Redirect/navigation guards remain effective in the real browser.
                with self.assertRaises(Exception):
                    await s.page.goto("https://identity.test/", timeout=5000)
                await server.execute(server.Command(**human, operation="takeover"))
                with self.assertRaises(HTTPException):
                    await server.execute(server.Command(scope="agent:e2e", operation="read"))
            finally:
                await server.execute(server.Command(**human, operation="disconnect"))


if __name__ == "__main__":
    unittest.main()
