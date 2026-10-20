// A new OAuth account awaiting admin approval answers the callback with
// 403 { error, code } and no session. These tests pin the two halves the login
// screen relies on: api.ts keeps the body's `code` on the thrown error, and
// accountApprovalNotice turns exactly those two codes (on a 403) into a notice
// — everything else stays an ordinary failure.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { accountApprovalNotice } from '../accountApproval';
import { api } from '../../api';

const realFetch = globalThis.fetch;
const calls: { url: string; init: RequestInit }[] = [];

function answer(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  calls.length = 0;
});

test('maps the two approval codes on a 403 to a notice', () => {
  assert.equal(accountApprovalNotice({ status: 403, code: 'ACCOUNT_PENDING_APPROVAL' }), 'pending');
  assert.equal(accountApprovalNotice({ status: 403, code: 'ACCOUNT_REJECTED' }), 'rejected');
});

test('anything else is an ordinary failure', () => {
  assert.equal(accountApprovalNotice({ status: 403, code: 'FORBIDDEN' }), null);
  assert.equal(accountApprovalNotice({ status: 403 }), null);
  assert.equal(accountApprovalNotice({ status: 401, code: 'ACCOUNT_PENDING_APPROVAL' }), null);
  assert.equal(accountApprovalNotice({ status: 403, code: 'toString' }), null);
  assert.equal(accountApprovalNotice(new Error('Login failed')), null);
  assert.equal(accountApprovalNotice('ACCOUNT_PENDING_APPROVAL'), null);
  assert.equal(accountApprovalNotice(null), null);
});

test('an OAuth callback answering ACCOUNT_PENDING_APPROVAL rejects with status and code', async () => {
  answer(403, {
    error: 'Your account is awaiting administrator approval.',
    code: 'ACCOUNT_PENDING_APPROVAL',
  });
  const err = await api.googleCallback('c', 'https://app/auth/google/callback', 's').then(
    () => assert.fail('expected a rejection'),
    (e: unknown) => e
  );
  assert.equal(accountApprovalNotice(err), 'pending');
  assert.equal((err as Error).message, 'Your account is awaiting administrator approval.');
  assert.match(calls[0].url, /\/api\/auth\/google\/callback$/);
});

test('a password login answering ACCOUNT_REJECTED yields the rejected notice', async () => {
  answer(403, { error: 'Your access request was declined.', code: 'ACCOUNT_REJECTED' });
  const err = await api.login('jane', 'pw').then(
    () => assert.fail('expected a rejection'),
    (e: unknown) => e
  );
  assert.equal(accountApprovalNotice(err), 'rejected');
});

test('an error body without a code carries no code', async () => {
  answer(401, { error: 'Invalid credentials' });
  const err = await api.login('jane', 'bad').then(
    () => assert.fail('expected a rejection'),
    (e: unknown) => e
  );
  assert.equal(accountApprovalNotice(err), null);
  assert.equal('code' in (err as object), false);
  assert.equal((err as { status?: number }).status, 401);
});

test('the admin approval client hits the contract endpoints', async () => {
  answer(200, { count: 2 });
  assert.deepEqual(await api.getPendingUsersCount(), { count: 2 });
  answer(200, { users: [] });
  assert.deepEqual(await api.getPendingUsers(), { users: [] });
  answer(200, { user: { id: 'u1' } });
  await api.approveUser('u1', 'basic');
  await api.approveUser('u2');
  answer(200, { success: true });
  await api.rejectUser('u3');

  assert.deepEqual(
    calls.map(c => [c.init.method || 'GET', c.url, c.init.body ?? null]),
    [
      ['GET', '/api/users/pending/count', null],
      ['GET', '/api/users/pending', null],
      ['POST', '/api/users/u1/approve', JSON.stringify({ role: 'basic' })],
      ['POST', '/api/users/u2/approve', '{}'],
      ['POST', '/api/users/u3/reject', '{}'],
    ]
  );
});
