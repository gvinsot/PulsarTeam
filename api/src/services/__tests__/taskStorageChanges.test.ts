import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { makeTaskDbFake } from './helpers/taskDbFake.js';
import { mergeStorageChange } from '../database/tasks.js';

const realDb = await import('../database.js');
const { rows, exports: taskDbFake } = makeTaskDbFake();
mock.module('../database.js', { namedExports: { ...realDb, ...taskDbFake } });

const { recordTaskStorageChange, joinStoragePath, setStorageChangeNotifier } =
  await import('../taskStorageChanges.js');
const { reserveAgentForTask } = await import('../workflow/agentSelector.js');

const base = { provider: 'onedrive' as const, name: 'a.txt', at: '2026-10-25T00:00:00.000Z' };

test('mergeStorageChange appends new items and folds repeated writes to the same item', () => {
  let list = mergeStorageChange([], { ...base, action: 'created', path: '/a.txt', itemId: 'i1' });
  assert.equal(list.length, 1);
  assert.equal(list[0].count, 1);

  // A rewrite of a file created by the same task stays "created".
  list = mergeStorageChange(list, {
    ...base,
    action: 'updated',
    path: '/a.txt',
    itemId: 'i1',
    webUrl: 'https://x/a',
    at: '2026-10-25T01:00:00.000Z',
  });
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'created');
  assert.equal(list[0].count, 2);
  assert.equal(list[0].webUrl, 'https://x/a');
  assert.equal(list[0].at, '2026-10-25T01:00:00.000Z');

  // A delete without item id matches by path, and wins; the link is kept.
  list = mergeStorageChange(list, { ...base, action: 'deleted', path: '/a.txt', itemId: null });
  assert.equal(list.length, 1);
  assert.equal(list[0].action, 'deleted');
  assert.equal(list[0].itemId, 'i1');

  // Same path on another provider, or another item id, is another item.
  list = mergeStorageChange(list, {
    ...base,
    provider: 'gdrive',
    action: 'created',
    path: '/a.txt',
  });
  list = mergeStorageChange(list, { ...base, action: 'created', path: '/a.txt', itemId: 'i2' });
  assert.equal(list.length, 3);
});

test('joinStoragePath builds absolute Drive paths', () => {
  assert.equal(joinStoragePath(undefined, 'f.txt'), '/f.txt');
  assert.equal(joinStoragePath('/', 'f.txt'), '/f.txt');
  assert.equal(joinStoragePath('/Docs/', 'f.txt'), '/Docs/f.txt');
  assert.equal(joinStoragePath('Docs/Sub', 'f.txt'), '/Docs/Sub/f.txt');
  assert.equal(joinStoragePath(null, 'Docs/f.txt'), '/Docs/f.txt');
});

test('recordTaskStorageChange records on the running task only and notifies', async () => {
  const notified: string[] = [];
  setStorageChangeNotifier(task => notified.push(task.id));
  rows.set('t-run', { id: 't-run', agentId: 'owner', status: 'execute', storageChanges: [] });
  rows.set('t-other', { id: 't-other', agentId: 'owner', status: 'execute', storageChanges: [] });

  const change = {
    provider: 'gdrive' as const,
    action: 'created' as const,
    path: '/r.md',
    name: 'r.md',
  };

  // No agent, or an agent with no live run: nothing is recorded.
  assert.equal(await recordTaskStorageChange(null, change), null);
  assert.equal(await recordTaskStorageChange('agent-1', change), null);
  assert.deepEqual(rows.get('t-run').storageChanges, []);

  const release = reserveAgentForTask('agent-1', 't-run', 'lock-storage-test');
  assert.ok(release);
  try {
    const updated = await recordTaskStorageChange('agent-1', change);
    assert.equal(updated?.id, 't-run');
    const [entry] = rows.get('t-run').storageChanges;
    assert.equal(entry.path, '/r.md');
    assert.equal(entry.agentId, 'agent-1');
    assert.equal(entry.count, 1);
    assert.ok(entry.at);
    assert.deepEqual(rows.get('t-other').storageChanges, []);
    assert.deepEqual(notified, ['t-run']);
  } finally {
    release!();
    setStorageChangeNotifier(null);
  }
});

test('recordTaskStorageChange records nothing when the reserved task no longer exists', async () => {
  const failing = await import('../taskStorageChanges.js');
  const release = reserveAgentForTask('agent-2', 'missing-task', 'lock-storage-test-2');
  try {
    assert.equal(
      await failing.recordTaskStorageChange('agent-2', {
        provider: 'onedrive',
        action: 'deleted',
        path: '/x',
        name: 'x',
      }),
      null
    );
  } finally {
    release!();
  }
});
