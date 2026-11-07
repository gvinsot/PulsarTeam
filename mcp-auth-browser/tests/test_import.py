import sys
import asyncio
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import server
from fastapi import HTTPException

STATE = {'cookies': [{'name': 'session', 'value': 'synthetic-secret', 'path': '/',
                     'httpOnly': True, 'expires': -1, 'sameSite': 'Lax'}],
         'localStorage': [{'name': 'account', 'value': 'synthetic-account'}]}


class ImportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncTearDown(self):
        server.pending_imports.clear()
        server.sessions.clear()

    async def prepare(self):
        with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
            return await server.execute(server.Command(scope='board:chosen', controller='alice',
                operation='prepare_import', url='https://www.site.test/feed'))

    async def test_linkedin_request_uses_exact_signed_in_origin_before_pairing(self):
        with patch.object(server, 'public_addresses', AsyncMock(return_value=[])) as resolve:
            result = await server.execute(server.Command(scope='agent:linkedin', controller='alice',
                operation='prepare_import', url='https://linkedin.com/'))
        self.assertEqual(result['site'], 'https://www.linkedin.com')
        self.assertEqual(server.pending_imports['agent:linkedin@www.linkedin.com']['origin'], result['site'])
        resolve.assert_awaited_once_with('www.linkedin.com')
        self.assertFalse(server.sessions)
        with self.assertRaises(ValueError):
            await server.execute(server.Command(scope='agent:linkedin', controller='alice',
                operation='import', session_id=result['sessionId'], storage=STATE,
                url='https://linkedin.com/'))

    async def test_other_sites_are_not_rewritten_or_widened(self):
        for i, origin in enumerate(['https://www.linkedin.com', 'https://example.com',
                                    'https://linkedin.com.evil.test', 'https://login.linkedin.com']):
            with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
                result = await server.execute(server.Command(scope=f'agent:site{i}', controller='alice',
                    operation='prepare_import', url=origin))
            self.assertEqual(result['site'], origin)

    async def test_nonce_binds_user_scope_and_site_and_is_single_use(self):
        prepared = await self.prepare()
        base = dict(scope='board:chosen', controller='alice', operation='import',
                    session_id=prepared['sessionId'], storage=STATE, url='https://www.site.test/feed')
        for override in [{'scope': 'agent:other'}, {'controller': 'bob'}, {'controller': None},
                         {'session_id': 'stale'}]:
            with self.assertRaises(HTTPException):
                await server.execute(server.Command(**{**base, **override}))
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:chosen', operation='read'))
        opened = []
        async def open_session(s, playwright, url, storage):
            opened.append((url, storage))
            s.active_page = lambda: SimpleNamespace(url=url, evaluate=AsyncMock(return_value={'text': 'Private feed'}))
        server.app.state.playwright = object()
        with patch.object(server.Session, 'open', open_session):
            result = await server.execute(server.Command(**base))
        self.assertTrue(result['connected'])
        self.assertEqual(opened[0][0], 'https://www.site.test/feed')
        self.assertEqual(opened[0][1]['cookies'][0]['domain'], 'www.site.test')
        self.assertNotIn('synthetic-secret', str(result))
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(**base))

    async def test_expiry_cancellation_and_failed_import_cannot_replay(self):
        prepared = await self.prepare()
        server.pending_imports['board:chosen@www.site.test']['expires'] = time.time() - 1
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:chosen', controller='alice',
                operation='import', session_id=prepared['sessionId'], storage=STATE))
        prepared = await self.prepare()
        await server.execute(server.Command(scope='board:chosen', controller='alice',
            operation='disconnect', session_id=prepared['sessionId']))
        self.assertFalse(server.pending_imports)
        prepared = await self.prepare()
        server.app.state.playwright = object()
        with patch.object(server.Session, 'open', AsyncMock(side_effect=RuntimeError('launch failed'))), \
                patch.object(server.Session, 'close', AsyncMock()) as close:
            with self.assertRaises(RuntimeError):
                await server.execute(server.Command(scope='board:chosen', controller='alice',
                    operation='import', session_id=prepared['sessionId'], storage=STATE, url='https://www.site.test/feed'))
            close.assert_awaited_once()
        self.assertFalse(server.pending_imports)
        self.assertFalse(server.sessions)

    async def test_scope_stays_reserved_during_import_and_revocation_wins(self):
        prepared = await self.prepare()
        entered, finish = asyncio.Event(), asyncio.Event()
        async def open_session(s, *_args):
            entered.set()
            await finish.wait()
            s.active_page = lambda: SimpleNamespace(url=s.origin, evaluate=AsyncMock(return_value={'text': 'Private feed'}))
        server.app.state.playwright = object()
        with patch.object(server.Session, 'open', open_session), \
                patch.object(server.Session, 'close', AsyncMock()) as close:
            task = asyncio.create_task(server.execute(server.Command(scope='board:chosen',
                controller='alice', operation='import', session_id=prepared['sessionId'], storage=STATE, url='https://www.site.test/feed')))
            await entered.wait()
            status = await server.execute(server.Command(scope='board:chosen', operation='status'))
            self.assertTrue(status['exists'])
            self.assertFalse(status['connected'])
            await server.execute(server.Command(scope='board:chosen', controller='alice',
                operation='disconnect', session_id=prepared['sessionId']))
            finish.set()
            with self.assertRaises(HTTPException):
                await task
            close.assert_awaited_once()
        self.assertFalse(server.sessions)

    async def test_one_scope_shares_several_sites_each_with_its_own_session(self):
        server.app.state.playwright = object()

        async def open_session(s, playwright, url, storage):
            s.active_page = lambda: SimpleNamespace(url=url, evaluate=AsyncMock(return_value={'text': 'Private'}))

        async def connect(url, start):
            with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
                pending = await server.execute(server.Command(scope='board:multi', controller='alice',
                    operation='prepare_import', url=url))
            with patch.object(server.Session, 'open', open_session), \
                    patch.object(server, 'read_page', AsyncMock(return_value={'text': 'Private'})):
                return await server.execute(server.Command(scope='board:multi', controller='alice',
                    operation='import', site=pending['site'], session_id=pending['sessionId'],
                    storage=STATE, url=start))

        first = await connect('https://www.site.test/', 'https://www.site.test/feed')
        # Only one transfer may wait at a time: the extension pairs with one request.
        with patch.object(server, 'public_addresses', AsyncMock(return_value=[])):
            waiting = await server.execute(server.Command(scope='board:multi', controller='alice',
                operation='prepare_import', url='https://other.test/'))
            with self.assertRaises(HTTPException) as busy:
                await server.execute(server.Command(scope='board:multi', controller='alice',
                    operation='prepare_import', url='https://third.test/'))
        self.assertEqual(busy.exception.status_code, 409)
        listed = await server.execute(server.Command(scope='board:multi', controller='alice', operation='list'))
        self.assertEqual([(s['site'], s['phase']) for s in listed['sessions']],
                         [('https://other.test', 'pending'), ('https://www.site.test', 'ready')])
        await server.execute(server.Command(scope='board:multi', controller='alice', operation='disconnect',
            site='https://other.test', session_id=waiting['sessionId']))
        second = await connect('https://other.test/', 'https://other.test/inbox')
        self.assertNotEqual(first['sessionId'], second['sessionId'])
        self.assertEqual(set(server.sessions), {'board:multi@www.site.test', 'board:multi@other.test'})

        # Two sites: an agent command must name one, and reaches only that session.
        with self.assertRaises(HTTPException) as ambiguous:
            await server.execute(server.Command(scope='board:multi', operation='read'))
        self.assertEqual(ambiguous.exception.status_code, 409)
        with patch.object(server, 'read_page', AsyncMock(return_value={'text': 'Inbox'})) as read:
            await server.execute(server.Command(scope='board:multi', operation='read', site='https://other.test/x'))
        self.assertEqual(read.await_args.args[1], 'https://other.test')
        with self.assertRaises(HTTPException) as unknown:
            await server.execute(server.Command(scope='board:multi', operation='read', site='https://none.test'))
        self.assertEqual(unknown.exception.status_code, 409)
        # A navigation stays bound to the site whose session it uses.
        with self.assertRaises(HTTPException) as cross:
            await server.execute(server.Command(scope='board:multi', operation='navigate',
                site='https://other.test', url='https://www.site.test/feed'))
        self.assertEqual(cross.exception.status_code, 403)
        # Disconnecting one site leaves the other shared; another scope sees neither.
        with patch.object(server.Session, 'close', AsyncMock()):
            await server.execute(server.Command(scope='board:multi', controller='alice', operation='disconnect',
                site='https://www.site.test', session_id=first['sessionId']))
        self.assertEqual(set(server.sessions), {'board:multi@other.test'})
        self.assertEqual((await server.execute(server.Command(scope='board:multiple', operation='list'))),
                         {'sessions': []})

    def test_storage_rejects_other_origins_domains_ambiguous_and_oversized_data(self):
        for state in [
            {**STATE, 'origins': [{'origin': 'https://other.test'}]},
            {**STATE, 'cookies': [{**STATE['cookies'][0], 'domain': '.site.test'}]},
            {**STATE, 'cookies': STATE['cookies'] * 2},
            {**STATE, 'cookies': [{**STATE['cookies'][0], 'value': 'x' * 8193}]},
            {**STATE, 'cookies': [{**STATE['cookies'][0], 'expires': float('nan')}]},
            {'cookies': [], 'localStorage': []},
        ]:
            with self.subTest(state=list(state)), self.assertRaises(ValueError):
                server.import_storage(state, 'https://www.site.test')
        normalized = server.import_storage(STATE, 'https://www.site.test')
        self.assertTrue(normalized['cookies'][0]['secure'])
        self.assertTrue(normalized['cookies'][0]['httpOnly'])
        self.assertEqual(normalized['origins'][0]['origin'], 'https://www.site.test')
