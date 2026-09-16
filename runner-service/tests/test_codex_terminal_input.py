"""Codex input ownership: residual drafts never cross workflow executions."""
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
from pty_session import (
    PtySession, TerminalInputConflict, _codex_draft, _ready_recipe, screen_is_input_ready,
)

IDLE = '› Ask Codex to do anything\n\n  gpt-6-astra default · /tmp\n'
BUSY = '• Working (11s • esc to interrupt)\n' + IDLE


def session(monkeypatch):
    s = PtySession(agent_id='input-test', cmd=['/usr/bin/codex'], cwd='/tmp', env={})
    monkeypatch.setattr(s, 'is_alive', lambda: True)
    monkeypatch.setattr(s, '_schedule_idle_timer', lambda: None)
    return s


class Composer:
    """Stateful TUI: pastes append, Escape leaves drafts, Enter submits all bytes.

    Unlike scripted frames, a subsequent injection sees the previous draft.
    """
    def __init__(self, s, monkeypatch):
        self.draft = ''
        self.submitted = []
        self.writes = []
        self.enters = 0
        self.consume = True
        self.hidden = False
        self.collapsed = False
        self.after_paste = None
        self.after_enter = None
        self.s = s
        s._tmux_session = 'test-pane'
        monkeypatch.setattr(s, '_tmux_run', self.tmux)
        monkeypatch.setattr(s, '_write_input', self.write)

    def frame(self):
        if not self.draft or self.hidden:
            return IDLE
        body = f'[Pasted Content {len(self.draft)} chars]' if self.collapsed else self.draft
        return '› ' + body.replace('\n', '\n  ') + '\n\n  ? for shortcuts\n'

    async def write(self, data):
        self.writes.append(data)
        if data.startswith(b'\x1b[200~'):
            self.draft += data[6:-6].decode()
            if self.after_paste:
                await self.after_paste()
        elif data != b'\x1b':
            self.draft += data.decode()
        return True

    def tmux(self, args):
        if args[0] == 'capture-pane':
            return CompletedProcess(args, 0, self.frame().encode(), b'')
        assert args == ['send-keys', '-t', 'test-pane', 'Enter']
        self.enters += 1
        if self.consume:
            self.submitted.append(self.draft)
            self.draft = ''
        if self.after_enter:
            self.after_enter()
        return CompletedProcess(args, 0, b'', b'')


@pytest.mark.parametrize('frame,ready', [
    (IDLE, True), (BUSY, False), ('› \n\n  ? for shortcuts\n', True),
    ('› administrator draft\n\n  ? for shortcuts\n', False),
    ('› \n  administrator draft\n\n  ? for shortcuts\n', False),
    ('› Ask Codex to do anything\n  hidden extra line\n\n  ? for shortcuts\n', False),
    ('Do you trust this folder?', False), ('Sign in with ChatGPT', False),
    ('Update available', False), ('? for shortcuts', False),
])
def test_codex_frames(frame, ready):
    assert screen_is_input_ready(frame.lower(), _ready_recipe(['codex'])) is ready


def test_parser_includes_continuation_lines_and_ignores_transcript():
    assert _codex_draft('› history\n' + IDLE) == 'Ask Codex to do anything'
    assert _codex_draft('› first\n  second\n\n  ? for shortcuts\n') == 'first\nsecond'
    assert _codex_draft('› history without a live composer') is None
    assert _codex_draft('› /status\n\n  /status      show current session\n') == '/status'


@pytest.mark.asyncio
async def test_readiness_uses_current_full_pane_not_stale_stream(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
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
    pane = Composer(s, monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=False))
    with pytest.raises(TimeoutError, match='not delivered'):
        await s.send_input('task')
    assert not pane.writes


@pytest.mark.asyncio
async def test_interrupt_cancels_waiting_and_queued_injections_then_allows_clean_resume(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    entered, release = asyncio.Event(), asyncio.Event()
    async def ready(timeout):
        entered.set()
        await release.wait()
        return True
    monkeypatch.setattr(s, 'wait_until_input_ready', ready)
    first = asyncio.create_task(s.send_input('first task'))
    await entered.wait()
    queued = asyncio.create_task(s.send_input('queued task'))
    await asyncio.sleep(0)
    await s.interrupt()
    release.set()
    for pending in (first, queued):
        with pytest.raises(InterruptedError):
            await pending
    assert pane.writes == [b'\x1b']
    await s.send_input('resumed task')
    assert pane.submitted == ['resumed task']


@pytest.mark.asyncio
async def test_stop_after_paste_then_different_task_never_submits_old_bytes(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.after_paste = s.interrupt
    with pytest.raises(InterruptedError):
        await s.send_input('cancelled task')
    assert pane.draft == 'cancelled task'
    pane.after_paste = None
    before = list(pane.writes)
    with pytest.raises(TerminalInputConflict, match='ownership is unresolved'):
        await s.send_input('different task')
    assert pane.writes == before
    assert pane.draft == 'cancelled task'
    assert pane.submitted == []
    assert pane.enters == 0
    # A new terminal has no residual state and can accept the different task.
    fresh = session(monkeypatch)
    fresh_pane = Composer(fresh, monkeypatch)
    await fresh.send_input('different task')
    assert fresh_pane.submitted == ['different task']


@pytest.mark.asyncio
async def test_timeout_with_late_rendered_draft_quarantines_even_an_empty_frame(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.hidden = True
    wait = s._wait_for_codex_paste
    monkeypatch.setattr(s, '_wait_for_codex_paste', lambda text, epoch: wait(text, epoch, timeout=.05))
    with pytest.raises(TimeoutError, match='submit was not sent'):
        await s.send_input('late draft')
    with pytest.raises(TerminalInputConflict):
        await s.send_input('new task before render')
    pane.hidden = False
    with pytest.raises(TerminalInputConflict):
        await s.send_input('new task after render')
    assert pane.draft == 'late draft'
    assert not pane.submitted
    assert len(pane.writes) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize('draft', ['administrator draft', '\nsecond line only', 'Ask Codex to do anything\nextra text'])
async def test_preexisting_admin_draft_is_preserved_without_paste_or_enter(monkeypatch, draft):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.draft = draft
    with pytest.raises(TerminalInputConflict):
        await s.send_input('new task', ready_timeout=.1)
    assert pane.draft == draft
    assert not pane.writes
    assert pane.enters == 0


@pytest.mark.asyncio
async def test_preflight_rechecks_empty_composer_after_readiness(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    async def ready(timeout):
        pane.draft = 'admin arrived after readiness'
        return True
    monkeypatch.setattr(s, 'wait_until_input_ready', ready)
    with pytest.raises(TerminalInputConflict):
        await s.send_input('new task')
    assert pane.draft == 'admin arrived after readiness'
    assert not pane.writes


@pytest.mark.asyncio
async def test_concurrent_administrator_write_invalidates_paste_ownership(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    async def concurrent_input():
        await s.write(b' administrator text')
    pane.after_paste = concurrent_input
    with pytest.raises(InterruptedError):
        await s.send_input('workflow text')
    assert pane.draft == 'workflow text administrator text'
    assert not pane.submitted
    with pytest.raises(TerminalInputConflict):
        await s.send_input('next task')
    assert pane.draft.endswith('administrator text')


@pytest.mark.asyncio
async def test_changed_draft_between_ack_and_enter_is_never_submitted(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    wait = s._wait_for_codex_paste
    async def changed(text, epoch):
        ack = await wait(text, epoch)
        pane.draft = 'unknown replacement'
        return ack
    monkeypatch.setattr(s, '_wait_for_codex_paste', changed)
    with pytest.raises(TerminalInputConflict, match='changed before Enter'):
        await s.send_input('original task')
    assert pane.draft == 'unknown replacement'
    assert pane.enters == 0


@pytest.mark.asyncio
async def test_writer_during_final_capture_cannot_race_enter(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    capture = s._codex_screen
    calls = 0
    async def racing_capture(epoch):
        nonlocal calls
        frame = await capture(epoch)
        calls += 1
        if calls == 3:  # empty check, paste acknowledgement, pre-Enter check
            await s.write(b' concurrent admin edit')
        return frame
    monkeypatch.setattr(s, '_codex_screen', racing_capture)
    with pytest.raises(InterruptedError):
        await s.send_input('task')
    assert pane.enters == 0
    assert pane.draft == 'task concurrent admin edit'


@pytest.mark.asyncio
async def test_unknown_nonempty_paste_ack_is_rejected(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.draft = 'unrelated draft'
    with pytest.raises(TerminalInputConflict, match='does not match'):
        await s._wait_for_codex_paste('expected task', s._input_epoch)


@pytest.mark.asyncio
async def test_paste_ack_ignores_previous_submitted_prompt(monkeypatch):
    s = session(monkeypatch)
    s._tmux_session = 'test-pane'
    frame = ('› previous submitted task\n' + IDLE).encode()
    monkeypatch.setattr(s, '_tmux_run', lambda args: CompletedProcess(args, 0, frame, b''))
    with pytest.raises(TimeoutError, match='submit was not sent'):
        await s._wait_for_codex_paste('expected', s._input_epoch, timeout=.05)


@pytest.mark.asyncio
@pytest.mark.parametrize('collapsed', [False, True])
async def test_clean_resume_and_multiline_paste_ownership(monkeypatch, collapsed):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.collapsed = collapsed
    for text in ['Première tâche 🛠\nligne 2', 'Another task\nlast line']:
        await s.send_input(text)
    assert pane.submitted == ['Première tâche 🛠\nligne 2', 'Another task\nlast line']
    assert not s._codex_input_uncertain


@pytest.mark.asyncio
async def test_unconfirmed_submit_is_quarantined_and_never_repasted(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.consume = False
    with pytest.raises(TimeoutError, match='submission was not confirmed'):
        await s.send_input('original')
    assert pane.enters == 2
    assert len(pane.writes) == 1
    with pytest.raises(TerminalInputConflict):
        await s.send_input('replacement')
    assert pane.draft == 'original'
    assert pane.enters == 2


@pytest.mark.asyncio
async def test_changed_draft_after_enter_is_conflict_not_success_or_retry(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.consume = False
    pane.after_enter = lambda: setattr(pane, 'draft', 'administrator replacement')
    with pytest.raises(TerminalInputConflict, match='not confirmed'):
        await s.send_input('original')
    assert pane.enters == 1
    assert pane.draft == 'administrator replacement'


@pytest.mark.asyncio
async def test_lost_enter_retries_only_the_same_owned_draft(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.consume = False
    pane.after_enter = lambda: setattr(pane, 'consume', True)
    await s.send_input('original')
    assert pane.enters == 2
    assert pane.submitted == ['original']
    assert len(pane.writes) == 1


@pytest.mark.asyncio
async def test_failed_write_quarantines_and_dead_session_is_not_success(monkeypatch):
    s = session(monkeypatch)
    Composer(s, monkeypatch)
    monkeypatch.setattr(s, '_write_input', AsyncMock(return_value=False))
    with pytest.raises(OSError, match='fully written'):
        await s.send_input('task')
    with pytest.raises(TerminalInputConflict):
        await s.send_input('retry')
    monkeypatch.setattr(s, 'is_alive', lambda: False)
    with pytest.raises(OSError, match='closed'):
        await s.send_input('task')


@pytest.mark.asyncio
@pytest.mark.parametrize('options', [{'bracketed_paste': False}, {}])
async def test_codex_requires_observable_composer_and_bracketed_paste(monkeypatch, options):
    s = session(monkeypatch)
    monkeypatch.setattr(s, 'wait_until_input_ready', AsyncMock(return_value=True))
    write = AsyncMock(return_value=True)
    monkeypatch.setattr(s, '_write_input', write)
    with pytest.raises(TerminalInputConflict):
        await s.send_input('task', **options)
    write.assert_not_awaited()


@pytest.mark.asyncio
async def test_short_writes_preserve_multibyte_prompt_and_submit(monkeypatch):
    s = session(monkeypatch)
    s.cmd = ['aider']  # generic transport test, not a simulated Codex composer
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
    s.cmd = ['aider']
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
    (None, 200), (TimeoutError('Input not ready'), 409),
    (InterruptedError('Input interrupted'), 409),
    (TerminalInputConflict('Codex composer contains a draft'), 409),
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
    monkeypatch.setattr(routes_terminal, 'BACKEND', SimpleNamespace(name='codex', supports_interactive_terminal=True))
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
    send.assert_awaited_once()


@pytest.mark.asyncio
async def test_installed_codex_stop_residual_conflict_and_clean_restart(tmp_path, monkeypatch):
    """Isolated tmux/Codex smoke, only /status; never starts a model task."""
    import shutil
    if os.getenv('CODEX_TERMINAL_SMOKE') != '1' or not shutil.which('codex') or not shutil.which('tmux'):
        pytest.skip('set CODEX_TERMINAL_SMOKE=1 to test installed Codex')
    import pty_session
    monkeypatch.setattr(pty_session, '_TMUX_SOCKET', f'codex-draft-smoke-{os.getpid()}')
    def new_session():
        return PtySession(agent_id=f'codex-input-smoke-{os.getpid()}',
                          cmd=['codex', '--dangerously-bypass-approvals-and-sandbox'],
                          cwd=str(tmp_path), env=dict(os.environ))
    s = new_session()
    try:
        await s.start()
        # Cold start and normal reuse must both still submit.
        for _ in range(2):
            await s.send_input('/status', ready_timeout=15)
        # Cancel immediately after confirmed paste, before Enter.
        wait = s._wait_for_codex_paste
        async def stop_after_paste(text, epoch):
            draft = await wait(text, epoch)
            await s.interrupt()
            return draft
        s._wait_for_codex_paste = stop_after_paste
        with pytest.raises(InterruptedError):
            await s.send_input('/status', ready_timeout=10)
        with pytest.raises(TerminalInputConflict):
            await s.send_input('different task must not be pasted', ready_timeout=1)
        frame = await s._codex_screen(s._input_epoch)
        assert _codex_draft(frame) == '/status'
        assert 'different task must not be pasted' not in frame
    finally:
        await s.close()
    # Only the isolated session is restarted; no existing agent is touched.
    s = new_session()
    try:
        await s.start()
        await s.send_input('/status', ready_timeout=15)
        assert not s._codex_input_uncertain
    finally:
        await s.close()


@pytest.mark.asyncio
async def test_cancelled_coroutine_after_paste_cannot_release_ownership(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pasted = asyncio.Event()
    async def pause_after_paste():
        pasted.set()
        await asyncio.Event().wait()
    pane.after_paste = pause_after_paste
    pending = asyncio.create_task(s.send_input('cancelled coroutine draft'))
    await pasted.wait()
    pending.cancel()
    with pytest.raises(asyncio.CancelledError):
        await pending
    with pytest.raises(TerminalInputConflict):
        await s.send_input('next task')
    assert pane.draft == 'cancelled coroutine draft'
    assert pane.enters == 0


@pytest.mark.asyncio
async def test_invisible_administrator_edit_invalidates_collapsed_paste(monkeypatch):
    s = session(monkeypatch)
    pane = Composer(s, monkeypatch)
    pane.collapsed = True
    wait = s._wait_for_codex_paste
    async def replace_same_length(text, epoch):
        draft = await wait(text, epoch)
        await s.write(b'\x7f')
        # Same rendered character count, but different underlying content.
        pane.draft = 'x' * len(text)
        return draft
    monkeypatch.setattr(s, '_wait_for_codex_paste', replace_same_length)
    with pytest.raises(InterruptedError):
        await s.send_input('original text')
    assert not pane.submitted
    assert pane.draft == 'x' * len('original text')
