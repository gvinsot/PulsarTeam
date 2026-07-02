import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isValidRepoFullName,
  normalizeRepoFullName,
  normalizeStoragePath,
  normalizeSecondaryRepos,
  MAX_SECONDARY_REPOS,
  STORAGE_PATH_MAX,
} from '../taskRepos.js';

// ── isValidRepoFullName ──────────────────────────────────────────────────────
test('isValidRepoFullName accepts owner/repo and rejects everything else', () => {
  assert.equal(isValidRepoFullName('acme/widgets'), true);
  assert.equal(isValidRepoFullName('a.b-c/d.e-f'), true);
  assert.equal(isValidRepoFullName('no-slash'), false);
  assert.equal(isValidRepoFullName('too/many/slashes'), false);
  assert.equal(isValidRepoFullName('bad repo/name'), false); // space
  assert.equal(isValidRepoFullName(''), false);
  assert.equal(isValidRepoFullName(null), false);
  assert.equal(isValidRepoFullName(42), false);
});

// ── normalizeRepoFullName ────────────────────────────────────────────────────
test('normalizeRepoFullName trims valid, returns null for invalid/empty/non-string', () => {
  assert.equal(normalizeRepoFullName('  acme/widgets  '), 'acme/widgets');
  assert.equal(normalizeRepoFullName('acme/widgets'), 'acme/widgets');
  assert.equal(normalizeRepoFullName('not a repo'), null);
  assert.equal(normalizeRepoFullName(''), null);
  assert.equal(normalizeRepoFullName('   '), null);
  assert.equal(normalizeRepoFullName(null), null);
  assert.equal(normalizeRepoFullName(undefined), null);
  assert.equal(normalizeRepoFullName({ fullName: 'a/b' }), null);
});

// ── normalizeStoragePath ─────────────────────────────────────────────────────
test('normalizeStoragePath trims, length-caps, and rejects empty/non-string', () => {
  assert.equal(normalizeStoragePath('  /drive/x  '), '/drive/x');
  assert.equal(normalizeStoragePath(''), null);
  assert.equal(normalizeStoragePath('   '), null);
  assert.equal(normalizeStoragePath(null), null);
  assert.equal(normalizeStoragePath(123), null);
  const long = 'a'.repeat(STORAGE_PATH_MAX + 50);
  assert.equal(normalizeStoragePath(long).length, STORAGE_PATH_MAX);
});

// ── normalizeSecondaryRepos ──────────────────────────────────────────────────
test('normalizeSecondaryRepos coerces shapes, defaults provider, drops invalid', () => {
  const out = normalizeSecondaryRepos(['a/b', 'a/b', { fullName: 'c/d' }, 'nope', { foo: 1 }], 'x/y');
  assert.deepEqual(out, [
    { provider: 'github', fullName: 'a/b' },
    { provider: 'github', fullName: 'c/d' },
  ]);
});

test('normalizeSecondaryRepos excludes the primary repo', () => {
  assert.deepEqual(
    normalizeSecondaryRepos(['x/y', 'a/b'], 'x/y').map(r => r.fullName),
    ['a/b'],
  );
});

test('normalizeSecondaryRepos preserves an explicit provider', () => {
  assert.deepEqual(
    normalizeSecondaryRepos([{ provider: 'gitlab', fullName: 'a/b' }]),
    [{ provider: 'gitlab', fullName: 'a/b' }],
  );
});

test('normalizeSecondaryRepos returns [] for non-array input', () => {
  assert.deepEqual(normalizeSecondaryRepos(null), []);
  assert.deepEqual(normalizeSecondaryRepos(undefined), []);
  assert.deepEqual(normalizeSecondaryRepos('a/b' as any), []);
});

test('normalizeSecondaryRepos caps at MAX_SECONDARY_REPOS', () => {
  const many = Array.from({ length: MAX_SECONDARY_REPOS + 5 }, (_, i) => `org/r${i}`);
  assert.equal(normalizeSecondaryRepos(many).length, MAX_SECONDARY_REPOS);
});
