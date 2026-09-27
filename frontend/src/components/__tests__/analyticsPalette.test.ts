import test from 'node:test';
import assert from 'node:assert/strict';
import {
  colorForKey,
  foldOther,
  OTHER_KEY,
  orderByType,
  SERIES_DARK,
  SERIES_LIGHT,
  slotForKey,
  pct,
  typeLabel,
} from '../analyticsPalette';

test('a task type keeps its color regardless of which other types are present', () => {
  // Echoes the task-card badges: bug red, feature green, technical blue.
  assert.equal(colorForKey('feature', 'dark'), SERIES_DARK[2]);
  assert.equal(colorForKey('feature', 'light'), SERIES_LIGHT[2]);
  assert.equal(slotForKey('bug'), 7);
  assert.equal(slotForKey('technical'), 0);
  assert.equal(colorForKey(OTHER_KEY, 'dark'), '#6b7280');
});

test('unknown keys get a stable slot', () => {
  assert.equal(slotForKey('custom-type'), slotForKey('custom-type'));
  assert.ok(slotForKey('custom-type') < SERIES_LIGHT.length);
});

test('foldOther keeps the largest buckets and folds the tail into Other', () => {
  const buckets = Array.from({ length: 10 }, (_, i) => ({ key: `k${i}`, count: i + 1 }));
  const folded = foldOther(buckets, 8);
  assert.equal(folded.length, 8);
  assert.equal(folded[0].key, 'k9');
  assert.deepEqual(folded[7], { key: OTHER_KEY, count: 1 + 2 + 3 });
  assert.equal(
    folded.reduce((s, b) => s + b.count, 0),
    buckets.reduce((s, b) => s + b.count, 0)
  );
});

test('foldOther leaves a short list alone', () => {
  assert.equal(foldOther([{ key: 'a', count: 1 }]).length, 1);
});

test('labels and percentages', () => {
  assert.equal(typeLabel('bug'), 'Bug');
  assert.equal(typeLabel('untyped'), 'Untyped');
  assert.equal(typeLabel('weird'), 'weird');
  assert.equal(pct(1, 3), '33%');
  assert.equal(pct(1, 0), '0%');
});

test('orderByType puts types in the fixed slice order, unknowns then Other last', () => {
  const ordered = orderByType([
    { key: OTHER_KEY, count: 50 },
    { key: 'untyped', count: 1 },
    { key: 'custom', count: 3 },
    { key: 'feature', count: 9 },
    { key: 'bug', count: 2 },
  ]);
  assert.deepEqual(
    ordered.map(b => b.key),
    ['bug', 'feature', 'untyped', 'custom', OTHER_KEY]
  );
  assert.equal(colorForKey('untyped', 'dark'), colorForKey(OTHER_KEY, 'dark'));
});
