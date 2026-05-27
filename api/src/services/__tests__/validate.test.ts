import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import { z } from 'zod';
import { validateBody, validateQuery, validateParams } from '../../lib/validate.js';

// Spin up a tiny express server, hit it with `fetch`, and tear it down.
async function withServer(
  configure: (app: express.Express) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  configure(app);
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

test('validateBody rejects invalid payload with 400 and structured details', async () => {
  await withServer(
    app => {
      const schema = z.object({
        username: z.string().min(2).max(50),
        password: z.string().min(4),
      });
      app.post('/login', validateBody(schema), (req, res) => res.json({ ok: true }));
    },
    async baseUrl => {
      const resp = await fetch(`${baseUrl}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'a', password: '1' }),
      });
      assert.equal(resp.status, 400);
      const body = await resp.json() as any;
      assert.equal(body.error, 'Validation failed');
      assert.ok(Array.isArray(body.details));
      assert.ok(body.details.length >= 1);
      // Each detail has a stable shape
      for (const d of body.details) {
        assert.equal(typeof d.path, 'string');
        assert.equal(typeof d.message, 'string');
        assert.equal(typeof d.code, 'string');
      }
    },
  );
});

test('validateBody accepts valid payload and applies coercions', async () => {
  await withServer(
    app => {
      const schema = z.object({
        name: z.string().min(1),
        role: z.enum(['admin', 'user']).default('user'),
      });
      app.post('/u', validateBody(schema), (req, res) => res.json(req.body));
    },
    async baseUrl => {
      const resp = await fetch(`${baseUrl}/u`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'jane' }),
      });
      assert.equal(resp.status, 200);
      const body = await resp.json() as any;
      assert.equal(body.name, 'jane');
      assert.equal(body.role, 'user'); // default applied
    },
  );
});

test('validateBody rejects missing required field with explicit path', async () => {
  await withServer(
    app => {
      const schema = z.object({ email: z.string().email() });
      app.post('/x', validateBody(schema), (req, res) => res.json({ ok: true }));
    },
    async baseUrl => {
      const resp = await fetch(`${baseUrl}/x`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(resp.status, 400);
      const body = await resp.json() as any;
      assert.equal(body.error, 'Validation failed');
      const paths = body.details.map((d: any) => d.path);
      assert.ok(paths.includes('email'));
    },
  );
});

test('express.json body limit rejects oversize payload with 413', async () => {
  const app = express();
  app.use(express.json({ limit: '1kb' }));
  app.post('/big', validateBody(z.object({ s: z.string() })), (_req, res) => res.json({ ok: true }));
  // Swallow body-parser's PayloadTooLargeError so it doesn't print a stack to stderr.
  // The default Express error handler still responds with the correct 413 status.
  app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      res.status(413).json({ error: 'Payload too large' });
      return;
    }
    next(err);
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const big = 'x'.repeat(4096);
    const resp = await fetch(`http://127.0.0.1:${port}/big`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ s: big }),
    });
    // Express's body parser raises a PayloadTooLargeError → 413
    assert.equal(resp.status, 413);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test('validateParams rejects malformed UUID in path with 400', async () => {
  await withServer(
    app => {
      const schema = z.object({ id: z.string().uuid() });
      app.get('/items/:id', validateParams(schema), (req, res) => res.json({ id: req.params.id }));
    },
    async baseUrl => {
      const bad = await fetch(`${baseUrl}/items/not-a-uuid`);
      assert.equal(bad.status, 400);
      const ok = await fetch(`${baseUrl}/items/00000000-0000-4000-8000-000000000000`);
      assert.equal(ok.status, 200);
    },
  );
});

test('validateQuery rejects missing/invalid query and accepts valid', async () => {
  await withServer(
    app => {
      const schema = z.object({ q: z.string().min(1).max(50) });
      app.get('/search', validateQuery(schema), (req, res) => res.json(req.query));
    },
    async baseUrl => {
      const bad = await fetch(`${baseUrl}/search`);
      assert.equal(bad.status, 400);
      const ok = await fetch(`${baseUrl}/search?q=hello`);
      assert.equal(ok.status, 200);
      const body = await ok.json() as any;
      assert.equal(body.q, 'hello');
    },
  );
});

test('validateBody strips fields not declared on the schema (default zod behavior)', async () => {
  await withServer(
    app => {
      const schema = z.object({ name: z.string() });
      app.post('/strip', validateBody(schema), (req, res) => res.json(req.body));
    },
    async baseUrl => {
      const resp = await fetch(`${baseUrl}/strip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ok', extra: 'should-be-stripped' }),
      });
      assert.equal(resp.status, 200);
      const body = await resp.json() as any;
      assert.equal(body.name, 'ok');
      assert.equal(body.extra, undefined);
    },
  );
});
