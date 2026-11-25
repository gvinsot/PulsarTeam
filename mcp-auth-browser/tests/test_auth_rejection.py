import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from page_state import NetworkTracker


class AuthRejectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_explicit_first_party_authentication_errors_expire_session(self):
        page = SimpleNamespace(url='https://www.instagram.com/', on=lambda *args: None)
        def response(url, data, size=None):
            body = json.dumps(data).encode()
            return SimpleNamespace(url=url, request=SimpleNamespace(resource_type='fetch'),
                headers={'content-type': 'application/json', 'content-length': str(len(body) if size is None else size)},
                body=AsyncMock(return_value=body))
        for url, data, size in [
            ('https://evil.test/api', {'message': 'login_required'}, None),
            ('https://i.instagram.com.evil.test/api', {'message': 'login_required'}, None),
            ('https://i.instagram.com/api', {'message': 'upload_failed'}, None),
            ('https://i.instagram.com/api', {'message': 'login_required'}, 999999),
            ('https://i.instagram.com/api', {'message': 'login_required'}, 0),
        ]:
            tracker = NetworkTracker(page)
            r = response(url, data, size)
            await tracker._response(r)
            self.assertFalse(tracker.auth_failure)
            if size is not None:
                r.body.assert_not_awaited()
        for host in ['www.instagram.com', 'i.instagram.com']:
            tracker = NetworkTracker(page)
            await tracker._response(response('https://' + host + '/api', {'message': 'login_required'}))
            self.assertTrue(tracker.auth_failure)
