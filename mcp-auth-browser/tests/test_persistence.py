import copy
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import server
from fastapi import HTTPException


class MemoryStore:
    enabled = True

    def __init__(self):
        self.rows = {}

    async def load(self):
        return copy.deepcopy(list(self.rows.values()))

    async def save(self, record):
        self.rows[record['key']] = copy.deepcopy(record)

    async def delete(self, key):
        self.rows.pop(key, None)


class PersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.store = MemoryStore()
        self.patch = patch.object(server, 'store', self.store)
        self.patch.start()
        server.restoration_ready = True
        self.key = 'board:test@site.test'
        self.session = server.Session('alice', 'https://site.test', [])
        self.session.shared = True
        self.session.phase = 'ready'
        self.session.saved_url = 'https://site.test/feed'
        self.session.saved_storage = {'cookies': [], 'origins': []}
        server.sessions[self.key] = self.session

    async def asyncTearDown(self):
        server.sessions.clear()
        server.restoration_ready = True
        self.patch.stop()

    async def test_restore_preserves_identity_timestamps_and_pause_without_launch(self):
        s = self.session
        await server.checkpoint(self.key, s)
        await server.execute(server.Command(scope='board:test', operation='takeover', controller='alice', session_id=s.id))
        server.sessions.clear()
        await server.restore_sessions()
        restored = server.sessions[self.key]
        self.assertEqual((restored.id, restored.created, restored.used), (s.id, s.created, s.used))
        self.assertEqual(restored.phase, 'login')
        self.assertIsNone(restored.context)
        with self.assertRaises(HTTPException):
            await server.execute(server.Command(scope='board:test', operation='read'))
        await server.execute(server.Command(scope='board:test', operation='disconnect', controller='editor', session_id=s.id))
        await server.restore_sessions()
        self.assertFalse(server.sessions)
        self.assertFalse(self.store.rows)

    async def test_expiry_not_extended_and_unshared_login_not_saved(self):
        self.session.used = time.time() - server.IDLE_SECONDS - 1
        await server.checkpoint(self.key, self.session)
        server.sessions.clear()
        await server.restore_sessions()
        self.assertFalse(server.sessions)
        self.assertFalse(self.store.rows)
        self.session.shared = False
        await server.checkpoint(self.key, self.session)
        self.assertFalse(self.store.rows)

    async def test_unavailable_or_corrupt_restore_blocks_account_fallback(self):
        await server.checkpoint(self.key, self.session)
        server.sessions.clear()
        server.restoration_ready = False
        self.store.rows[self.key]['origin'] = 'https://different.test'
        with self.assertRaises(ValueError):
            await server.restore_sessions()
        with self.assertRaises(HTTPException) as caught:
            await server.execute(server.Command(scope='board:test', operation='list'))
        self.assertEqual(caught.exception.status_code, 503)
        self.assertFalse(server.sessions)

    async def test_failed_revocation_keeps_session_reserved(self):
        await server.checkpoint(self.key, self.session)
        with patch.object(self.store, 'delete', AsyncMock(side_effect=RuntimeError('offline'))):
            with self.assertRaises(RuntimeError):
                await server.execute(server.Command(scope='board:test', operation='disconnect',
                    controller='alice', session_id=self.session.id))
        self.assertIs(server.sessions[self.key], self.session)
