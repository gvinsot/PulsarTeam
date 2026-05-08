/**
 * Tests for apiKeyManager — covers HMAC storage, timing-safe validation,
 * rejection of legacy plain-SHA-256 hashes, and the v1→v2 migration.
 */

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// Provide a deterministic JWT_SECRET so the HMAC secret derivation is stable
// across the test suite. (No API_KEY_SECRET — exercise the HKDF fallback.)
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use';
delete process.env.API_KEY_SECRET;

// ── In-memory fake of the api_keys table ─────────────────────────────────────
type Row = {
  id: string;
  key_hash: string;
  prefix: string;
  created_at: Date;
  hash_version: number | null;
};

const rows: Row[] = [];
const queries: string[] = [];

function makeFakePool() {
  return {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (norm.startsWith('CREATE TABLE')) return { rows: [] };
      if (norm.startsWith('ALTER TABLE')) return { rows: [] };

      if (norm.startsWith('DELETE FROM api_keys WHERE hash_version IS NULL')) {
        const min = params[0] as number;
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i].hash_version == null || rows[i].hash_version < min) {
            rows.splice(i, 1);
          }
        }
        return { rows: [] };
      }
      if (norm.startsWith('DELETE FROM api_keys')) {
        rows.length = 0;
        return { rows: [] };
      }

      if (norm.startsWith('INSERT INTO api_keys')) {
        const [id, key_hash, prefix, hash_version] = params as [
          string, string, string, number,
        ];
        rows.push({ id, key_hash, prefix, created_at: new Date(), hash_version });
        return { rows: [] };
      }

      if (norm.startsWith('SELECT id, prefix, created_at FROM api_keys')) {
        const v = params[0] as number;
        const matches = rows
          .filter(r => r.hash_version === v)
          .sort((a, b) => +b.created_at - +a.created_at)
          .slice(0, 1)
          .map(({ id, prefix, created_at }) => ({ id, prefix, created_at }));
        return { rows: matches };
      }

      if (norm.startsWith('SELECT key_hash FROM api_keys')) {
        const v = params[0] as number;
        return { rows: rows.filter(r => r.hash_version === v).map(r => ({ key_hash: r.key_hash })) };
      }

      throw new Error(`Unhandled query in test fake: ${norm}`);
    },
  };
}

const fakePool = makeFakePool();

mock.module('../database.js', {
  namedExports: { getPool: () => fakePool },
});

// Import under test AFTER mocks are registered.
const {
  ensureApiKeysTable,
  generateNewApiKey,
  validateApiKey,
  getApiKeyInfo,
  revokeApiKey,
  __testing,
} = await import('../apiKeyManager.js');

function reset() {
  rows.length = 0;
  queries.length = 0;
}

test('generateNewApiKey returns plaintext key and stores only the HMAC', async () => {
  reset();
  await ensureApiKeysTable();

  const { id, key, prefix } = await generateNewApiKey();
  assert.match(key, /^swarm_sk_[0-9a-f]{64}$/, 'plaintext key has expected format');
  assert.equal(rows.length, 1);

  const stored = rows[0];
  assert.equal(stored.id, id);
  assert.equal(stored.prefix, prefix);
  assert.equal(stored.hash_version, __testing.CURRENT_HASH_VERSION);
  assert.notEqual(stored.key_hash, key, 'plaintext key MUST NOT be in the database');
  assert.equal(stored.key_hash.length, 64, 'HMAC-SHA256 hex is 64 chars');
  assert.equal(stored.key_hash, __testing.hmacKey(key));

  // The stored hash differs from a plain SHA-256 of the key — proving HMAC,
  // not bare hash, is what reaches the database.
  const plainSha = crypto.createHash('sha256').update(key).digest('hex');
  assert.notEqual(stored.key_hash, plainSha);
});

test('validateApiKey accepts the freshly minted key and rejects a wrong one', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await generateNewApiKey();

  assert.equal(await validateApiKey(key), true);
  assert.equal(await validateApiKey('swarm_sk_' + 'a'.repeat(64)), false);
  assert.equal(await validateApiKey(''), false);
  assert.equal(await validateApiKey(undefined as unknown as string), false);
});

test('validateApiKey rejects legacy v1 (plain SHA-256) rows even if hash matches', async () => {
  reset();
  await ensureApiKeysTable();

  // Inject a row that pretends to be a pre-migration entry: plain SHA-256 of a
  // known plaintext, no hash_version. The migration should drop it; validation
  // must refuse the plaintext.
  const legacyKey = 'swarm_sk_' + 'b'.repeat(64);
  const legacyHash = crypto.createHash('sha256').update(legacyKey).digest('hex');
  rows.push({
    id: 'legacy-id',
    key_hash: legacyHash,
    prefix: 'swarm_sk_bbb...bbbb',
    created_at: new Date(),
    hash_version: null,
  });

  // Re-run the migration step (this is what happens at next startup).
  await ensureApiKeysTable();
  assert.equal(rows.length, 0, 'v1 row must be pruned by the migration');

  assert.equal(await validateApiKey(legacyKey), false);
});

test('validation uses crypto.timingSafeEqual on equal-length buffers', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await generateNewApiKey();

  // Spy on crypto.timingSafeEqual to confirm it is the comparator in use.
  const original = crypto.timingSafeEqual;
  let calls = 0;
  let lengths: number[] = [];
  (crypto as any).timingSafeEqual = (a: Buffer, b: Buffer) => {
    calls++;
    lengths.push(a.length, b.length);
    return original(a, b);
  };
  try {
    assert.equal(await validateApiKey(key), true);
    assert.ok(calls >= 1, 'timingSafeEqual must be called during validation');
    assert.ok(lengths.every(l => l === 32), 'comparator receives 32-byte buffers (SHA-256)');
  } finally {
    (crypto as any).timingSafeEqual = original;
  }
});

test('safeHexEqual returns false for differing-length inputs without throwing', () => {
  assert.equal(__testing.safeHexEqual('aa', 'aabb'), false);
  assert.equal(__testing.safeHexEqual('aa', 'aa'), true);
  assert.equal(__testing.safeHexEqual('ab', 'cd'), false);
});

test('getApiKeyInfo returns prefix only and revokeApiKey clears the key', async () => {
  reset();
  await ensureApiKeysTable();
  const { key, prefix } = await generateNewApiKey();

  const info = await getApiKeyInfo();
  assert.ok(info, 'info should exist');
  assert.equal(info.prefix, prefix);
  assert.ok(!Object.prototype.hasOwnProperty.call(info, 'key_hash'),
    'getApiKeyInfo must never expose the hash');
  assert.ok(!JSON.stringify(info).includes(key),
    'getApiKeyInfo must never expose the plaintext key');

  await revokeApiKey();
  assert.equal(await getApiKeyInfo(), null);
  assert.equal(await validateApiKey(key), false);
});
