import test from 'node:test';
import assert from 'node:assert/strict';
import {
  browserSessions,
  credentialsPayload,
  lifetimeChoices,
  pendingTransfer,
  sessionLabel,
} from '../authBrowserSessions';

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

test('a rejected session says whether it signs in again by itself', () => {
  const rejected = { exists: true, connected: false, phase: 'reauth_required' as const };
  assert.match(sessionLabel(rejected), /new session transfer/);
  assert.match(sessionLabel({ ...rejected, autoLogin: true }), /signing in again automatically/);
  assert.match(
    sessionLabel({ ...rejected, autoLogin: true, autoLoginBlocked: true }),
    /Automatic sign-in failed/
  );
});

test('lifetime choices never shorten a session below its age', () => {
  const now = Date.UTC(2026, 10, 27, 12);
  const hour = 3600_000;
  const young = { ...ready, lifetimeHours: 24, expiresAt: now + 23 * hour };
  assert.deepEqual(lifetimeChoices(young, now), [8, 24, 168, 720]);
  const old = { ...ready, lifetimeHours: 168, expiresAt: now + 100 * hour };
  assert.deepEqual(lifetimeChoices(old, now), [168, 720]);
  assert.deepEqual(lifetimeChoices({ ...ready }, now), [8, 24, 168, 720]);
});

test('credentials are checked before sending and bound to the shared website', () => {
  const site = 'https://a.test';
  const form = { username: ' alice ', password: 'pw', totpSecret: '', loginUrl: '' };
  assert.deepEqual(credentialsPayload(form, site), {
    credentials: { username: 'alice', password: 'pw' },
  });
  assert.ok('error' in credentialsPayload({ ...form, password: '' }, site));
  assert.ok('error' in credentialsPayload({ ...form, loginUrl: 'https://evil.test/login' }, site));
  assert.ok('error' in credentialsPayload({ ...form, totpSecret: 'nope' }, site));
  assert.deepEqual(
    credentialsPayload(
      { ...form, totpSecret: 'jbsw y3dp-ehpk 3pxp', loginUrl: 'https://a.test/login' },
      site
    ),
    {
      credentials: {
        username: 'alice',
        password: 'pw',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        loginUrl: 'https://a.test/login',
      },
    }
  );
});
