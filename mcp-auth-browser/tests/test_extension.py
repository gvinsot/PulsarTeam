"""Real MV3 extension -> app tab -> worker -> Chromium, with synthetic credentials.

The fixture manifest pre-grants the two test origins: OS permission prompts and
store installation remain manual. No real account, remote cluster or site used.
"""
import json
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import server
from playwright.async_api import async_playwright


@unittest.skipUnless(os.environ.get('BROWSER_E2E') == '1', 'Set BROWSER_E2E=1')
class ExtensionTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_httponly_cookie_transfers_to_cluster_and_not_other_hosts(self):
        root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory() as tmp:
            extension = Path(tmp) / 'extension'
            shutil.copytree(root / 'frontend/browser-session-extension', extension)
            manifest_path = extension / 'manifest.json'
            manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
            manifest['permissions'].append('cookies')
            manifest['optional_permissions'] = []
            manifest['host_permissions'] = ['https://app.test/*', 'https://www.site.test/*', 'https://site.test/*']
            manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
            with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
                state = await server.execute(server.Command(scope='board:extension',
                    controller='alice', operation='prepare_import', url='https://www.site.test'))
            request = dict(version=1, requestId=state['sessionId'], scope='board:extension',
                           site=state['site'], expiresAt=state['expiresAt'])
            async with async_playwright() as pw:
                async def launch(**kwargs):
                    browser = await pw.chromium.launch(**kwargs)
                    async def new_context(**options):
                        context = await browser.new_context(**options)
                        async def remote_site(route):
                            headers = await route.request.all_headers()
                            if 'sid=synthetic-httponly' not in headers.get('cookie', ''):
                                return await route.fulfill(body='<h1>Login required</h1>')
                            if route.request.url == 'https://www.site.test/':
                                return await route.fulfill(content_type='text/html', body='<input type="password">Sign in with Google')
                            await route.fulfill(content_type='text/html', body='<h1>Private feed</h1>')
                        await context.route('**/*', remote_site)
                        return context
                    return SimpleNamespace(new_context=new_context, close=browser.close)
                server.app.state.playwright = SimpleNamespace(chromium=SimpleNamespace(launch=launch))
                context = await pw.chromium.launch_persistent_context(str(Path(tmp) / 'profile'),
                    channel='chromium', headless=True,
                    args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}'])
                try:
                    worker = context.service_workers[0] if context.service_workers else await context.wait_for_event('serviceworker')
                    extension_origin = worker.url.rsplit('/', 1)[0]
                    html = '''<div id="bridge"></div><script>
                    const node = document.getElementById('bridge');
                    node.setAttribute('data-pulsar-browser-request', JSON.stringify(REQUEST));
                    node.addEventListener('pulsar:browser-import', async event => {
                      const response = await fetch('/api/auth-browser/control', {method: 'POST',
                        headers: {'Content-Type': 'application/json'},
                        body: JSON.stringify({operation:'import', boardId:'extension',
                          sessionId:event.detail.requestId, storage:event.detail.storage, url:event.detail.url})});
                      node.dataset.result = response.ok ? 'success' : 'error';
                    });</script>'''.replace('REQUEST', json.dumps(request))
                    async def app_route(route):
                        if route.request.url.endswith('/control'):
                            data = route.request.post_data_json
                            self.assertEqual(data['boardId'], 'extension')
                            self.assertEqual(len(data['storage']['cookies']), 1)
                            result = await server.execute(server.Command(scope='board:extension',
                                controller='alice', operation=data['operation'],
                                session_id=data['sessionId'], storage=data['storage'], url=data['url']))
                            await route.fulfill(json=result)
                        else:
                            await route.fulfill(content_type='text/html', body=html)
                    await context.route('https://app.test/**', app_route)
                    async def source_route(route):
                        if route.request.url.endswith('/signed-in'):
                            await route.fulfill(content_type='text/html', headers={
                                'Set-Cookie': 'sid=synthetic-httponly; Path=/; Domain=site.test; Secure; HttpOnly; SameSite=Lax'
                            }, body='<h1>Signed in as test account</h1><script>localStorage.setItem("auth", "synthetic-storage")</script>')
                        else:
                            await route.fulfill(content_type='text/html', body='<a href="/signed-in">Connecter</a>')
                    await context.route('https://www.site.test/**', source_route)
                    app = await context.new_page()
                    await app.goto('https://app.test/')
                    popup = await context.new_page()
                    await popup.goto(extension_origin + '/popup.html')
                    app_tab = await worker.evaluate('async () => (await chrome.tabs.query({url:"https://app.test/*"}))[0].id')
                    async def send(message):
                        return await popup.evaluate('(message) => chrome.runtime.sendMessage(message)', message)
                    inspected = await send(dict(type='inspect', tabId=app_tab))
                    self.assertEqual(inspected['result']['mode'], 'start')
                    pair = inspected['result']['pair']
                    async with context.expect_page() as opened:
                        self.assertEqual(await send(dict(type='begin', pair=pair, grantedOrigins=[], grantedCookies=False)), {'result': {'ok': True}})
                    stored = await worker.evaluate('async () => (await chrome.storage.session.get("pair")).pair')
                    source = await opened.value
                    await source.wait_for_url('https://www.site.test/')
                    await source.get_by_text('Connecter', exact=True).click()
                    await source.get_by_role('heading').wait_for()
                    # Domain and host can both carry the same cookie name.
                    # Reject a conflicting session with a safe reason,
                    # then merge strictly identical copies in the real MV3 path.
                    host_cookie = dict(name='sid', value='synthetic-other-session',
                                       domain='www.site.test', path='/',
                                       httpOnly=True, secure=True, sameSite='Lax')
                    await context.add_cookies([host_cookie])
                    self.assertEqual(len(await context.cookies('https://www.site.test')), 2)
                    refused = await send(dict(type='transfer', tabId=stored['sourceTabId']))
                    self.assertEqual(refused['code'], 'AMBIGUOUS_COOKIES')
                    self.assertNotIn('synthetic-', str(refused))
                    self.assertNotIn('board:extension', server.sessions)
                    await context.add_cookies([{**host_cookie, 'value': 'synthetic-httponly'}])
                    cookie_count = await worker.evaluate('async () => (await chrome.cookies.getAll({url:"https://www.site.test/"})).length')
                    self.assertEqual(cookie_count, 2, 'Extension must read both parent and selected host cookies')
                    self.assertNotIn('synthetic-httponly', await source.evaluate('document.cookie'))
                    transferred = await send(dict(type='transfer', tabId=stored['sourceTabId'], includeLocalStorage=True))
                    self.assertEqual(transferred, {'result': {'ok': True}})
                    remote = server.sessions['board:extension']
                    self.assertEqual(remote.page.url, 'https://www.site.test/signed-in')
                    self.assertEqual(source.url, 'https://www.site.test/signed-in')
                    read = await server.execute(server.Command(scope='board:extension', operation='read'))
                    self.assertIn('Private feed', read['text'])
                    self.assertNotIn('synthetic-', str(read))
                    self.assertEqual(await remote.page.evaluate('localStorage.getItem("auth")'), 'synthetic-storage')
                    self.assertEqual(await remote.context.cookies('https://sibling.site.test'), [])
                    self.assertEqual(await worker.evaluate('() => chrome.storage.session.get(null)'), {})
                    self.assertIn('error', await send(dict(type='transfer', tabId=stored['sourceTabId'])))
                    # The extension and both local tabs are now gone. Reading and
                    # navigation must keep working in the same remote session.
                    await context.close()
                    status = await server.execute(server.Command(scope='board:extension', operation='status'))
                    self.assertFalse(status['canControl'])
                    self.assertTrue(status['canRead'])
                    self.assertEqual(status['browserLocation'], 'server')
                    sid = status['sessionId']
                    for path in ['next', 'another']:
                        read = await server.execute(server.Command(scope='board:extension', operation='navigate',
                            url=f'https://www.site.test/{path}'))
                        self.assertIn('Private feed', read['text'])
                        self.assertEqual(server.sessions['board:extension'].id, sid)
                    await server.execute(server.Command(scope='board:extension', controller='alice',
                        session_id=remote.id, operation='takeover'))
                    with self.assertRaises(server.HTTPException):
                        await server.execute(server.Command(scope='board:extension', operation='read'))
                finally:
                    await context.close()
                    for s in list(server.sessions.values()):
                        await s.close()
                    server.sessions.clear()
                    server.pending_imports.clear()
