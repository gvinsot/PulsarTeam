import test from 'node:test';
import assert from 'node:assert/strict';
import { browserSessions, pendingTransfer, sessionLabel } from '../authBrowserSessions';

const ready = { exists: true, connected: true, phase: 'ready' as const, site: 'https://a.test' };
const paused = { exists: true, connected: false, phase: 'login' as const, site: 'https://b.test' };

test('several websites are listed and a new one can be added while none is pending', () => {
  const sessions = browserSessions([ready, paused]);
  assert.equal(sessions.length, 2);
  assert.deepEqual(pendingTransfer(sessions), { mine: undefined, blocked: false, canAdd: true });
  assert.equal(sessionLabel(ready), 'Session shared on the cluster');
  assert.equal(sessionLabel(paused), 'Agent access paused');
});

test('only one transfer waits at a time: mine is completed here, another user blocks adding', () => {
  const mine = {
    exists: true,
    connected: false,
    phase: 'pending' as const,
    site: 'https://c.test',
    canControl: true,
  };
  assert.deepEqual(pendingTransfer([ready, mine]), { mine, blocked: false, canAdd: false });
  const theirs = { ...mine, canControl: false };
  assert.deepEqual(pendingTransfer([ready, theirs]), {
    mine: undefined,
    blocked: true,
    canAdd: false,
  });
  assert.equal(sessionLabel(theirs), 'Waiting for session transfer');
});

test('a malformed status payload means no website', () => {
  assert.deepEqual(browserSessions(undefined), []);
  assert.deepEqual(browserSessions({ site: 'https://a.test' }), []);
});
