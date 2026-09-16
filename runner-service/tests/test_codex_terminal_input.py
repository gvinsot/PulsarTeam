"""Regression coverage for IM-HUM-005: Codex readiness and interrupted input.

Frames were captured from Codex 0.154.0 on 2026-09-16. No live model or
credentials are needed; the PTY integration test uses a raw local terminal.
"""
import asyncio
import os
import pty
import sys
import tty
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import AsyncMock

import pytest

if os.name == 'nt':
    pytest.skip('PTY tests require POSIX', allow_module_level=True)

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from pty_session import PtySession, _ready_recipe, screen_is_input_ready

IDLE = '''
› Ask Codex to do anything

  gpt-6-astra default · ~/projects/gvinsot/Intra-Muros
'''
BUSY = '• Working (11s • esc to interrupt)\n' + IDLE


def session(monkeypatch):
    s = PtySession(agent_id='input-test', cmd=['/usr/bin/codex'], cwd='/tmp', env={})
    monkeypatch.setattr(s, 'is_alive', lambda: True)
    monkeypatch.setattr(s, '_schedule_idle_timer', lambda: None)
    return s


@pytest.mark.parametrize('frame,ready', [
    (IDLE, True), (BUSY, False), (''.join(IDLE.split()), True),
    (''.join(BUSY.split()), False), ('Do you trust this folder?', False),
    ('Sign in with ChatGPT', False), ('Update available', False),
])
def test_codex_frames(frame, ready):
    assert screen_is_input_ready(frame.lower(), _ready_recipe(['codex'])) is ready


@pytest.mark.asyncio
async def test_readiness_uses_current_full_pane_not_stale_stream(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    # More than 4096 bytes of empty terminal rows follows the input box.
    frames = iter([BUSY, IDLE + '\n' + (' ' * 120 + '\n') * 40])
    calls = []
    def capture(args):
        calls.append(args)
        return CompletedProcess(args, 0, next(frames).encode(), b'')
    monkeypatch.setattr(s, '_tmux_run', capture)
    assert await s.wait_until_input_ready(timeout=1)
    assert len(calls) == 2
    assert all(c == ['capture-pane', '-p', '-t', 'test-pane'] for c in calls)


@pytest.mark.asyncio
async def test_failed_capture_cannot_reuse_old_ready_bytes(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    s._auto_answer_buf.extend(IDLE.encode())
    monkeypatch.setattr(s, '_tmux_run', lambda args: CompletedProcess(args, 1, b'', b'failed'))
    assert not await s.wait_until_input_ready(timeout=.05)


@pytest.mark.asyncio
async def test_timeout_never_blindly_pastes_codex_task(monkeypatch):
    s = session(monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=False))
    write = AsyncMock(return_value=True)
    monkeypatch.setattr(s, 'write', write)
    with pytest.raises(TimeoutError, match='not delivered'):
        await s.send_input('task')
    write.assert_not_awaited()


@pytest.mark.asyncio
async def test_interrupt_cancels_waiting_and_queued_injections(monkeypatch):
    s = session(monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    async def ready(timeout):
        entered.set()
        await release.wait()
        return True
    monkeypatch.setattr(s, 'wait_until_input_ready', ready)
    write = AsyncMock(return_value=True)
    monkeypatch.setattr(s, 'write', write)
    first = asyncio.create_task(s.send_input('first task'))
    await entered.wait()
    queued = asyncio.create_task(s.send_input('queued task'))
    await asyncio.sleep(0)
    await s.interrupt()
    release.set()
    for pending in (first, queued):
        with pytest.raises(InterruptedError):
            await pending
    assert [call.args[0] for call in write.await_args_list] == [b'\x1b']
    # An explicit resume issued AFTER Stop remains allowed.
    await s.send_input('resumed task')
    assert [call.args[0] for call in write.await_args_list][-2:] == [
        b'\x1b[200~resumed task\x1b[201~', b'\r'
    ]


@pytest.mark.asyncio
async def test_dead_session_and_failed_write_are_not_success(monkeypatch):
    s = session(monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    monkeypatch.setattr(s, 'write', AsyncMock(return_value=False))
    with pytest.raises(OSError, match='fully written'):
        await s.send_input('task')
    monkeypatch.setattr(s, 'is_alive', lambda: False)
    with pytest.raises(OSError, match='closed'):
        await s.send_input('task')


@pytest.mark.asyncio
async def test_short_writes_preserve_multibyte_prompt_and_submit(monkeypatch):
    s = session(monkeypatch)
    s.master_fd = 123
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    received = bytearray()
    def short_write(fd, data):
        assert fd == 123
        chunk = data[:7]
        received.extend(chunk)
        return len(chunk)
    monkeypatch.setattr(os, 'write', short_write)
    prompt = 'Procédure de reprise 🛠\n' * 1000
    await s.send_input(prompt)
    assert received == b'\x1b[200~' + prompt.encode() + b'\x1b[201~\r'


@pytest.mark.asyncio
async def test_real_pty_receives_complete_workflow_input(monkeypatch):
    s = session(monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    master, slave = pty.openpty()
    tty.setraw(slave)
    s.master_fd = master
    expected = b'\x1b[200~' + ('é\n' * 20000).encode() + b'\x1b[201~\r'
    def receive():
        received = bytearray()
        while len(received) < len(expected):
            import select
            assert select.select([slave], [], [], 5)[0], 'incomplete PTY delivery'
            received.extend(os.read(slave, 4096))
        return received
    reader = asyncio.create_task(asyncio.to_thread(receive))
    try:
        await asyncio.sleep(0)
        await s.send_input('é\n' * 20000)
        assert await reader == expected
    finally:
        os.close(master)
        os.close(slave)


@pytest.mark.asyncio
@pytest.mark.parametrize('error,status_code', [
    (None, 200),
    (TimeoutError('Codex input is not ready; prompt was not delivered'), 409),
    (InterruptedError('Terminal input interrupted before delivery'), 409),
    (OSError('Terminal input could not be fully written'), 503),
])
async def test_input_http_response_reports_delivery_failure(monkeypatch, error, status_code):
    from types import SimpleNamespace
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient
    import routes_terminal

    s = session(monkeypatch)
    send = AsyncMock(side_effect=error)
    monkeypatch.setattr(s, 'send_input', send)
    monkeypatch.setattr(routes_terminal, 'API_KEY', 'test-only')
    monkeypatch.setattr(routes_terminal, 'BACKEND', SimpleNamespace(
        name='codex', supports_interactive_terminal=True,
    ))
    monkeypatch.setattr(routes_terminal.pty_session, 'get_session', lambda agent_id: s)
    monkeypatch.setattr(routes_terminal.pty_session, 'get_or_create_session', AsyncMock(return_value=s))
    app = FastAPI()
    app.include_router(routes_terminal.router)
    async with AsyncClient(transport=ASGITransport(app=app), base_url='http://test') as client:
        response = await client.post('/terminal/sessions/input-test/input',
                                     headers={'Authorization': 'Bearer test-only'},
                                     json={'input': 'private task content'})
    assert response.status_code == status_code
    assert 'private task content' not in response.text
    if error is None:
        assert response.json()['status'] == 'success'
    else:
        assert 'success' not in response.text
    send.assert_awaited_once()


@pytest.mark.asyncio
async def test_codex_submit_is_separate_from_paste_burst(monkeypatch):
    import time
    s = session(monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    writes = []
    async def write(data):
        writes.append((data, time.monotonic()))
        return True
    monkeypatch.setattr(s, 'write', write)
    await s.send_input('/status')
    assert [data for data, _ in writes] == [b'\x1b[200~/status\x1b[201~', b'\r']
    assert writes[1][1] - writes[0][1] >= .15


@pytest.mark.asyncio
async def test_stop_after_paste_prevents_enter(monkeypatch):
    s = session(monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    writes = []
    async def write(data):
        writes.append(data)
        if data.startswith(b'\x1b[200~'):
            await s.interrupt()
        return True
    monkeypatch.setattr(s, 'write', write)
    with pytest.raises(InterruptedError):
        await s.send_input('task cancelled during paste')
    assert writes[-1] == b'\x1b'
    assert b'\r' not in writes


@pytest.mark.asyncio
async def test_installed_codex_cold_start_and_resume(tmp_path):
    """Opt-in real tmux/Codex check; /status does not start a model turn."""
    import shutil
    if os.getenv('CODEX_TERMINAL_SMOKE') != '1' or not shutil.which('codex'):
        pytest.skip('set CODEX_TERMINAL_SMOKE=1 to test installed Codex')
    s = PtySession(agent_id=f'codex-input-smoke-{os.getpid()}',
                   cmd=['codex', '--dangerously-bypass-approvals-and-sandbox'],
                   cwd=str(tmp_path), env=dict(os.environ))
    try:
        await s.start()
        for _ in range(2):
            await s.send_input('/status', ready_timeout=10)
            for attempt in range(30):
                await asyncio.sleep(.1)
                pane = await asyncio.to_thread(
                    s._tmux_run, ['capture-pane', '-p', '-t', s._tmux_session]
                )
                frame = pane.stdout.decode('utf-8', errors='replace')
                if 'Session:' in frame and '› /status' not in frame:
                    break
            else:
                pytest.fail('Codex did not submit /status; composer=' + repr([line.strip() for line in frame.splitlines() if line.lstrip().startswith('›')]))
    finally:
        await s.close()


@pytest.mark.asyncio
async def test_codex_waits_for_rendered_draft_before_enter(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    frames = iter([IDLE, IDLE, '› [Pasted Content 60000 chars]\n'])
    captured = []
    def capture(args):
        if args[0] == 'send-keys':
            assert args == ['send-keys', '-t', 'test-pane', 'Enter']
            assert len(captured) == 3
            captured.append('submitted')
            return CompletedProcess(args, 0, b'', b'')
        if captured and captured[-1] == 'submitted':
            return CompletedProcess(args, 0, IDLE.encode(), b'')
        frame = next(frames)
        captured.append(frame)
        return CompletedProcess(args, 0, frame.encode(), b'')
    monkeypatch.setattr(s, '_tmux_run', capture)
    writes = []
    async def write(data):
        if data == b'\r':
            assert len(captured) == 3, 'Enter was sent before paste was rendered'
        writes.append(data)
        return True
    monkeypatch.setattr(s, 'write', write)
    await s.send_input('long task')
    assert captured[-1] == 'submitted'
    assert writes == [b'\x1b[200~long task\x1b[201~']


@pytest.mark.asyncio
async def test_codex_paste_ack_ignores_previous_submitted_prompt(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    # A historical user prompt is not evidence the current paste was accepted.
    frame = ('› previous submitted task\n' + IDLE).encode()
    monkeypatch.setattr(s, '_tmux_run', lambda args: CompletedProcess(args, 0, frame, b''))
    with pytest.raises(TimeoutError, match='submit was not sent'):
        await s._wait_for_codex_paste(s._input_epoch, timeout=.05)


@pytest.mark.asyncio
async def test_tmux_submit_failure_is_reported_without_replaying_prompt(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    monkeypatch.setattr(s, '_wait_for_codex_paste', AsyncMock(return_value='task'))
    write = AsyncMock(return_value=True)
    monkeypatch.setattr(s, 'write', write)
    monkeypatch.setattr(s, '_tmux_run', lambda args: CompletedProcess(args, 1, b'', b'failure'))
    with pytest.raises(OSError, match='submit could not be written'):
        await s.send_input('task')
    write.assert_awaited_once_with(b'\x1b[200~task\x1b[201~')


@pytest.mark.asyncio
async def test_lost_submit_retries_enter_without_repasting(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    submissions = []
    def tmux(args):
        if args[0] == 'send-keys':
            submissions.append(args)
            return CompletedProcess(args, 0, b'', b'')
        frame = '› original draft\n' if len(submissions) == 1 else BUSY
        return CompletedProcess(args, 0, frame.encode(), b'')
    monkeypatch.setattr(s, '_tmux_run', tmux)
    write = AsyncMock()
    monkeypatch.setattr(s, 'write', write)
    await s._submit_codex_paste('original draft', s._input_epoch)
    assert submissions == [['send-keys', '-t', 'test-pane', 'Enter']] * 2
    write.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize('frame', [IDLE, BUSY, '› changed by another writer\n'])
async def test_consumed_or_changed_draft_never_gets_second_enter(monkeypatch, frame):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    submissions = []
    def tmux(args):
        if args[0] == 'send-keys':
            submissions.append(args)
        return CompletedProcess(args, 0, frame.encode(), b'')
    monkeypatch.setattr(s, '_tmux_run', tmux)
    await s._submit_codex_paste('original draft', s._input_epoch)
    assert len(submissions) == 1
