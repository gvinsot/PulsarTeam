"""Real Chromium regressions for a single local-to-server session handoff."""
import asyncio
import base64
import os
import sys
import unittest
import json
import httpx
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
        elif path == '/form':
            body = '''<html><title>Preferences</title><body><main>
              <label><input type="checkbox" checked> Weekly digest</label>
              <label><input type="checkbox"> Marketing emails</label>
              <div role="checkbox" aria-checked="true" aria-label="Custom alerts"></div>
              <label>City <input value="Lyon"></label>
              <input type="password" hidden value="hunter2-secret">
              <p>Echo hunter2-secret</p>
              <x-card></x-card>
              <iframe src="/frame"></iframe>
              <iframe src="https://elsewhere.test/"></iframe>
              <script>customElements.define('x-card', class extends HTMLElement {
                connectedCallback() { this.attachShadow({mode: 'open'}).innerHTML = '<p>Shadow balance 42</p>'; }
              });</script></main></body></html>'''
        elif path == '/editor':
            body = '''<html><body><h1>Video editor</h1>
              <label>Title <input id="title"></label>
              <div role="textbox" aria-label="Description" contenteditable="true"></div>
              <select aria-label="Visibility"><option value="private">Private</option><option value="public">Public</option></select>
              <input id="video" type="file" accept="video/mp4" hidden>
              <input id="secret" type="password" hidden value="do-not-export">
              <button onclick="window.published=(window.published||0)+1; document.querySelector('#result').textContent='Published '+window.published">Publish</button>
              <button onclick="document.body.innerHTML='<input type=password>Sign in'">Expire</button>
              <a href="https://elsewhere.test/">External</a>
              <p id="result">Draft</p><p id="uploaded"></p>
              <script>document.querySelector('#video').onchange=async e=>{
                const f=e.target.files[0]; document.querySelector('#uploaded').textContent=f.name+' '+f.size+' '+await f.text();
              };</script></body></html>'''
        elif path == '/tall':
            body = '<html><title>Statement</title><body style="margin:0"><main style="height:9000px">Long statement</main></body></html>'
        elif path == '/frame':
            body = '<html><body><p>Framed invoice 7</p></body></html>'
        elif path == '/late':
            body = '''<html><title>Late</title><body><nav>Menu</nav><main id="m"></main><script>
              fetch('/api/data').then(r => r.text()).then(t => { document.getElementById('m').innerText = t; });
              </script></body></html>'''
        elif path == '/api/data':
            await asyncio.sleep(1.5)
            await route.fulfill(content_type='text/plain', body='Quarterly revenue table')
            return
        elif request.url.startswith('https://elsewhere.test'):
            body = '<html><body>Third-party widget</body></html>'
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

    async def test_agent_interactions_and_binary_upload(self):
        state = await self.import_page('/editor')
        self.assertTrue(state['canInteract'])
        async def act(operation, by, value, **params):
            return await server.execute(server.Command(scope='board:a', operation=operation,
                target={'by': by, 'value': value, 'name': params.pop('name', '')}, **params))
        await act('agent_fill', 'label', 'Title', text='My video')
        await act('agent_fill', 'role', 'textbox', name='Description', text='A caption')
        await act('agent_select', 'label', 'Visibility', values=['public'])
        page = server.sessions['board:a@site.test'].page
        self.assertEqual(await page.locator('#title').input_value(), 'My video')
        self.assertEqual(await page.locator('[contenteditable]').inner_text(), 'A caption')
        self.assertEqual(await page.locator('select').input_value(), 'public')
        await act('agent_press', 'label', 'Title', text='End')
        read = await server.execute(server.Command(scope='board:a', operation='read'))
        self.assertEqual(read['fileInputs'][0]['selector'], '#video')
        metadata = {'scope': 'board:a', 'operation': 'agent_upload', 'site': ORIGIN, 'session_id': state['sessionId'],
                    'target': {'by': 'css', 'value': '#video'}}
        headers = {'authorization': 'Bearer ' + 'x' * 32,
                   'x-browser-command': base64.b64encode(json.dumps(metadata).encode()).decode(),
                   'x-upload-filename': base64.b64encode('12-vache.mp4'.encode()).decode()}
        with patch.object(server, 'secret', return_value='x' * 32):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=server.app), base_url='http://worker') as client:
                denied = await client.post('/upload', headers={**headers, 'authorization': ''}, content=b'video')
                self.assertEqual(denied.status_code, 403)
                response = await client.post('/upload', headers=headers, content=b'video-bytes')
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()['actionPerformed'])
                self.assertIn('12-vache.mp4 11 video-bytes', response.json()['text'])
                # Browser File objects are read lazily: bytes must still exist
                # after the worker response and before a later Publish click.
                self.assertEqual(await page.locator('#video').evaluate('async el => await el.files[0].text()'), 'video-bytes')
                self.assertEqual(server.staged_bytes, 11)
                with patch.object(server, 'UPLOAD_MAX_BYTES', 2):
                    oversized = await client.post('/upload', headers=headers, content=b'video')
                    self.assertEqual(oversized.status_code, 413)
                invalid = await client.post('/upload', headers={**headers,
                    'x-upload-filename': base64.b64encode(b'../secret').decode()}, content=b'video')
                self.assertEqual(invalid.status_code, 400)
                changed = {**metadata, 'session_id': 'stale-session'}
                response = await client.post('/upload', headers={**headers,
                    'x-browser-command': base64.b64encode(json.dumps(changed).encode()).decode()}, content=b'video')
                self.assertEqual(response.status_code, 409)
        published = await act('agent_click', 'role', 'button', name='Publish')
        self.assertTrue(published['actionPerformed'])
        self.assertIn('Published 1', published['text'])
        # A successful action that lands on login must not be reported as a
        # failed click: an agent must not repeat a possible publication.
        expired = await act('agent_click', 'role', 'button', name='Expire')
        self.assertTrue(expired['actionPerformed'])
        self.assertFalse(expired['pageAvailable'])
        retained_path = server.sessions['board:a@site.test'].uploads[0].path
        await server.execute(server.Command(scope='board:a', operation='disconnect',
            controller='alice', session_id=state['sessionId']))
        self.assertFalse(retained_path.exists())
        self.assertEqual(server.staged_bytes, 0)

    async def test_agent_actions_keep_authorization_and_target_boundaries(self):
        state = await self.import_page('/editor')
        async def click(target, scope='board:a'):
            return await server.execute(server.Command(scope=scope, operation='agent_click', target=target))
        for target in [{'by': 'css', 'value': 'button'}, {'by': 'css', 'value': '#secret'},
                       {'by': 'css', 'value': 'iframe >> internal:control=enter-frame >> button'}]:
            with self.assertRaises(HTTPException):
                await click(target)
        with self.assertRaises(HTTPException):
            await click({'by': 'role', 'value': 'button', 'name': 'Publish'}, 'board:other')
        await server.execute(server.Command(scope='board:a', operation='takeover',
            controller='alice', session_id=state['sessionId']))
        with self.assertRaises(HTTPException):
            await click({'by': 'role', 'value': 'button', 'name': 'Publish'})
        await server.execute(server.Command(scope='board:a', operation='activate',
            controller='alice', session_id=state['sessionId']))
        await click({'by': 'role', 'value': 'link', 'name': 'External'})
        self.assertNotIn('https://elsewhere.test/', [u for u, _ in self.requests])

    async def test_waits_for_render_and_keeps_owned_page_session_and_identity(self):
        status = await self.import_page()
        self.assertEqual(status['phase'], 'ready')
        self.assertEqual(status['pageState'], 'ready')
        self.assertTrue(status['canRead'])
        result = await server.execute(server.Command(scope='board:a', operation='read'))
        self.assertEqual(result['title'], 'Private feed')
        self.assertIn('Chosen identity', result['text'])
        session = server.sessions['board:a@site.test']
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

    async def test_read_shows_form_state_shadow_dom_and_same_site_frames(self):
        await self.import_page('/form')
        page = await server.execute(server.Command(scope='board:a', operation='read'))
        self.assertRegex(page['aria'], r'checkbox "Weekly digest" \[checked\]')
        self.assertNotRegex(page['aria'], r'checkbox "Marketing emails" \[checked\]')
        self.assertRegex(page['aria'], r'checkbox "Custom alerts" \[checked\]')
        self.assertIn('Lyon', page['aria'])
        self.assertIn('Shadow balance 42', page['text'])
        self.assertEqual([f['url'] for f in page['frames']], [ORIGIN + '/frame'])
        self.assertIn('Framed invoice 7', page['frames'][0]['text'])
        self.assertNotIn('Third-party widget', str(page))
        self.assertNotIn('hunter2-secret', str(page))
        self.assertTrue(page['settled'])
        text_only = await server.execute(server.Command(scope='board:a', operation='read', format='text'))
        self.assertNotIn('aria', text_only)

    async def test_read_waits_for_late_content_and_wait_for_text(self):
        await self.import_page('/next')
        # The menu renders at once; the data arrives 1.5 s later through fetch.
        page = await server.execute(server.Command(scope='board:a', operation='navigate', url=ORIGIN + '/late'))
        self.assertIn('Quarterly revenue table', page['text'])
        page = await server.execute(server.Command(scope='board:a', operation='read',
            wait_for='never shown', wait_ms=1500))
        self.assertFalse(page['settled'])
        self.assertEqual(page['waitFor'], {'text': 'never shown', 'found': False})

    async def test_agent_screenshot_is_an_image_of_the_shared_page_only(self):
        await self.import_page('/form')
        shot = await server.execute(server.Command(scope='board:a', operation='screenshot'))
        self.assertEqual(shot['mimeType'], 'image/jpeg')
        self.assertTrue(base64.b64decode(shot['image']).startswith(b'\xff\xd8'))
        self.assertEqual(shot['url'], ORIGIN + '/form')
        full = await server.execute(server.Command(scope='board:a', operation='screenshot', full_page=True))
        self.assertTrue(base64.b64decode(full['image']).startswith(b'\xff\xd8'))
        with self.assertRaises(HTTPException) as error:
            await server.execute(server.Command(scope='board:a', operation='navigate', url=ORIGIN + '/expired'))
        self.assertEqual(error.exception.status_code, 401)
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:a', operation='screenshot'))

    async def test_tall_page_screenshot_is_paginated_and_pdf_renders(self):
        await self.import_page('/tall')
        cmd = dict(scope='board:a', operation='screenshot', full_page=True)
        first = await server.execute(server.Command(**cmd))
        self.assertEqual((first['section'], first['sections'], first['pageHeight']), (1, 3, 9000))
        last = await server.execute(server.Command(**cmd, section=3))
        self.assertEqual(last['section'], 3)
        self.assertTrue(base64.b64decode(last['image']).startswith(b'\xff\xd8'))
        with self.assertRaises(HTTPException) as error:
            await server.execute(server.Command(**cmd, section=4))
        self.assertEqual(error.exception.status_code, 400)
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:a', operation='screenshot', section=2))
        for media in ['screen', 'print']:
            doc = await server.execute(server.Command(scope='board:a', operation='pdf', media=media))
            self.assertTrue(base64.b64decode(doc['pdf']).startswith(b'%PDF'))
            self.assertEqual(doc['title'], 'Statement')
        # Media emulation is restored: later reads see the screen layout again.
        page = server.sessions['board:a@site.test'].active_page()
        self.assertTrue(await page.evaluate("() => matchMedia('screen').matches"))

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
