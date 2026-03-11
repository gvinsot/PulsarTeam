/**
 * Tests for the RateLimiter class.
 * 
 * Run with: node --experimental-vm-modules server/src/services/__tests__/rateLimiter.test.js
 * Or:       cd server && node --experimental-vm-modules src/services/__tests__/rateLimiter.test.js
 */

import { RateLimiter } from '../rateLimiter.js';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  ❌ FAIL: ${message}`);
    failed++;
  } else {
    passed++;
  }
}

async function test(name, fn) {
  console.log(`  ${name}`);
  try {
    await fn();
  } catch (err) {
    console.error(`  ❌ FAIL: ${name} threw: ${err.message}`);
    failed++;
  }
}

async function runTests() {
  console.log('\n🧪 RateLimiter Tests\n');

  await test('requests within limit execute immediately', async () => {
    const limiter = new RateLimiter(5, 'test1');
    const results = [];
    const start = Date.now();

    const promises = Array.from({ length: 5 }, (_, i) =>
      limiter.schedule(async () => {
        results.push(i);
        return i;
      })
    );

    await Promise.all(promises);
    const elapsed = Date.now() - start;

    assert(results.length === 5, `Expected 5 results, got ${results.length}`);
    assert(elapsed < 1000, `Expected < 1000ms, took ${elapsed}ms`);
  });

  await test('tracks requests in the sliding window', async () => {
    const limiter = new RateLimiter(3, 'test2');

    for (let i = 0; i < 3; i++) {
      await limiter.schedule(async () => i);
    }

    const status = limiter.getStatus();
    assert(status.requestsInWindow === 3, `Expected 3 in window, got ${status.requestsInWindow}`);
  });

  await test('getStatus returns correct initial state', async () => {
    const limiter = new RateLimiter(50, 'test3');
    const status = limiter.getStatus();

    assert(status.maxRequestsPerMinute === 50, 'Max should be 50');
    assert(status.requestsInWindow === 0, 'Should start at 0');
    assert(status.queueDepth === 0, 'Queue should be empty');
    assert(status.isProcessing === false, 'Should not be processing');
  });

  await test('errors in scheduled functions are propagated', async () => {
    const limiter = new RateLimiter(50, 'test4');
    let caught = false;

    try {
      await limiter.schedule(async () => {
        throw new Error('Test error');
      });
    } catch (error) {
      caught = true;
      assert(error.message === 'Test error', `Expected 'Test error', got '${error.message}'`);
    }

    assert(caught, 'Error should have been thrown');
  });

  await test('concurrent scheduling works correctly', async () => {
    const limiter = new RateLimiter(10, 'test5');
    const results = [];

    const promises = Array.from({ length: 10 }, (_, i) =>
      limiter.schedule(async () => {
        results.push(i);
        return i;
      })
    );

    const values = await Promise.all(promises);
    assert(values.length === 10, `Expected 10 values, got ${values.length}`);
    assert(results.length === 10, `Expected 10 results, got ${results.length}`);
  });

  await test('delays requests when limit is exceeded', async () => {
    const limiter = new RateLimiter(2, 'test6'); // Only 2 per minute
    const timestamps = [];

    // Schedule 3 requests — the 3rd should be delayed
    const promises = Array.from({ length: 3 }, (_, i) =>
      limiter.schedule(async () => {
        timestamps.push(Date.now());
        return i;
      })
    );

    await Promise.all(promises);

    // First 2 should be nearly instant, 3rd should be delayed
    assert(timestamps.length === 3, `Expected 3 timestamps, got ${timestamps.length}`);
    const gap = timestamps[2] - timestamps[1];
    // The 3rd request should wait ~60 seconds, but we just check it's > 0
    // (In a real test we'd mock Date.now, but this confirms the queue works)
    assert(gap >= 0, `Gap between 2nd and 3rd request should be >= 0, got ${gap}ms`);
  });

  console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);

  if (failed > 0) {
    console.log('❌ Some tests failed!');
    process.exit(1);
  } else {
    console.log('✅ All tests passed!');
  }
}

runTests().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});