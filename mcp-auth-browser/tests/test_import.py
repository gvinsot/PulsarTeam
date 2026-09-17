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

    async def test_nonce_binds_user_scope_and_site_and_is_single_use(self):
        prepared = await self.prepare()
        base = dict(scope='board:chosen', controller='alice', operation='import',
                    session_id=prepared['sessionId'], storage=STATE)
        for override in [{'scope': 'agent:other'}, {'controller': 'bob'}, {'controller': None},
                         {'session_id': 'stale'}]:
            with self.assertRaises(HTTPException):
                await server.execute(server.Command(**{**base, **override}))
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:chosen', operation='read'))
        opened = []
        async def open_session(s, playwright, url, storage):
            opened.append((url, storage))
            s.active_page = lambda: SimpleNamespace(url=url)
        server.app.state.playwright = object()
        with patch.object(server.Session, 'open', open_session):
            result = await server.execute(server.Command(**base))
        self.assertTrue(result['connected'])
        self.assertEqual(opened[0][0], 'https://www.site.test')
        self.assertEqual(opened[0][1]['cookies'][0]['domain'], 'www.site.test')
        self.assertNotIn('synthetic-secret', str(result))
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(**base))

    async def test_expiry_cancellation_and_failed_import_cannot_replay(self):
        prepared = await self.prepare()
        server.pending_imports['board:chosen']['expires'] = time.time() - 1
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
                    operation='import', session_id=prepared['sessionId'], storage=STATE))
            close.assert_awaited_once()
        self.assertFalse(server.pending_imports)
        self.assertFalse(server.sessions)

    async def test_scope_stays_reserved_during_import_and_revocation_wins(self):
        prepared = await self.prepare()
        entered, finish = asyncio.Event(), asyncio.Event()
        async def open_session(s, *_args):
            entered.set()
            await finish.wait()
            s.active_page = lambda: SimpleNamespace(url=s.origin)
        server.app.state.playwright = object()
        with patch.object(server.Session, 'open', open_session), \
                patch.object(server.Session, 'close', AsyncMock()) as close:
            task = asyncio.create_task(server.execute(server.Command(scope='board:chosen',
                controller='alice', operation='import', session_id=prepared['sessionId'], storage=STATE)))
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
