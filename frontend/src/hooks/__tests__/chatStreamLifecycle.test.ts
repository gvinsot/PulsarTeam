import test from 'node:test';
import assert from 'node:assert/strict';
import { createChatStreamLifecycle } from '../chatStreamLifecycle.js';
import { refreshChatHistory } from '../refreshChatHistory.js';

test('missing end requests a snapshot on idle, without discarding a live response', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const cleared: string[] = [];
  const streams = createChatStreamLifecycle(
    () => requests++,
    id => cleared.push(id)
  );
  t.after(() => streams.dispose());
  streams.start('a');
  streams.status('a', 'idle');
  t.mock.timers.tick(1_000);
  assert.equal(requests, 1);
  assert.deepEqual(cleared, []);
  // The idle snapshot was stale: the server confirms that the turn is active.
  streams.resume(['a']);
  t.mock.timers.tick(3_000);
  assert.deepEqual(cleared, []);
});

test('watchdog reconciles when both end and status are missed, and retries a lost snapshot', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const streams = createChatStreamLifecycle(
    () => requests++,
    () => assert.fail('premature clear')
  );
  t.after(() => streams.dispose());
  streams.start('a');
  t.mock.timers.tick(30_000);
  assert.equal(requests, 1);
  t.mock.timers.tick(30_000);
  assert.equal(requests, 2);
  // The hook replaces its buffers with this authoritative empty stream list.
  streams.resume([]);
  t.mock.timers.tick(60_000);
  assert.equal(requests, 2);
});

test('a previous response cannot clear the next response by timer or agent update', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleared: string[] = [];
  const streams = createChatStreamLifecycle(
    () => {},
    id => cleared.push(id)
  );
  t.after(() => streams.dispose());
  streams.start('a');
  streams.end('a');
  t.mock.timers.tick(2_000);
  streams.start('a');
  streams.updated('a');
  t.mock.timers.tick(1_000);
  assert.deepEqual(cleared, []);
  streams.end('a');
  t.mock.timers.tick(3_000);
  assert.deepEqual(cleared, ['a']);
});

test('end cleanup works with updates before or after end and is isolated per agent', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleared: string[] = [];
  const streams = createChatStreamLifecycle(
    () => {},
    id => cleared.push(id)
  );
  t.after(() => streams.dispose());
  streams.start('a');
  streams.start('b');
  streams.updated('a');
  streams.end('a');
  streams.end('b');
  streams.updated('b');
  assert.deepEqual(cleared, ['b']);
  t.mock.timers.tick(3_000);
  assert.deepEqual(cleared, ['b', 'a']);
});

test('resume and teardown cancel pending cleanup timers', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  const streams = createChatStreamLifecycle(
    () => requests++,
    () => assert.fail('stale cleanup')
  );
  streams.start('a');
  streams.end('a');
  streams.resume(['a']);
  t.mock.timers.tick(3_000);
  streams.end('a');
  streams.start('b');
  streams.dispose();
  t.mock.timers.tick(60_000);
  assert.equal(requests, 0);
});

test('a failed history read retries and applies the complete response', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const applied: string[] = [];
  const errors: unknown[] = [];
  const stop = refreshChatHistory(
    async () => {
      if (++attempts < 3) throw new Error('temporary network failure');
      return 'Complete report';
    },
    result => applied.push(result),
    error => errors.push(error)
  );
  t.after(stop);
  await Promise.resolve();
  t.mock.timers.tick(1_000);
  await Promise.resolve();
  t.mock.timers.tick(2_000);
  await Promise.resolve();
  assert.equal(attempts, 3);
  assert.equal(errors.length, 2);
  assert.deepEqual(applied, ['Complete report']);
  t.mock.timers.tick(30_000);
  assert.equal(attempts, 3);
});

test('changing conversations or starting another turn ignores the old in-flight history', async () => {
  let resolve!: (value: string) => void;
  const pending = new Promise<string>(r => {
    resolve = r;
  });
  const stop = refreshChatHistory(
    () => pending,
    () => assert.fail('stale history applied'),
    () => assert.fail('unexpected error')
  );
  stop();
  resolve('Old conversation');
  await Promise.resolve();
});

test('cancelling history refresh stops scheduled retries', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let attempts = 0;
  const stop = refreshChatHistory(
    async () => {
      attempts++;
      throw new Error('offline');
    },
    () => assert.fail('unexpected success'),
    () => {}
  );
  await Promise.resolve();
  stop();
  t.mock.timers.tick(60_000);
  assert.equal(attempts, 1);
});
