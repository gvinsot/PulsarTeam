// The approve / reject flows of the admin "Pending users" tab, run against fake
// API calls: what is sent, what is toasted, and whether the row leaves the list
// ('done' / 'stale') or stays ('failed' / 'cancelled').

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  approvePendingUser,
  pendingUserAvatarSrc,
  pendingUserLabel,
  rejectPendingUser,
  withoutPendingUser,
  type PendingUserActionDeps,
} from '../pendingUsers';
import type { PendingUser, ToastType, UserRole } from '../../../types';

const jane: PendingUser = {
  id: 'u1',
  username: 'jane@hotmail.com',
  displayName: 'Jane Doe',
  avatarUrl: null,
  provider: 'microsoft',
  createdAt: '2026-10-20T08:00:00.000Z',
};

function harness(opts: { fail?: { status?: number; message?: string }; confirm?: boolean } = {}) {
  const sent: { op: string; id: string; role?: UserRole }[] = [];
  const toasts: { message: string; type?: ToastType }[] = [];
  const confirms: string[] = [];
  const maybeFail = () => {
    if (opts.fail) {
      throw Object.assign(new Error(opts.fail.message || 'boom'), { status: opts.fail.status });
    }
  };
  const deps: PendingUserActionDeps = {
    approveUser: async (id, role) => {
      sent.push({ op: 'approve', id, role });
      maybeFail();
    },
    rejectUser: async id => {
      sent.push({ op: 'reject', id });
      maybeFail();
    },
    confirm: message => {
      confirms.push(message);
      return opts.confirm ?? true;
    },
    showToast: (message, type) => toasts.push({ message, type }),
  };
  return { deps, sent, toasts, confirms };
}

test('approve sends the picked role and toasts success', async () => {
  const h = harness();
  assert.equal(await approvePendingUser(h.deps, jane, 'basic'), 'done');
  assert.deepEqual(h.sent, [{ op: 'approve', id: 'u1', role: 'basic' }]);
  assert.deepEqual(h.toasts, [{ message: 'Jane Doe approved as basic', type: 'success' }]);
});

test('approve defaults to the advanced role', async () => {
  const h = harness();
  assert.equal(await approvePendingUser(h.deps, jane), 'done');
  assert.equal(h.sent[0].role, 'advanced');
});

test('a 409 (no longer pending) or 404 is stale, not an error', async () => {
  for (const status of [404, 409]) {
    const h = harness({ fail: { status } });
    assert.equal(await approvePendingUser(h.deps, jane), 'stale');
    assert.equal(h.toasts[0].type, 'info');
  }
});

test('any other failure is toasted as an error and keeps the row', async () => {
  const h = harness({ fail: { status: 500, message: 'Database not connected' } });
  assert.equal(await approvePendingUser(h.deps, jane), 'failed');
  assert.deepEqual(h.toasts, [
    { message: 'Failed to approve Jane Doe: Database not connected', type: 'error' },
  ]);
});

test('reject asks for confirmation and sends nothing when cancelled', async () => {
  const h = harness({ confirm: false });
  assert.equal(await rejectPendingUser(h.deps, jane), 'cancelled');
  assert.equal(h.confirms.length, 1);
  assert.match(h.confirms[0], /Jane Doe/);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.toasts, []);
});

test('reject, confirmed, declines the request', async () => {
  const h = harness();
  assert.equal(await rejectPendingUser(h.deps, jane), 'done');
  assert.deepEqual(h.sent, [{ op: 'reject', id: 'u1' }]);
  assert.equal(h.toasts[0].type, 'success');
});

test('reject of a user another admin already handled is stale', async () => {
  const h = harness({ fail: { status: 409 } });
  assert.equal(await rejectPendingUser(h.deps, jane), 'stale');
});

test('withoutPendingUser drops only the settled row', () => {
  const other = { ...jane, id: 'u2' };
  assert.deepEqual(withoutPendingUser([jane, other], 'u1'), [other]);
});

test('labels fall back to the username', () => {
  assert.equal(pendingUserLabel(jane), 'Jane Doe');
  assert.equal(pendingUserLabel({ ...jane, displayName: null }), 'jane@hotmail.com');
});

test('avatar src keeps https and raster data URIs only', () => {
  assert.equal(
    pendingUserAvatarSrc('https://lh3.googleusercontent.com/a/x'),
    'https://lh3.googleusercontent.com/a/x'
  );
  assert.equal(
    pendingUserAvatarSrc('data:image/png;base64,iVBORw0KGgo='),
    'data:image/png;base64,iVBORw0KGgo='
  );
  assert.equal(pendingUserAvatarSrc('data:image/svg+xml;base64,PHN2Zz4='), null);
  assert.equal(pendingUserAvatarSrc('http://example.com/a.png'), null);
  assert.equal(pendingUserAvatarSrc('javascript:alert(1)'), null);
  assert.equal(pendingUserAvatarSrc(null), null);
});
