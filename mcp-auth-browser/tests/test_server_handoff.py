"""Real Chromium regressions for a single local-to-server session handoff."""
import os
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import server
import page_state
from fastapi import HTTPException
from playwright.async_api import async_playwright

ORIGIN = 'https://site.test'
STATE = {'cookies': [{'name': 'sid', 'value': 'chosen-identity', 'path': '/',
                     'httpOnly': True, 'expires': -1, 'sameSite': 'Lax'}],
         'localStorage': []}


class HandoffUrlTests(unittest.TestCase):
    def test_completed_same_origin_page_only(self):
        self.assertEqual(page_state.shared_url(ORIGIN + '/feed?view=recent', ORIGIN),
                         ORIGIN + '/feed?view=recent')
        for url in ['https://accounts.google.com/', ORIGIN + '/login', ORIGIN + '/authwall',
                    ORIGIN + '/callback?code=secret', ORIGIN + '/#access_token=secret']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                page_state.shared_url(url, ORIGIN)


@unittest.skipUnless(os.getenv('BROWSER_E2E') == '1', 'Set BROWSER_E2E=1 for Chromium checks')
class ServerHandoffTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.pw = await async_playwright().start()
        self.launches = 0
        self.requests = []

        async def launch(**kwargs):
            self.launches += 1
            browser = await self.pw.chromium.launch(**kwargs)
            new_context = browser.new_context

            async def context(**options):
                result = await new_context(**options)
                await result.route('**/*', self.fixture)
                return result
            browser.new_context = context
            return browser
        server.app.state.playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch))

    async def fixture(self, route):
        request = route.request
        self.requests.append((request.url, (await request.all_headers()).get('cookie', '')))
        path = request.url.removeprefix(ORIGIN)
        if path == '/feed':
            body = '''<html><body><script>setTimeout(() => {
              document.title = 'Private feed';
              document.body.innerHTML = '<main>Chosen identity feed</main><a href="/next">Next</a>';
            }, 500);</script></body></html>'''
        elif path == '/empty':
            body = '<html><title>Empty application shell</title><body></body></html>'
        elif path in {'/expired', '/google-redirect'}:
            destination = ORIGIN + '/login' if path == '/expired' else 'https://accounts.google.com/'
            await route.fulfill(status=302, headers={'location': destination}, body='')
            return
        elif path == '/login':
            body = '<html><body>Sign in with Google<input type="password"></body></html>'
        else:
            body = '<html><title>Next</title><body><main>Next private page</main></body></html>'
        await route.fulfill(content_type='text/html', body=body)

    async def asyncTearDown(self):
        for session in list(server.sessions.values()):
            await session.close()
        server.sessions.clear()
        server.pending_imports.clear()
        await self.pw.stop()

    async def import_page(self, path='/feed'):
        with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
            pending = await server.execute(server.Command(scope='board:a', controller='alice',
                operation='prepare_import', url=ORIGIN))
        return await server.execute(server.Command(scope='board:a', controller='alice',
            operation='import', session_id=pending['sessionId'], storage=STATE, url=ORIGIN + path))

    async def test_waits_for_render_and_keeps_owned_page_session_and_identity(self):
        status = await self.import_page()
        self.assertEqual(status['phase'], 'ready')
        self.assertEqual(status['pageState'], 'ready')
        self.assertTrue(status['canRead'])
        result = await server.execute(server.Command(scope='board:a', operation='read'))
        self.assertEqual(result['title'], 'Private feed')
        self.assertIn('Chosen identity', result['text'])
        session = server.sessions['board:a']
        page = session.active_page()
        await page.evaluate("() => { window.open('about:blank'); window.open('https://accounts.google.com/'); }")
        await page.wait_for_timeout(300)
        self.assertIs(session.active_page(), page)
        self.assertEqual(len(session.context.pages), 1)
        for path in ['/next', '/another']:
            result = await server.execute(server.Command(scope='board:a', operation='navigate', url=ORIGIN + path))
            self.assertIn('Next private page', result['text'])
            current = await server.execute(server.Command(scope='board:a', operation='status'))
            self.assertEqual(current['sessionId'], status['sessionId'])
            self.assertFalse(current['canControl'])
            self.assertTrue(current['canRead'])
            self.assertEqual(current['browserLocation'], 'server')
        self.assertEqual(self.launches, 1)
        self.assertTrue(all(url.startswith(ORIGIN + '/') for url, _ in self.requests))
        self.assertTrue(all('sid=chosen-identity' in cookies for _, cookies in self.requests))
        # Pausing an imported session does not turn it into a server login flow.
        await server.execute(server.Command(scope='board:a', controller='alice',
            session_id=status['sessionId'], operation='takeover'))
        await page.evaluate("() => { window.open('about:blank'); }")
        await page.wait_for_timeout(200)
        self.assertIs(session.active_page(), page)
        self.assertEqual(len(session.context.pages), 1)
        await server.execute(server.Command(scope='board:a', controller='alice',
            session_id=status['sessionId'], operation='activate'))

    async def test_empty_import_is_never_ready(self):
        with patch.object(page_state, 'READ_TIMEOUT', 0.4), self.assertRaises(HTTPException) as error:
            await self.import_page('/empty')
        self.assertEqual(error.exception.status_code, 424)
        self.assertFalse(server.sessions)
        self.assertFalse(server.pending_imports)

    async def test_rejected_session_does_not_log_in_with_google(self):
        for path in ['/expired', '/google-redirect']:
            with self.subTest(path=path), self.assertRaises(HTTPException) as error:
                await self.import_page(path)
            self.assertEqual(error.exception.status_code, 401)
            self.assertFalse(server.sessions)
        self.assertTrue(all(url.startswith(ORIGIN + '/') for url, _ in self.requests))

    async def test_expired_session_requires_explicit_local_transfer(self):
        initial = await self.import_page()
        with self.assertRaises(HTTPException) as error:
            await server.execute(server.Command(scope='board:a', operation='navigate', url=ORIGIN + '/expired'))
        self.assertEqual(error.exception.status_code, 401)
        current = await server.execute(server.Command(scope='board:a', operation='status'))
        self.assertEqual(current['sessionId'], initial['sessionId'])
        self.assertEqual(current['phase'], 'reauth_required')
        self.assertFalse(current['connected'])
        self.assertFalse(current['canRead'])
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:a', operation='read'))
        self.assertEqual(self.launches, 1)
