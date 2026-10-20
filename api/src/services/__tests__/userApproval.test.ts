/**
 * Admin approval of new OAuth accounts.
 *
 * A NEW account created through an OAuth login (Google, Microsoft, GitHub)
 * starts 'pending': the callback answers 403 ACCOUNT_PENDING_APPROVAL with no
 * session cookie, nothing is provisioned, and the admins' badge is told the new
 * count. Only the first user of an empty instance (who becomes admin) and
 * accounts that already existed are let straight in. An admin then approves
 * (role + provisioning) or rejects (row kept, 403 ACCOUNT_REJECTED) through
 * /api/users, and every session path — /login, /verify, impersonation — refuses
 * an account that is not approved.
 *
 * These tests drive the real routers over HTTP against an in-memory users
 * table that mimics the SQL the routes rely on.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

// ── In-memory users table backing the database mock ────────────────────────
type Status = 'approved' | 'pending' | 'rejected';
interface Row {
  id: string;
  username: string;
  password: string | null;
  role: string;
  display_name: string | null;
  google_id: string | null;
  microsoft_id: string | null;
  github_id: string | null;
  avatar_url: string | null;
  terms_accepted_at: Date | null;
  tutorial_completed_at: Date | null;
  approval_status: Status;
  created_at: Date;
}
const rows = new Map<string, Row>();
let clock = Date.parse('2026-10-01T00:00:00Z');

function insert(fields: Partial<Row> & { username: string }): Row {
  const row: Row = {
    id: randomUUID(),
    password: null,
    role: 'advanced',
    display_name: fields.username,
    google_id: null,
    microsoft_id: null,
    github_id: null,
    avatar_url: null,
    terms_accepted_at: null,
    tutorial_completed_at: null,
    approval_status: 'approved', // the column DEFAULT
    created_at: new Date((clock += 1000)),
    ...fields,
  };
  rows.set(row.id, row);
  return row;
}
const byField = (field: keyof Row, value: unknown) =>
  [...rows.values()].find(r => r[field] === value) || null;

const provisioned: string[] = [];

mock.module('../database.js', {
  namedExports: {
    isDatabaseConnected: () => true,
    getAllUsers: async () => [...rows.values()].map(({ password: _p, ...safe }) => safe),
    getUserById: async (id: string) => rows.get(id) || null,
    getUserByUsername: async (u: string) => byField('username', u),
    countUsers: async () => rows.size,
    createUser: async () => ({}),
    updateUser: async () => null,
    deleteUser: async (id: string) => rows.delete(id),
    getUserByGoogleId: async (id: string) => byField('google_id', id),
    createGoogleUser: async (
      googleId: string,
      email: string,
      displayName: string,
      avatarUrl: string | null,
      role: string,
      approvalStatus: Status
    ) =>
      insert({
        username: email,
        display_name: displayName,
        google_id: googleId,
        avatar_url: avatarUrl,
        role,
        approval_status: approvalStatus,
      }),
    linkGoogleId: async (userId: string, googleId: string) => {
      const row = rows.get(userId);
      if (row) row.google_id = googleId;
      return row;
    },
    getUserByMicrosoftId: async () => null,
    createMicrosoftUser: async () => ({}),
    linkMicrosoftId: async () => null,
    getUserByGitHubId: async () => null,
    createGitHubUser: async () => ({}),
    linkGitHubId: async () => null,
    acceptTerms: async () => null,
    completeTutorial: async () => null,
    getPendingApprovalUsers: async () =>
      [...rows.values()]
        .filter(r => r.approval_status === 'pending')
        .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()),
    countPendingApprovalUsers: async () =>
      [...rows.values()].filter(r => r.approval_status === 'pending').length,
    setUserApprovalStatus: async (id: string, from: Status, to: Status, role?: string) => {
      const row = rows.get(id);
      if (!row || row.approval_status !== from) return null;
      row.approval_status = to;
      if (role) row.role = role;
      const { password: _p, ...safe } = row;
      return safe;
    },
  },
});

mock.module('../userProvisioning.js', {
  namedExports: {
    provisionNewUser: async (userId: string) => {
      provisioned.push(userId);
    },
  },
});

mock.module('../../ws/socketHandler.js', {
  namedExports: { getConnectedUserIds: () => new Set<string>() },
});

mock.module('../../secrets.js', {
  namedExports: {
    readSecret: () => 'test-secret-at-least-32-chars-long-xxxxx',
    readSecretOptional: () => undefined,
    invalidateSecret: () => {},
    validateProductionSecrets: () => {},
  },
});

process.env.GOOGLE_CLIENT_ID = 'test-google-client';

const { authRouter } = await import('../../routes/authLogin.js');
const { userRoutes } = await import('../../routes/users.js');
const { authenticateToken, requireRole } = await import('../../middleware/auth.js');
const { signSessionToken } = await import('../../middleware/session.js');

// ── The app under test ──────────────────────────────────────────────────────
const emitted: Array<{ room: string; event: string; data: unknown }> = [];
const io = {
  to: (room: string) => ({
    emit: (event: string, data: unknown) => emitted.push({ room, event, data }),
  }),
};

const app = express();
app.use(express.json());
app.set('io', io);
app.use('/api/auth', authRouter);
app.use('/api/users', authenticateToken, requireRole('admin'), userRoutes());

const server = createServer(app);
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => new Promise<void>(resolve => server.close(() => resolve())));

// Google's endpoints are answered here; everything else (our own server) is real.
const realFetch = globalThis.fetch;
let googleProfile: Record<string, unknown> = {};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'google-access' }), { status: 200 });
  }
  if (url.startsWith('https://www.googleapis.com/oauth2/v2/userinfo')) {
    return new Response(JSON.stringify(googleProfile), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;
test.after(() => {
  globalThis.fetch = realFetch;
});

const REDIRECT_URI = 'http://localhost:5173/auth/google/callback';

/** Run a whole Google login (url → callback) as `profile`. */
async function googleLogin(profile: Record<string, unknown>) {
  googleProfile = { verified_email: true, ...profile };
  const urlRes = await realFetch(
    `${base}/api/auth/google/url?redirect_uri=${encodeURIComponent(REDIRECT_URI)}`
  );
  const { state } = (await urlRes.json()) as { state: string };
  return realFetch(`${base}/api/auth/google/callback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'auth-code', redirect_uri: REDIRECT_URI, state }),
  });
}

function bearer(row: Row) {
  const { token } = signSessionToken({ userId: row.id, username: row.username, role: row.role });
  return { Authorization: `Bearer ${token}` };
}

async function call(method: string, path: string, as: Row, body?: unknown) {
  return realFetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...bearer(as) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const pendingEvents = () => emitted.filter(e => e.event === 'users:pending');

// ── Sign-up ─────────────────────────────────────────────────────────────────

test('the first user of an empty instance is an approved, provisioned admin', async () => {
  const res = await googleLogin({ id: 'g-first', email: 'first@example.com', name: 'First' });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('set-cookie'), 'a session cookie is installed');
  const body = (await res.json()) as Record<string, unknown>;
  // The approved response keeps its exact shape.
  assert.deepEqual(Object.keys(body).sort(), [
    'avatarUrl',
    'csrfToken',
    'displayName',
    'role',
    'termsAcceptedAt',
    'tutorialCompletedAt',
    'userId',
    'username',
  ]);
  const row = byField('google_id', 'g-first')!;
  assert.equal(row.role, 'admin');
  assert.equal(row.approval_status, 'approved');
  assert.deepEqual(provisioned, [row.id]);
  assert.deepEqual(pendingEvents(), []);
});

test('a new OAuth account is created pending: 403, no cookie, no provisioning, admins told', async () => {
  const res = await googleLogin({ id: 'g-new', email: 'new@example.com', name: 'Newcomer' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null, 'no session cookie');
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.code, 'ACCOUNT_PENDING_APPROVAL');
  assert.equal(typeof body.error, 'string');
  assert.equal(body.csrfToken, undefined);
  assert.equal(body.userId, undefined);

  const row = byField('google_id', 'g-new')!;
  assert.equal(row.approval_status, 'pending');
  assert.equal(row.role, 'advanced');
  assert.ok(!provisioned.includes(row.id), 'not provisioned before approval');
  assert.deepEqual(pendingEvents(), [
    { room: 'role:admin', event: 'users:pending', data: { count: 1 } },
  ]);
});

test('a pending account signing in again is still refused, without a new alert', async () => {
  const res = await googleLogin({ id: 'g-new', email: 'new@example.com' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(((await res.json()) as { code: string }).code, 'ACCOUNT_PENDING_APPROVAL');
  assert.equal(pendingEvents().length, 1);
});

test('linking a provider to an existing account is unchanged: it stays approved', async () => {
  const existing = insert({ username: 'existing@example.com', role: 'basic' });
  const res = await googleLogin({ id: 'g-existing', email: 'existing@example.com' });
  assert.equal(res.status, 200);
  assert.ok(res.headers.get('set-cookie'));
  assert.equal(existing.google_id, 'g-existing');
  assert.equal(existing.approval_status, 'approved');
  assert.ok(!provisioned.includes(existing.id));
  assert.equal(pendingEvents().length, 1);
});

// ── Admin endpoints ─────────────────────────────────────────────────────────

const admin = () => byField('google_id', 'g-first')!;
const pendingRow = () => byField('google_id', 'g-new')!;

test('only admins reach the approval endpoints', async () => {
  const notAdmin = byField('username', 'existing@example.com')!;
  for (const [method, path] of [
    ['GET', '/api/users/pending'],
    ['GET', '/api/users/pending/count'],
    ['POST', `/api/users/${pendingRow().id}/approve`],
    ['POST', `/api/users/${pendingRow().id}/reject`],
  ] as const) {
    const res = await call(method, path, notAdmin, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 403, `${method} ${path}`);
  }
  assert.equal(pendingRow().approval_status, 'pending');
});

test('admins list the pending accounts, oldest first, and their count', async () => {
  const res = await call('GET', '/api/users/pending', admin());
  assert.equal(res.status, 200);
  const { users } = (await res.json()) as { users: Array<Record<string, unknown>> };
  assert.equal(users.length, 1);
  assert.deepEqual(Object.keys(users[0]).sort(), [
    'avatarUrl',
    'createdAt',
    'displayName',
    'id',
    'provider',
    'username',
  ]);
  assert.equal(users[0].id, pendingRow().id);
  assert.equal(users[0].username, 'new@example.com');
  assert.equal(users[0].provider, 'google');

  const countRes = await call('GET', '/api/users/pending/count', admin());
  assert.deepEqual(await countRes.json(), { count: 1 });

  const listRes = await call('GET', '/api/users', admin());
  const list = (await listRes.json()) as Array<{ id: string; approval_status: Status }>;
  assert.equal(list.find(u => u.id === pendingRow().id)?.approval_status, 'pending');
});

test('session paths refuse a pending account', async () => {
  const row = pendingRow();

  const verify = await realFetch(`${base}/api/auth/verify`, { headers: bearer(row) });
  assert.equal(verify.status, 403);
  assert.equal(((await verify.json()) as { code: string }).code, 'ACCOUNT_PENDING_APPROVAL');

  const impersonate = await call('POST', `/api/auth/impersonate/${row.id}`, admin());
  assert.equal(impersonate.status, 409);
  assert.equal(impersonate.headers.get('set-cookie'), null);

  // Defense in depth: an admin may have given the account a password.
  row.password = await bcrypt.hash('pending-pass', 4);
  const wrong = await realFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: row.username, password: 'not-it' }),
  });
  assert.equal(wrong.status, 401, 'a wrong password learns nothing about the approval');
  const login = await realFetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: row.username, password: 'pending-pass' }),
  });
  assert.equal(login.status, 403);
  assert.equal(login.headers.get('set-cookie'), null);
  assert.equal(((await login.json()) as { code: string }).code, 'ACCOUNT_PENDING_APPROVAL');
});

test('approve: 404 unknown, sets approved + role, provisions, alerts, then 409', async () => {
  const unknown = await call('POST', `/api/users/${randomUUID()}/approve`, admin(), {});
  assert.equal(unknown.status, 404);

  const bad = await call('POST', `/api/users/${pendingRow().id}/approve`, admin(), {
    role: 'superuser',
  });
  assert.equal(bad.status, 400);

  const before = pendingEvents().length;
  const res = await call('POST', `/api/users/${pendingRow().id}/approve`, admin(), {
    role: 'basic',
  });
  assert.equal(res.status, 200);
  const { user } = (await res.json()) as { user: Record<string, unknown> };
  assert.equal(user.id, pendingRow().id);
  assert.equal(user.approval_status, 'approved');
  assert.equal(user.role, 'basic');
  assert.equal(user.password, undefined);
  assert.ok(provisioned.includes(pendingRow().id), 'provisioned on approval');
  assert.deepEqual(pendingEvents().slice(before), [
    { room: 'role:admin', event: 'users:pending', data: { count: 0 } },
  ]);

  const again = await call('POST', `/api/users/${pendingRow().id}/approve`, admin(), {});
  assert.equal(again.status, 409);

  // Now let in.
  const login = await googleLogin({ id: 'g-new', email: 'new@example.com' });
  assert.equal(login.status, 200);
  assert.ok(login.headers.get('set-cookie'));
  const verify = await realFetch(`${base}/api/auth/verify`, { headers: bearer(pendingRow()) });
  assert.equal(verify.status, 200);
});

test('approve defaults the role to advanced', async () => {
  await googleLogin({ id: 'g-default', email: 'default@example.com' });
  const row = byField('google_id', 'g-default')!;
  const res = await call('POST', `/api/users/${row.id}/approve`, admin(), {});
  assert.equal(res.status, 200);
  assert.equal(row.role, 'advanced');
  assert.equal(row.approval_status, 'approved');
});

test('reject: keeps the row as rejected, alerts, then 409; the identity stays refused', async () => {
  const signup = await googleLogin({ id: 'g-spam', email: 'spam@example.com' });
  assert.equal(signup.status, 403);
  const row = byField('google_id', 'g-spam')!;
  assert.deepEqual(pendingEvents().at(-1)?.data, { count: 1 });

  const unknown = await call('POST', `/api/users/${randomUUID()}/reject`, admin());
  assert.equal(unknown.status, 404);

  const res = await call('POST', `/api/users/${row.id}/reject`, admin());
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { success: true });
  assert.equal(rows.get(row.id)?.approval_status, 'rejected');
  assert.ok(!provisioned.includes(row.id));
  assert.deepEqual(pendingEvents().at(-1), {
    room: 'role:admin',
    event: 'users:pending',
    data: { count: 0 },
  });

  assert.equal((await call('POST', `/api/users/${row.id}/reject`, admin())).status, 409);
  assert.equal((await call('POST', `/api/users/${row.id}/approve`, admin(), {})).status, 409);

  const retry = await googleLogin({ id: 'g-spam', email: 'spam@example.com' });
  assert.equal(retry.status, 403);
  assert.equal(retry.headers.get('set-cookie'), null);
  assert.equal(((await retry.json()) as { code: string }).code, 'ACCOUNT_REJECTED');

  const verify = await realFetch(`${base}/api/auth/verify`, { headers: bearer(row) });
  assert.equal(verify.status, 403);
  assert.equal(((await verify.json()) as { code: string }).code, 'ACCOUNT_REJECTED');
});

test('a board-share invitee is a new person: its adopting login waits for approval', async () => {
  // What createPendingUser leaves behind when a board is shared with an
  // unknown email: no credential, no provisioning, pending.
  const invited = insert({ username: 'invitee@example.com', approval_status: 'pending' });
  const before = pendingEvents().length;

  const res = await googleLogin({ id: 'g-invitee', email: 'invitee@example.com' });
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('set-cookie'), null);
  assert.equal(((await res.json()) as { code: string }).code, 'ACCOUNT_PENDING_APPROVAL');
  assert.equal(invited.google_id, 'g-invitee', 'the login still adopts the placeholder');
  assert.equal(invited.approval_status, 'pending');
  assert.ok(!provisioned.includes(invited.id));
  assert.equal(pendingEvents().length, before, 'adopting it is no new sign-up');

  const approve = await call('POST', `/api/users/${invited.id}/approve`, admin(), {});
  assert.equal(approve.status, 200);
  assert.ok(provisioned.includes(invited.id));
  const after = await googleLogin({ id: 'g-invitee', email: 'invitee@example.com' });
  assert.equal(after.status, 200);
  assert.ok(after.headers.get('set-cookie'));
});

test('the approval alert only ever goes to the admin room, with only a count', () => {
  assert.ok(pendingEvents().length > 0);
  for (const e of emitted) {
    assert.equal(e.room, 'role:admin');
    assert.deepEqual(Object.keys(e.data as object), ['count']);
  }
});
