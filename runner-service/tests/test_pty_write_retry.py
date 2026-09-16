"""Temporary PTY backpressure must not turn successful delivery into HTTP 503."""
import asyncio
import errno
import logging
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

if os.name == 'nt':
    pytest.skip('PTY tests require POSIX', allow_module_level=True)

import pty
import tty

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import pty_session
from pty_session import PtySession


def session(monkeypatch):
    s = PtySession(agent_id='retry-test', cmd=['aider'], cwd='/tmp', env={})
    s.master_fd = 123
    monkeypatch.setattr(s, 'is_alive', lambda: True)
    monkeypatch.setattr(s, '_schedule_idle_timer', lambda: None)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    return s


@pytest.mark.asyncio
@pytest.mark.parametrize('retry_errno', [errno.EAGAIN, errno.EWOULDBLOCK, errno.EINTR])
async def test_http_success_after_partial_write_and_transient_errors(monkeypatch, caplog, retry_errno):
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    import routes_terminal

    s = session(monkeypatch)
    received = bytearray()
    calls = 0

    def write(fd, data):
        nonlocal calls
        calls += 1
        assert fd == 123
        if calls in (2, 3):
            raise OSError(retry_errno, 'temporarily unavailable')
        chunk = data[:7] if calls == 1 else data
        received.extend(chunk)
        return len(chunk)

    monkeypatch.setattr(os, 'write', write)
    monkeypatch.setattr(routes_terminal, 'API_KEY', 'test-only')
    monkeypatch.setattr(routes_terminal, 'BACKEND', SimpleNamespace(name='aider', supports_interactive_terminal=True))
    monkeypatch.setattr(routes_terminal.pty_session, 'get_session', lambda agent_id: s)
    monkeypatch.setattr(routes_terminal.pty_session, 'get_or_create_session', AsyncMock(return_value=s))
    app = FastAPI()
    app.include_router(routes_terminal.router)
    prompt = 'écriture à reprendre 🛠\n' * 200
    with caplog.at_level(logging.WARNING, logger=pty_session.logger.name):
        async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/terminal/sessions/retry-test/input',
                                         headers={'Authorization': 'Bearer test-only'},
                                         json={'input': prompt})
    assert calls == 4
    assert received == b'\x1b[200~' + prompt.encode() + b'\x1b[201~\r'
    assert response.status_code == 200
    assert response.json()['status'] == 'success'
    assert not [r for r in caplog.records if r.name == pty_session.logger.name and r.levelno >= logging.WARNING]


@pytest.mark.asyncio
async def test_permanent_backpressure_is_bounded_and_logs_only_final_failure(monkeypatch, caplog):
    s = session(monkeypatch)
    monkeypatch.setattr(pty_session, 'INPUT_WRITE_TIMEOUT_SEC', 0.03)
    calls = 0

    def blocked(fd, data):
        nonlocal calls
        calls += 1
        raise BlockingIOError(errno.EAGAIN, 'temporarily unavailable')

    monkeypatch.setattr(os, 'write', blocked)
    with caplog.at_level(logging.WARNING, logger=pty_session.logger.name):
        assert await asyncio.wait_for(s._write_input(b'private prompt'), 1) is False
    assert calls >= 2
    failures = [r.getMessage() for r in caplog.records if 'write to retry-test failed' in r.getMessage()]
    assert len(failures) == 1
    assert 'private prompt' not in failures[0]


@pytest.mark.asyncio
@pytest.mark.parametrize('error', [OSError(errno.EIO, 'closed PTY'), OSError(errno.EBADF, 'bad fd')])
async def test_non_transient_error_is_not_retried(monkeypatch, error):
    s = session(monkeypatch)
    calls = 0

    def failed(fd, data):
        nonlocal calls
        calls += 1
        raise error

    monkeypatch.setattr(os, 'write', failed)
    assert await s._write_input(b'prompt') is False
    assert calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('action', ['stop', 'typing', 'close', 'replace', 'cancel'])
async def test_stalled_paste_cannot_resume_after_interruption(monkeypatch, action):
    s = session(monkeypatch)
    s.cmd = ['codex']
    blocked = asyncio.Event()
    received = bytearray()
    prompt_attempts = 0

    def write(fd, data):
        nonlocal prompt_attempts
        if bytes(data) == b'pending prompt':
            prompt_attempts += 1
            blocked.set()
            raise BlockingIOError(errno.EAGAIN, 'temporarily unavailable')
        received.extend(data)
        return len(data)

    monkeypatch.setattr(os, 'write', write)
    pending = asyncio.create_task(s._write_input(b'pending prompt'))
    await asyncio.wait_for(blocked.wait(), 1)
    if action == 'stop':
        await s.interrupt()
    elif action == 'typing':
        await s.write(b'admin')
    elif action == 'close':
        s._closed = True
    elif action == 'replace':
        s.master_fd = 456
    else:
        pending.cancel()

    if action in ('stop', 'typing'):
        with pytest.raises(InterruptedError):
            await asyncio.wait_for(pending, 1)
        assert received == (b'\x1b' if action == 'stop' else b'admin')
    elif action == 'cancel':
        with pytest.raises(asyncio.CancelledError):
            await pending
    else:
        assert await asyncio.wait_for(pending, 1) is False
    assert prompt_attempts == 1


@pytest.mark.asyncio
async def test_real_nonblocking_pty_recovers_when_reader_drains(monkeypatch, caplog):
    s = session(monkeypatch)
    master, slave = pty.openpty()
    tty.setraw(slave)
    os.set_blocking(master, False)
    os.set_blocking(slave, False)
    s.master_fd = master
    prompt = 'écriture 🛠\n' * 20000
    expected = b'\x1b[200~' + prompt.encode() + b'\x1b[201~\r'
    original_write = os.write
    stalled = asyncio.Event()

    def write(fd, data):
        try:
            return original_write(fd, data)
        except BlockingIOError:
            stalled.set()
            raise

    monkeypatch.setattr(os, 'write', write)
    pending = asyncio.create_task(s.send_input(prompt))
    received = bytearray()

    async def drain():
        while len(received) < len(expected):
            try:
                received.extend(os.read(slave, 4096))
            except BlockingIOError:
                await asyncio.sleep(0.001)

    try:
        with caplog.at_level(logging.WARNING, logger=pty_session.logger.name):
            await asyncio.wait_for(stalled.wait(), 1)
            assert not pending.done(), 'writer failed instead of waiting for the PTY to drain'
            await asyncio.wait_for(drain(), 5)
            await asyncio.wait_for(pending, 1)
        assert received == expected
        assert not [r for r in caplog.records if r.name == pty_session.logger.name and r.levelno >= logging.WARNING]
    finally:
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        os.close(master)
        os.close(slave)
