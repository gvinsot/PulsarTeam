import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentSwitcherOptions } from '../agentSwitcher.ts';

const qwen = { id: 'q', name: 'QWEN' };
const jarvis = { id: 'j', name: 'Jarvis', enabled: false };
const other = { id: 'o', name: 'Other', enabled: false };

test('keeps the current agent even when it is disabled', () => {
  const ids = agentSwitcherOptions([qwen, jarvis, other], jarvis).map(a => a.id);
  assert.deepEqual(ids, ['q', 'j']);
});

test('prepends the current agent when it is missing from the list', () => {
  const ids = agentSwitcherOptions([qwen], jarvis).map(a => a.id);
  assert.deepEqual(ids, ['j', 'q']);
});

test('lists only enabled agents otherwise', () => {
  const ids = agentSwitcherOptions([qwen, other], qwen).map(a => a.id);
  assert.deepEqual(ids, ['q']);
});
