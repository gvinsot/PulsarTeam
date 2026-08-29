import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter } from '../rateLimiter.js';

test('requests within limit execute immediately', async () => {
  const limiter = new RateLimiter(5, 'test1');
  const results: number[] = [];
  const start = Date.now();

  const promises = Array.from({ length: 5 }, (_, i) =>
    limiter.schedule(async () => {
      results.push(i);
      return i;
    })
  );

  await Promise.all(promises);
  const elapsed = Date.now() - start;

  assert.equal(results.length, 5);
  assert.ok(elapsed < 1000, `Expected < 1000ms, took ${elapsed}ms`);
});

test('tracks requests in the sliding window', async () => {
  const limiter = new RateLimiter(3, 'test2');

  for (let i = 0; i < 3; i++) {
    await limiter.schedule(async () => i);
  }

  const status = limiter.getStatus();
  assert.equal(status.requestsInWindow, 3);
});

test('getStatus returns correct initial state', () => {
  const limiter = new RateLimiter(50, 'test3');
  const status = limiter.getStatus();

  assert.equal(status.maxRequestsPerMinute, 50);
  assert.equal(status.requestsInWindow, 0);
  assert.equal(status.queueDepth, 0);
  assert.equal(status.isProcessing, false);
});

test('errors in scheduled functions are propagated', async () => {
  const limiter = new RateLimiter(50, 'test4');

  await assert.rejects(
    () =>
      limiter.schedule(async () => {
        throw new Error('Test error');
      }),
    { message: 'Test error' }
  );
});

test('concurrent scheduling works correctly', async () => {
  const limiter = new RateLimiter(10, 'test5');
  const results: number[] = [];

  const promises = Array.from({ length: 10 }, (_, i) =>
    limiter.schedule(async () => {
      results.push(i);
      return i;
    })
  );

  const values = await Promise.all(promises);
  assert.equal(values.length, 10);
  assert.equal(results.length, 10);
});

test('delays requests when limit is exceeded', async () => {
  const limiter = new RateLimiter(2, 'test6');
  // Shrink the sliding window so the test completes quickly
  limiter.windowMs = 100;
  const timestamps: number[] = [];

  const promises = Array.from({ length: 3 }, (_, i) =>
    limiter.schedule(async () => {
      timestamps.push(Date.now());
      return i;
    })
  );

  await Promise.all(promises);

  assert.equal(timestamps.length, 3);
  const gap = timestamps[2] - timestamps[1];
  // The 3rd request must wait for the window to expire (~100ms)
  assert.ok(gap >= 100, `3rd request should be delayed by at least windowMs, got ${gap}ms`);
});
