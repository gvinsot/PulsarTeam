// Configurable lifetime and automatic sign-in of Authenticated Browser sessions:
// credential storage (encrypted, controller-only, origin-bound, never echoed),
// the worker-only read-back route, and revocation on disconnect.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { SessionClaims } from '../../middleware/session.js';

process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.AUTH_BROWSER_KEY = randomBytes(32).toString('hex');
process.env.APP_ENVIRONMENT = 'prod';

const tables = {
  auth_browser_sessions: new Map<string, string>(),
  auth_browser_credentials: new Map<string, string>(),
};
const tableOf = (sql: string) =>
  sql.includes('auth_browser_credentials')
    ? tables.auth_browser_credentials
    : tables.auth_browser_sessions;
// Keep the real exports (database.js imports more than getPool); fake the pool.
const realConnection = await import('../database/connection.js');
mock.module('../database/connection.js', {
  namedExports: {
    ...realConnection,
    getPool: () => ({
      query: async (sql: string, args: unknown[]) => {
        const rows = tableOf(sql);
        const env = String(args[0]);
        if (sql.startsWith('INSERT')) rows.set(`${env}/${args[1]}`, String(args[2]));
        if (sql.startsWith('DELETE')) rows.delete(`${env}/${args[1]}`);
        if (!sql.startsWith('SELECT')) return { rows: [] };
        const wanted = Array.isArray(args[1]) ? (args[1] as string[]) : [String(args[1])];
        return {
          rows: wanted
            .filter(key => rows.has(`${env}/${key}`))
            .map(key => ({ session_key: key, ciphertext: rows.get(`${env}/${key}`) })),
        };
      },
    }),
  },
});
const permitted = ['board-1'];
mock.module('../../lib/agentAccess.js', {
  namedExports: {
    isInternalServiceSession: (u: { internal?: boolean }) => !!u.internal,
    checkAgentIdAccess: async (id: string) => ({ ok: permitted.includes(id), status: 403 }),
    checkBoardIdAccess: async (id: string) => ({ ok: permitted.includes(id), status: 403 }),
  },
});
const { authBrowserRoutes } = await import('../../routes/authBrowser.js');
const { authBrowserSessionRoutes } = await import('../../routes/authBrowserSessions.js');
const { deleteBrowserSession } = await import('../database/authBrowserSessions.js');

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const STALE_ID = '22222222-2222-4222-8222-222222222222';
const KEY = 'prod/board:board-1@site.test';
const PASSWORD = 'synthetic-password-value';

async function listen(router: express.Router, user?: string) {
  const app = express();
  app.use(express.json());
  if (user) {
    app.use((req, _res, next) => {
      req.user = { userId: user, username: user, role: 'user' } as SessionClaims;
      next();
    });
  }
  app.use(router);
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

/** Stub the worker: `list` reports one session the given user controls. */
function stubWorker(controller: string) {
  const request = globalThis.fetch;
  const forwarded: Record<string, unknown>[] = [];
  const stub = mock.method(globalThis, 'fetch', async (url: unknown, options: RequestInit) => {
    if (String(url).startsWith('http://127.0.0.1')) return request(String(url), options);
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    forwarded.push(body);
    const session = {
      exists: true,
      connected: true,
      phase: 'ready',
      site: 'https://site.test',
      sessionId: SESSION_ID,
      canControl: body.controller === controller,
    };
    return new Response(
      JSON.stringify(body.operation === 'list' ? { sessions: [session] } : session),
      { status: 200 }
    );
  });
  return { forwarded, restore: () => stub.mock.restore() };
}

const post = (base: string, path: string, body: object, headers: Record<string, string> = {}) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const setCredentials = (base: string, credentials: object, sessionId = SESSION_ID) =>
  post(base, '/control', {
    boardId: 'board-1',
    operation: 'set_credentials',
    site: 'https://site.test',
    sessionId,
    credentials,
  });

test('only the controller stores credentials, encrypted, origin-bound and never echoed', async () => {
  const worker = stubWorker('alice');
  const mallory = await listen(authBrowserRoutes(), 'mallory');
  const alice = await listen(authBrowserRoutes(), 'alice');
  try {
    let res = await setCredentials(mallory.base, { username: 'a', password: PASSWORD });
    assert.equal(res.status, 403);
    res = await setCredentials(alice.base, { username: 'a', password: PASSWORD }, STALE_ID);
    assert.equal(res.status, 403, 'a stale session id is refused');
    for (const bad of [
      { username: 'a', password: PASSWORD, loginUrl: 'https://evil.test/login' },
      { username: 'a', password: PASSWORD, totpSecret: 'not base32!' },
      { username: '', password: PASSWORD },
    ]) {
      res = await setCredentials(alice.base, bad);
      assert.equal(res.status, 400);
      assert.ok(!(await res.text()).includes(PASSWORD), 'validation never echoes credentials');
    }
    assert.equal(tables.auth_browser_credentials.size, 0);

    res = await setCredentials(alice.base, {
      username: 'alice@example.com',
      password: PASSWORD,
      totpSecret: 'jbsw y3dp ehpk 3pxp',
      loginUrl: 'https://site.test/login',
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(PASSWORD));
    assert.equal(JSON.parse(text).autoLogin, true);
    const ciphertext = tables.auth_browser_credentials.get(KEY) || '';
    assert.ok(ciphertext && !ciphertext.includes(PASSWORD), 'stored encrypted');
    const relogin = worker.forwarded.at(-1);
    assert.equal(relogin?.operation, 'relogin');
    assert.equal(relogin?.controller, 'alice');
    assert.ok(!JSON.stringify(worker.forwarded).includes(PASSWORD), 'never sent in a command');

    const status = await (
      await post(alice.base, '/control', { boardId: 'board-1', operation: 'status' })
    ).json();
    assert.equal(status.sessions[0].autoLogin, true);

    res = await post(alice.base, '/control', {
      boardId: 'board-1',
      operation: 'disconnect',
      site: 'https://site.test',
      sessionId: SESSION_ID,
    });
    assert.equal(res.status, 200);
    assert.equal(tables.auth_browser_credentials.size, 0, 'disconnect revokes credentials');
  } finally {
    worker.restore();
    await mallory.close();
    await alice.close();
  }
});

test('lifetime is forwarded in worker field names and validated', async () => {
  const worker = stubWorker('alice');
  const alice = await listen(authBrowserRoutes(), 'alice');
  try {
    const body = { boardId: 'board-1', site: 'https://site.test', sessionId: SESSION_ID };
    let res = await post(alice.base, '/control', {
      ...body,
      operation: 'set_lifetime',
      lifetimeHours: 48,
    });
    assert.equal(res.status, 400);
    res = await post(alice.base, '/control', { ...body, operation: 'set_lifetime' });
    assert.equal(res.status, 400);
    res = await post(alice.base, '/control', {
      ...body,
      operation: 'set_lifetime',
      lifetimeHours: 720,
    });
    assert.equal(res.status, 200);
    const forwarded = worker.forwarded.at(-1);
    assert.equal(forwarded?.lifetime_hours, 720);
    assert.equal(forwarded?.controller, 'alice');
    assert.ok(!('lifetimeHours' in (forwarded || {})), 'the worker forbids unknown fields');
  } finally {
    worker.restore();
    await alice.close();
  }
});

test('worker read-back requires the worker key; expiry deletes credentials with the session', async () => {
  const worker = stubWorker('alice');
  const alice = await listen(authBrowserRoutes(), 'alice');
  const internal = await listen(authBrowserSessionRoutes());
  try {
    await setCredentials(alice.base, { username: 'alice', password: PASSWORD });
    const body = { key: 'board:board-1@site.test' };
    for (const authorization of ['', 'Bearer user-jwt']) {
      const res = await post(internal.base, '/credentials', body, { authorization });
      assert.equal(res.status, 403);
    }
    const auth = { authorization: `Bearer ${process.env.AUTH_BROWSER_KEY}` };
    let res = await post(internal.base, '/credentials', body, auth);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await res.json()).credentials, { username: 'alice', password: PASSWORD });
    res = await post(internal.base, '/credentials', { key: 'board:other@site.test' }, auth);
    assert.equal((await res.json()).credentials, null);
    await deleteBrowserSession('prod', body.key);
    res = await post(internal.base, '/credentials', body, auth);
    assert.equal((await res.json()).credentials, null);
  } finally {
    worker.restore();
    await alice.close();
    await internal.close();
  }
});
