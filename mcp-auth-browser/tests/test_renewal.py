"""Configurable lifetime, keepalive and automatic sign-in of shared sessions."""
import copy
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import autologin
import server
from fastapi import HTTPException

ORIGIN = 'https://site.test'
CREDENTIALS = {'username': 'alice@example.com', 'password': 'correct horse'}


class Store:
    enabled = True

    def __init__(self, credentials=None):
        self.rows, self.secret = {}, credentials
        self.asked = 0

    async def load(self):
        return copy.deepcopy(list(self.rows.values()))

    async def save(self, record):
        self.rows[record['key']] = copy.deepcopy(record)

    async def delete(self, key):
        self.rows.pop(key, None)

    async def credentials(self, key):
        self.asked += 1
        return copy.deepcopy(self.secret)


class TotpTests(unittest.TestCase):
    # RFC 6238 appendix B, SHA-1 seed "12345678901234567890" (6-digit truncation).
    SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'

    def test_rfc6238_vectors(self):
        self.assertEqual(autologin.totp(self.SECRET, 59), '287082')
        self.assertEqual(autologin.totp(self.SECRET, 1111111109), '081804')
        self.assertEqual(autologin.totp('gezd gnbv gy3t qojq gezd gnbv gy3t qojq', 59), '287082')

    def test_invalid_secret(self):
        for secret in ['', 'not base32!', 'ABC']:
            with self.subTest(secret=secret), self.assertRaises(ValueError):
                autologin.normalize_totp_secret(secret)

    def test_credentials_bound_to_the_shared_origin(self):
        ok = autologin.valid_credentials({**CREDENTIALS, 'login_url': ORIGIN + '/login'}, ORIGIN)
        self.assertEqual(ok['login_url'], ORIGIN + '/login')
        for raw in [{**CREDENTIALS, 'login_url': 'https://evil.test/login'},
                    {**CREDENTIALS, 'extra': 1}, {'username': 'a'}, {**CREDENTIALS, 'password': ''}]:
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                autologin.valid_credentials(raw, ORIGIN)


class LifetimeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = Store(CREDENTIALS)
        self.patch = patch.object(server, 'store', self.store)
        self.patch.start()
        server.restoration_ready = True
        self.key = 'board:test@site.test'
        self.session = server.Session('alice', ORIGIN, [])
        self.session.shared = True
        self.session.phase = 'ready'
        self.session.saved_url = ORIGIN + '/feed'
        self.session.saved_storage = {'cookies': [], 'origins': []}
        server.sessions[self.key] = self.session

    async def asyncTearDown(self):
        server.sessions.clear()
        self.patch.stop()

    def human(self, operation, **kwargs):
        return server.Command(scope='board:test', operation=operation, controller='alice',
                              session_id=self.session.id, **kwargs)

    def test_default_keeps_idle_limit_and_longer_lifetime_drops_it(self):
        s = self.session
        s.used = time.time() - server.IDLE_SECONDS - 1
        self.assertTrue(s.expired())
        s.lifetime = 7 * 24 * 3600
        self.assertFalse(s.expired())
        s.created = time.time() - s.lifetime - 1
        self.assertTrue(s.expired())

    async def test_set_lifetime_is_human_only_validated_and_persisted(self):
        with self.assertRaises(HTTPException) as denied:
            await server.execute(server.Command(scope='board:test', operation='set_lifetime',
                                                controller='mallory', session_id=self.session.id,
                                                lifetime_hours=24))
        self.assertEqual(denied.exception.status_code, 403)
        with self.assertRaises(HTTPException) as bad:
            await server.execute(self.human('set_lifetime', lifetime_hours=48))
        self.assertEqual(bad.exception.status_code, 400)
        status = await server.execute(self.human('set_lifetime', lifetime_hours=720))
        self.assertEqual(status['lifetimeHours'], 720)
        self.assertEqual(status['expiresAt'], int((self.session.created + 720 * 3600) * 1000))
        self.assertIsNone(self.session.context, 'changing the lifetime must not launch a browser')
        server.sessions.clear()
        await server.restore_sessions()
        self.assertEqual(server.sessions[self.key].lifetime, 720 * 3600)

    async def test_cannot_shorten_below_the_session_age(self):
        self.session.lifetime = 24 * 3600
        self.session.created = time.time() - 10 * 3600
        with self.assertRaises(HTTPException) as error:
            await server.execute(self.human('set_lifetime', lifetime_hours=8))
        self.assertEqual(error.exception.status_code, 409)

    async def test_snapshot_without_new_fields_restores_former_limits(self):
        await server.checkpoint(self.key, self.session)
        for field in ('lifetime', 'keepalive_at', 'relogin_failures', 'relogin_at'):
            self.store.rows[self.key].pop(field)
        server.sessions.clear()
        await server.restore_sessions()
        self.assertEqual(server.sessions[self.key].lifetime, server.SESSION_SECONDS)
        self.store.rows[self.key]['lifetime'] = 99
        server.sessions.clear()
        with self.assertRaises(ValueError):
            await server.restore_sessions()

    def test_keepalive_only_for_extended_unused_shared_sessions(self):
        s = self.session
        now = time.time() + server.KEEPALIVE_SECONDS + server.KEEPALIVE_JITTER_SECONDS + 1
        self.assertFalse(s.keepalive_due(now), 'default lifetime: idle limit, no keepalive')
        s.lifetime = 7 * 24 * 3600
        self.assertTrue(s.keepalive_due(now))
        s.used = now - 60
        self.assertFalse(s.keepalive_due(now), 'recent agent use already renews cookies')
        s.used = s.created
        s.phase = 'login'
        self.assertFalse(s.keepalive_due(now), 'paused sessions are left alone')

    async def test_keepalive_never_counts_as_use(self):
        s = self.session
        used = s.used = time.time() - 3600
        with patch.object(server, 'open_for_maintenance', AsyncMock(return_value=None)), \
                patch.object(server, 'snapshot', AsyncMock(return_value={})):
            await server.keep_alive(s)
        self.assertEqual(s.used, used)
        self.assertGreater(s.keepalive_at, used)

    async def relogin(self, outcome, force=False):
        s = self.session
        s.phase = 'reauth_required'
        s.context = object()  # open browser; sign-in itself is mocked
        page = object()

        async def sign_in(*_):
            if isinstance(outcome, Exception):
                raise outcome
        with patch.object(server, 'sign_in', side_effect=sign_in) as signed, \
                patch.object(s, 'active_page', return_value=page), \
                patch.object(s, 'navigate', AsyncMock(return_value=None)), \
                patch.object(server, 'snapshot', AsyncMock(return_value={})):
            result = await server.relogin_session(self.key, s, force=force)
        return result, signed

    async def test_successful_sign_in_restores_the_session(self):
        ok, signed = await self.relogin(None)
        self.assertTrue(ok)
        self.assertEqual(self.session.phase, 'ready')
        self.assertEqual(self.session.relogin_failures, 0)
        self.assertEqual(signed.call_args.args[1:], (ORIGIN, CREDENTIALS))

    async def test_failures_are_spaced_capped_and_reset_by_the_human(self):
        s = self.session
        ok, _ = await self.relogin(autologin.LoginFailed('rejected'))
        self.assertFalse(ok)
        self.assertEqual((s.phase, s.relogin_failures), ('reauth_required', 1))
        ok, signed = await self.relogin(None)
        self.assertFalse(ok, 'a second attempt waits RELOGIN_RETRY_SECONDS')
        signed.assert_not_called()
        for _ in range(server.RELOGIN_MAX_FAILURES - 1):
            s.relogin_at = 0
            await self.relogin(autologin.LoginFailed('rejected'))
        s.relogin_at = 0
        self.assertFalse(s.relogin_due())
        self.assertTrue(s.status()['autoLoginBlocked'])
        s.context = None
        with patch.object(server, 'relogin_session', AsyncMock()) as forced:
            status = await server.execute(self.human('relogin'))
        forced.assert_awaited_once_with(self.key, s, force=True)
        self.assertFalse(status['autoLoginBlocked'])

    async def test_no_credentials_or_unusable_ones(self):
        self.store.secret = None
        ok, signed = await self.relogin(None)
        self.assertFalse(ok)
        signed.assert_not_called()
        self.assertEqual(self.session.relogin_failures, 0, 'no credentials is not a failed sign-in')
        self.store.secret = {**CREDENTIALS, 'login_url': 'https://evil.test/login'}
        ok, signed = await self.relogin(None, force=True)
        signed.assert_not_called()
        self.assertEqual(self.session.relogin_failures, server.RELOGIN_MAX_FAILURES)

    async def test_agent_command_signs_in_again_before_failing(self):
        s = self.session
        s.phase = 'reauth_required'

        async def repaired(key, session, force=False):
            session.phase = 'ready'
        with patch.object(server, 'relogin_session', side_effect=repaired) as relogin, \
                patch.object(server, 'ensure_open', AsyncMock()), \
                patch.object(s, 'active_page', return_value=object()), \
                patch.object(server, 'snapshot', AsyncMock(return_value={'text': 'feed'})), \
                patch.object(server, 'checkpoint', AsyncMock()):
            result = await server.execute(server.Command(scope='board:test', operation='read'))
        relogin.assert_awaited_once()
        self.assertEqual(result, {'text': 'feed'})


@unittest.skipUnless(os.getenv('BROWSER_E2E') == '1', 'Set BROWSER_E2E=1 for Chromium checks')
class SignInBrowserTests(unittest.IsolatedAsyncioTestCase):
    SECRET = 'JBSWY3DPEHPK3PXP'

    async def asyncSetUp(self):
        from playwright.async_api import async_playwright
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch()
        self.context = await self.browser.new_context()
        self.posts = []
        await self.context.route('**/*', self.fixture)
        self.page = await self.context.new_page()

    async def asyncTearDown(self):
        await self.browser.close()
        await self.pw.stop()

    def html(self, body):
        return {'status': 200, 'content_type': 'text/html', 'body': f'<html><body>{body}</body></html>'}

    async def fixture(self, route):
        request = route.request
        url = request.url
        if not url.startswith(ORIGIN):
            await route.abort()
            return
        path = url.removeprefix(ORIGIN).split('?')[0]
        form = parse_qs(request.post_data or '')
        if request.method == 'POST':
            self.posts.append((path, form))
        field = lambda name: form.get(name, [''])[0]
        if path == '/login':
            await route.fulfill(**self.html(
                '<form method="post" action="/session"><input name="email" type="email">'
                '<input name="password" type="password"><button>Sign in</button></form>'))
        elif path == '/session':
            ok = field('email') == CREDENTIALS['username'] and field('password') == CREDENTIALS['password']
            await route.fulfill(**self.html('<h1>Feed</h1>' if ok else
                                            '<p>Wrong</p><input name="password" type="password">'))
        elif path == '/two-step':
            await route.fulfill(**self.html(
                '<form method="post" action="/two-step/password"><input name="identifier" '
                'autocomplete="username"></form>'))
        elif path == '/two-step/password':
            await route.fulfill(**self.html(
                '<form method="post" action="/checkpoint/otp"><input type="password" name="pw"></form>'))
        elif path == '/checkpoint/otp':
            await route.fulfill(**self.html(
                '<form method="post" action="/checkpoint/done"><input name="code" '
                'autocomplete="one-time-code"></form>'))
        elif path == '/checkpoint/done':
            ok = field('code') == autologin.totp(self.SECRET)
            await route.fulfill(**self.html('<h1>Feed</h1>' if ok else
                                            '<input name="code" autocomplete="one-time-code">'))
        else:
            await route.fulfill(**self.html('<h1>Home</h1>'))

    async def test_single_page_form(self):
        await self.page.goto(ORIGIN + '/login')
        await autologin.sign_in(self.page, ORIGIN, CREDENTIALS, step_seconds=3)
        self.assertEqual(self.posts[-1][0], '/session')

    async def test_wrong_password_is_reported(self):
        await self.page.goto(ORIGIN + '/login')
        with self.assertRaises(autologin.LoginFailed):
            await autologin.sign_in(self.page, ORIGIN, {**CREDENTIALS, 'password': 'nope'}, step_seconds=2)

    async def test_two_step_form_with_totp(self):
        credentials = {**CREDENTIALS, 'login_url': ORIGIN + '/two-step', 'totp_secret': self.SECRET}
        await autologin.sign_in(self.page, ORIGIN, credentials, step_seconds=3)
        paths = [path for path, _ in self.posts]
        self.assertEqual(paths, ['/two-step/password', '/checkpoint/otp', '/checkpoint/done'])
        self.assertEqual(self.posts[1][1]['pw'], [CREDENTIALS['password']])

    async def test_one_time_code_without_secret_fails(self):
        with self.assertRaises(autologin.LoginFailed):
            await autologin.sign_in(self.page, ORIGIN, {**CREDENTIALS, 'login_url': ORIGIN + '/two-step'},
                                    step_seconds=2)


if __name__ == '__main__':
    unittest.main()
