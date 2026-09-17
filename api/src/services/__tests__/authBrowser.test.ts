import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Agent } from '../database/agents.js';

const permitted: string[] = [];
mock.module('../../lib/agentAccess.js', {
  namedExports: {
    isInternalServiceSession: (u: { internal?: boolean }) => !!u.internal,
    checkAgentIdAccess: async (id: string) => ({ ok: permitted.includes(id), status: 403 }),
    checkBoardIdAccess: async (id: string) => ({ ok: permitted.includes(id), status: 403 }),
  },
});
const { resolveBrowserScope, browserCommand } = await import('../authBrowser.js');
const { authBrowserRoutes } = await import('../../routes/authBrowser.js');

test('scope resolution never adopts a claimed board or another user session', async () => {
  const getAgent = async () => ({ id: 'a', boardId: 'actual-board' }) as Agent;
  const status = async () => ({ exists: false, connected: false, configured: true });
  assert.deepEqual(await resolveBrowserScope('a', 'claimed-board', { getAgent, status }), {
    type: 'board',
    id: 'actual-board',
  });
  assert.deepEqual(
    await resolveBrowserScope('a', 'claimed-board', {
      getAgent,
      status: async () => ({ exists: true, connected: false, configured: true }),
    }),
    { type: 'agent', id: 'a' }
  );
  await assert.rejects(resolveBrowserScope(null, null, { getAgent, status }));
  await assert.rejects(
    resolveBrowserScope('missing', 'claimed-board', { getAgent: async () => null, status })
  );
});

test('worker payload fixes scope and operation after all params, hides upstream errors', async () => {
  process.env.AUTH_BROWSER_KEY = 'test-browser-key-with-at-least-32-characters';
  let body: any;
  const stub = mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    body = JSON.parse(String(options.body));
    return new Response('{"exists":true}', { status: 200 });
  });
  try {
    await browserCommand({ type: 'agent', id: 'a' }, 'read', {
      scope: 'board:victim',
      operation: 'frame',
    });
    assert.equal(body.scope, 'agent:a');
    assert.equal(body.operation, 'read');
    stub.mock.mockImplementation(async () => new Response('password=do-not-leak', { status: 502 }));
    await assert.rejects(
      browserCommand({ type: 'agent', id: 'a' }, 'read'),
      e => e instanceof Error && !e.message.includes('do-not-leak')
    );
  } finally {
    stub.mock.restore();
  }
});

test('human control rejects service sessions, other scopes, and injected controller', async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      userId: 'alice',
      username: 'alice',
      role: 'admin',
      ...(req.headers['x-service'] ? { internal: true } : {}),
    } as any;
    next();
  });
  app.use(authBrowserRoutes());
  app.use((_err: unknown, _req: unknown, res: express.Response, _next: unknown) =>
    res.status(400).json({ error: 'invalid' })
  );
  const server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/control`;
  try {
    for (const [body, headers, expected] of [
      [{ operation: 'status', agentId: 'victim' }, {}, 403],
      [{ operation: 'status', agentId: 'a' }, { 'x-service': 'yes' }, 403],
      [{ operation: 'frame', agentId: 'a', controller: 'bob' }, {}, 400],
      [{ operation: 'read', agentId: 'a' }, {}, 400],
    ] as const) {
      permitted.push('a');
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      assert.equal(res.status, expected);
    }
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
