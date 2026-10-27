import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'http';
import {
  assertPatchedRuntime,
  isBrotliPatchedNodeVersion,
  rejectBrotliRequestBodies,
} from '../../lib/runtimeSecurity.js';

test('isBrotliPatchedNodeVersion flags releases vulnerable to CVE-2026-111497', () => {
  for (const v of [
    'v24.22.0',
    'v24.0.0',
    'v22.23.3',
    'v26.12.0',
    'v25.9.0',
    'v23.11.0',
    'v20.19.0',
    'garbage',
  ]) {
    assert.equal(isBrotliPatchedNodeVersion(v), false, v);
  }
  for (const v of [
    'v24.22.1',
    'v24.23.0',
    'v22.23.4',
    'v22.24.0',
    'v26.12.1',
    'v26.13.0',
    'v27.0.0',
    '24.22.1',
  ]) {
    assert.equal(isBrotliPatchedNodeVersion(v), true, v);
  }
});

test('assertPatchedRuntime throws in production only', () => {
  assert.throws(() => assertPatchedRuntime('v24.22.0', true), /CVE-2026-111497/);
  assert.doesNotThrow(() => assertPatchedRuntime('v24.22.1', true));
  const warn = console.warn;
  let warned = false;
  console.warn = () => {
    warned = true;
  };
  try {
    assert.doesNotThrow(() => assertPatchedRuntime('v24.22.0', false));
  } finally {
    console.warn = warn;
  }
  assert.equal(warned, true);
});

test('rejectBrotliRequestBodies answers 415 to br bodies and lets others through', async () => {
  const app = express();
  app.use(rejectBrotliRequestBodies);
  app.use(express.json());
  app.post('/echo', (req, res) => {
    res.json(req.body);
  });
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const post = (encoding?: string) =>
      fetch(`http://127.0.0.1:${port}/echo`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(encoding ? { 'content-encoding': encoding } : {}),
        },
        body: '{"a":1}',
      });
    assert.equal((await post('br')).status, 415);
    assert.equal((await post('gzip, BR')).status, 415);
    const ok = await post();
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { a: 1 });
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
