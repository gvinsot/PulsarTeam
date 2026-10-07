import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ZvecVectorStore } from '../codeSearch/vectorStore.js';

test('native Zvec preserves symbol IDs through upsert, reopen, query and delete', async t => {
  try {
    await import('@zvec/zvec');
  } catch (error) {
    if (error instanceof Error && error.message.includes('Prebuilt binary not found')) {
      t.skip('Native Zvec is unavailable on this platform');
      return;
    }
    throw error;
  }
  const rootDir = await mkdtemp(path.join(os.tmpdir(), 'zvec-test-'));
  const store = await new ZvecVectorStore({ rootDir, dimension: 3 }).init();
  const reopened = new ZvecVectorStore({ rootDir, dimension: 3 });
  t.after(async () => {
    await store.releaseCollection('symbols');
    await reopened.releaseCollection('symbols');
    await rm(rootDir, { recursive: true, force: true });
  });
  const id = 'src/répertoire with spaces/file.ts::Class.method#function';
  await store.upsert('symbols', [
    { id, vector: [1, 0, 0], fields: { kind: 'function', filePath: 'src/file.ts' } },
    { id: 'second', vector: [0, 1, 0] },
  ]);
  assert.equal((await store.query('symbols', [1, 0, 0], 1))[0].id, id);
  await store.upsert('symbols', [{ id, vector: [0, 0, 1] }]);
  const results = await store.query('symbols', [0, 0, 1], 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].id, id);

  await store.releaseCollection('symbols');
  assert.equal((await reopened.query('symbols', [0, 0, 1], 1))[0].id, id);
  await reopened.remove('symbols', [id]);
  assert.deepEqual(
    (await reopened.query('symbols', [0, 0, 1], 5)).map(doc => doc.id),
    ['second']
  );
  await assert.rejects(reopened.upsert('symbols', [{ id: 'invalid', vector: [1] }]), /dimension/i);
  await reopened.resetCollection('symbols');
  assert.deepEqual(await reopened.query('symbols', [1, 0, 0], 5), []);
});

test('Zvec per-document failures are propagated instead of reported as a successful write', async () => {
  const store = new ZvecVectorStore();
  store.collections.set('symbols', {
    upsertSync: () => [{ ok: false, code: 'INVALID_ARGUMENT', message: 'Invalid document' }],
  });
  await assert.rejects(
    store.upsert('symbols', [{ id: 'symbol', vector: [1] }]),
    /ZVEC INVALID_ARGUMENT: Invalid document/
  );
});
