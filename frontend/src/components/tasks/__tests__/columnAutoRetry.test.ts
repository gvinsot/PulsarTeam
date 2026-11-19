import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  AUTO_RETRY_MAX,
  autoRetryMissingInstructions,
  cleanAutoRetry,
  isAutoRetryActive,
  parseMinutes,
} from '../columnAutoRetry.ts';

test('parseMinutes: empty / invalid / non-positive become null, large values clamp', () => {
  assert.equal(parseMinutes('', 100), null);
  assert.equal(parseMinutes('abc', 100), null);
  assert.equal(parseMinutes('0', 100), null);
  assert.equal(parseMinutes('-5', 100), null);
  assert.equal(parseMinutes('12.7', 100), 12);
  assert.equal(parseMinutes('500', 100), 100);
});

test('cleanAutoRetry drops an all-off config and the orphan retry cap', () => {
  assert.equal(cleanAutoRetry(null), null);
  assert.equal(cleanAutoRetry({ maxRetries: 3 }), null);
  assert.deepEqual(cleanAutoRetry({ intervalMinutes: 30, maxRetries: 0 }), { intervalMinutes: 30 });
  assert.deepEqual(
    cleanAutoRetry({ escalateAfterMinutes: 60, escalationInstructions: 'Help', maxRetries: 2 }),
    { escalateAfterMinutes: 60, escalationInstructions: 'Help' }
  );
  const long = 'x'.repeat(AUTO_RETRY_MAX.instructions + 10);
  assert.equal(
    cleanAutoRetry({ escalateAfterMinutes: 1, escalationInstructions: long })
      ?.escalationInstructions?.length,
    AUTO_RETRY_MAX.instructions
  );
});

test('isAutoRetryActive / autoRetryMissingInstructions', () => {
  assert.equal(isAutoRetryActive({ intervalMinutes: 5 }), true);
  assert.equal(isAutoRetryActive({}), false);
  assert.equal(autoRetryMissingInstructions({ escalateAfterMinutes: 5 }), true);
  assert.equal(
    autoRetryMissingInstructions({ escalateAfterMinutes: 5, escalationInstructions: ' ok ' }),
    false
  );
  assert.equal(autoRetryMissingInstructions({ intervalMinutes: 5 }), false);
});
