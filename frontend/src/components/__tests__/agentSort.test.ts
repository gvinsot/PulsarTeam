import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sortAgents, lastActivityTime } from '../agentSort.ts';

const agent = (id: string, name: string, lastActiveAt: string | null, status = 'idle') =>
  ({ id, name, status, metrics: { lastActiveAt } }) as any;

const a = agent('a', 'Bravo', '2026-09-01T10:00:00Z');
const b = agent('b', 'alpha', '2026-09-30T10:00:00Z');
const c = agent('c', 'Charlie', null);
const d = agent('d', 'delta', '2026-08-01T10:00:00Z', 'busy');

test('default mode keeps the incoming order', () => {
  const list = [a, b, c, d];
  assert.equal(sortAgents(list, 'default'), list);
});

test('activity mode: working agents first, then most recent, never-active last', () => {
  assert.deepEqual(
    sortAgents([a, b, c, d], 'activity').map(x => x.id),
    ['d', 'b', 'a', 'c']
  );
});

test('activity mode treats a thinking agent as active now', () => {
  assert.deepEqual(
    sortAgents([a, b], 'activity', { a: '...' }).map(x => x.id),
    ['a', 'b']
  );
});

test('name mode sorts case-insensitively without mutating input', () => {
  const list = [c, a, d, b];
  assert.deepEqual(
    sortAgents(list, 'name').map(x => x.id),
    ['b', 'a', 'c', 'd']
  );
  assert.deepEqual(
    list.map(x => x.id),
    ['c', 'a', 'd', 'b']
  );
});

test('lastActivityTime handles missing metrics and invalid dates', () => {
  assert.equal(lastActivityTime({ id: 'x', name: 'x', status: 'idle' } as any), -Infinity);
  assert.equal(lastActivityTime(agent('y', 'y', 'not-a-date')), -Infinity);
});
