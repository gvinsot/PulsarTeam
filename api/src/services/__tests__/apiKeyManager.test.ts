/**
 * Tests for apiKeyManager — HMAC storage, timing-safe validation, and the
 * split between LEGACY (ownerless, instance-wide) and SCOPED (per user, per
 * scope) keys.
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
  hash_version: number;
  // NULL on a legacy row — that is exactly what makes it legacy.
  user_id: string | null;
  scope: string | null;
  name: string | null;
  last_used_at: Date | null;
};

const rows: Row[] = [];
const queries: string[] = [];

/** Delete matching rows in place, returning how many went — pg's rowCount. */
function removeWhere(pred: (row: Row) => boolean): number {
  const kept = rows.filter(r => !pred(r));
  const removed = rows.length - kept.length;
  rows.length = 0;
  rows.push(...kept);
  return removed;
}

function makeFakePool() {
  return {
    async query(sql: string, params: unknown[] = []) {
      queries.push(sql);
      const norm = sql.replace(/\s+/g, ' ').trim();

      if (norm.startsWith('CREATE TABLE')) return { rows: [] };

      // ── DELETEs. The predicate matters: rotating the legacy key must not
      // wipe every user's scoped keys, which is exactly what an unqualified
      // `DELETE FROM api_keys` used to do.
      if (norm.startsWith('DELETE FROM api_keys WHERE user_id IS NULL')) {
        return { rows: [], rowCount: removeWhere(r => r.user_id === null) };
      }
      if (norm.startsWith('DELETE FROM api_keys WHERE user_id = $1 AND scope = $2')) {
        const [userId, scope] = params as [string, string];
        return { rows: [], rowCount: removeWhere(r => r.user_id === userId && r.scope === scope) };
      }
      if (norm.startsWith('DELETE FROM api_keys WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        return { rows: [], rowCount: removeWhere(r => r.id === id && r.user_id === userId) };
      }

      if (norm.startsWith('INSERT INTO api_keys')) {
        const [id, key_hash, prefix, hash_version, user_id, scope, name] = params as [
          string,
          string,
          string,
          number,
          string?,
          string?,
          string?,
        ];
        rows.push({
          id,
          key_hash,
          prefix,
          created_at: new Date(),
          hash_version,
          user_id: user_id ?? null,
          scope: scope ?? null,
          name: name ?? null,
          last_used_at: null,
        });
        return { rows: [] };
      }

      if (norm.startsWith('UPDATE api_keys SET last_used_at')) {
        const row = rows.find(r => r.id === params[0]);
        if (row) row.last_used_at = new Date();
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (norm.startsWith('SELECT id, prefix, created_at FROM api_keys')) {
        const v = params[0] as number;
        const matches = rows
          .filter(r => r.hash_version === v && r.user_id === null)
          .sort((a, b) => +b.created_at - +a.created_at)
          .slice(0, 1)
          .map(({ id, prefix, created_at }) => ({ id, prefix, created_at }));
        return { rows: matches };
      }

      if (norm.startsWith('SELECT id, prefix, created_at, last_used_at FROM api_keys')) {
        return {
          rows: rows
            .filter(r => r.user_id === null)
            .map(({ id, prefix, created_at, last_used_at }) => ({
              id,
              prefix,
              created_at,
              last_used_at,
            })),
        };
      }

      if (
        norm.startsWith('SELECT id, prefix, scope, name, created_at, last_used_at FROM api_keys')
      ) {
        const [userId, v] = params as [string, number];
        return {
          rows: rows
            .filter(r => r.user_id === userId && r.hash_version === v)
            .map(({ id, prefix, scope, name, created_at, last_used_at }) => ({
              id,
              prefix,
              scope,
              name,
              created_at,
              last_used_at,
            })),
        };
      }

      if (norm.startsWith('SELECT id, key_hash, user_id, scope FROM api_keys')) {
        const v = params[0] as number;
        return {
          rows: rows
            .filter(r => r.hash_version === v)
            .map(({ id, key_hash, user_id, scope }) => ({ id, key_hash, user_id, scope })),
        };
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
  resolveApiKey,
  createScopedApiKey,
  listApiKeysForUser,
  revokeScopedApiKey,
  listLegacyApiKeys,
  revokeLegacyApiKeys,
  scopeSatisfies,
  touchApiKey,
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

test('validation uses crypto.timingSafeEqual on equal-length buffers', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await generateNewApiKey();

  // Spy on crypto.timingSafeEqual to confirm it is the comparator in use.
  const original = crypto.timingSafeEqual;
  let calls = 0;
  const lengths: number[] = [];
  (crypto as any).timingSafeEqual = (a: Buffer, b: Buffer) => {
    calls++;
    lengths.push(a.length, b.length);
    return original(a, b);
  };
  try {
    assert.equal(await validateApiKey(key), true);
    assert.ok(calls >= 1, 'timingSafeEqual must be called during validation');
    assert.ok(
      lengths.every(l => l === 32),
      'comparator receives 32-byte buffers (SHA-256)'
    );
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
  assert.ok(
    !Object.prototype.hasOwnProperty.call(info, 'key_hash'),
    'getApiKeyInfo must never expose the hash'
  );
  assert.ok(
    !JSON.stringify(info).includes(key),
    'getApiKeyInfo must never expose the plaintext key'
  );

  await revokeApiKey();
  assert.equal(await getApiKeyInfo(), null);
  assert.equal(await validateApiKey(key), false);
});

// ── The legacy / scoped split ───────────────────────────────────────────────
//
// Before this split there was ONE ownerless key: `validateApiKey` answered a
// boolean and nothing downstream ever learned who was calling, so every tool it
// reached ran with no tenant at all. The tests below pin the three properties
// that make the replacement safe.

test('a scoped key names its owner and its scope; a legacy key names neither', async () => {
  reset();
  await ensureApiKeysTable();

  const legacy = await generateNewApiKey();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin', name: 'ci' });

  const resolvedLegacy = await resolveApiKey(legacy.key);
  assert.deepEqual(
    {
      userId: resolvedLegacy?.userId,
      scope: resolvedLegacy?.scope,
      legacy: resolvedLegacy?.legacy,
    },
    { userId: null, scope: null, legacy: true }
  );

  const resolvedScoped = await resolveApiKey(scoped.key);
  assert.deepEqual(
    {
      userId: resolvedScoped?.userId,
      scope: resolvedScoped?.scope,
      legacy: resolvedScoped?.legacy,
    },
    { userId: 'user-1', scope: 'admin', legacy: false }
  );

  assert.equal(await resolveApiKey('swarm_sk_' + 'a'.repeat(64)), null);
});

test('validateApiKey — which guards /api/swarm/* — accepts ONLY legacy keys', async () => {
  reset();
  await ensureApiKeysTable();
  const legacy = await generateNewApiKey();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'management' });

  assert.equal(await validateApiKey(legacy.key), true, 'integrations keep working');
  // The swarm surface runs with no tenant context whatsoever, so honouring a
  // scoped key there would hand its holder the entire instance — the exact
  // escalation the scopes exist to prevent.
  assert.equal(await validateApiKey(scoped.key), false, 'a scoped key must not escape its scope');
});

test('rotating the legacy key leaves every user scoped key alone', async () => {
  reset();
  await ensureApiKeysTable();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  await generateNewApiKey();

  // The replacement DELETE used to be unqualified: rotating the shared key
  // destroyed every personal key on the instance as a side effect.
  const stillThere = await resolveApiKey(scoped.key);
  assert.equal(stillThere?.userId, 'user-1');
  assert.equal(stillThere?.scope, 'admin');
});

test('revoking the legacy key leaves scoped keys alone, and vice versa', async () => {
  reset();
  await ensureApiKeysTable();
  const legacy = await generateNewApiKey();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

  await revokeApiKey();
  assert.equal(await validateApiKey(legacy.key), false);
  assert.ok(await resolveApiKey(scoped.key), 'a personal key survives a legacy revoke');

  assert.equal(await revokeScopedApiKey(scoped.id, 'user-1'), true);
  assert.equal(await resolveApiKey(scoped.key), null);
});

test('minting the same scope twice rotates it — the old key stops working', async () => {
  reset();
  await ensureApiKeysTable();
  const first = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  const second = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

  assert.equal(await resolveApiKey(first.key), null, 'the replaced key is dead');
  assert.equal((await resolveApiKey(second.key))?.id, second.id);
  assert.equal((await listApiKeysForUser('user-1')).length, 1, 'one row per (user, scope)');
});

test('a user holds one key per scope, and never sees another user keys', async () => {
  reset();
  await ensureApiKeysTable();
  await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  await createScopedApiKey({ userId: 'user-1', scope: 'management' });
  const other = await createScopedApiKey({ userId: 'user-2', scope: 'admin' });

  const mine = await listApiKeysForUser('user-1');
  assert.deepEqual(mine.map((k: any) => k.scope).sort(), ['admin', 'management']);
  assert.ok(!mine.some((k: any) => k.id === other.id));

  // The owner is part of the DELETE predicate, so another user's id matches
  // nothing: the caller is told "not found", never "forbidden" — which would
  // confirm the key exists.
  assert.equal(await revokeScopedApiKey(other.id, 'user-1'), false);
  assert.ok(await resolveApiKey(other.key), "user-2's key is untouched");
});

test('a key never stores the plaintext, whichever kind it is', async () => {
  reset();
  await ensureApiKeysTable();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'management' });
  const stored = rows.find(r => r.id === scoped.id)!;
  assert.notEqual(stored.key_hash, scoped.key);
  assert.equal(stored.key_hash, __testing.hmacKey(scoped.key));
  assert.ok(!JSON.stringify(await listApiKeysForUser('user-1')).includes(scoped.key));
});

test('the scope ladder is one-way: admin opens management, never the reverse', () => {
  assert.equal(scopeSatisfies('admin', 'management'), true);
  assert.equal(scopeSatisfies('admin', 'admin'), true);
  assert.equal(scopeSatisfies('management', 'management'), true);
  assert.equal(scopeSatisfies('management', 'admin'), false);
});

test('a half-written row (owner without scope) is treated as legacy, not granted a default', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await generateNewApiKey();
  // Simulate a row that acquired an owner but no scope — e.g. a partial
  // backfill. Defaulting it to any tool set would be a silent grant.
  rows[0].user_id = 'user-1';

  const resolved = await resolveApiKey(key);
  assert.equal(resolved?.legacy, true);
  assert.equal(resolved?.scope, null);
  assert.equal(resolved?.userId, null);
});

test('listLegacyApiKeys / revokeLegacyApiKeys see only the ownerless rows', async () => {
  reset();
  await ensureApiKeysTable();
  await generateNewApiKey();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

  const legacyRows = await listLegacyApiKeys();
  assert.equal(legacyRows.length, 1);
  assert.ok(!JSON.stringify(legacyRows).includes(scoped.id));

  assert.equal(await revokeLegacyApiKeys(), 1);
  assert.equal((await listLegacyApiKeys()).length, 0);
  assert.ok(await resolveApiKey(scoped.key), 'retiring the legacy key spares personal keys');
});

test('touchApiKey records last use and never throws the request', async () => {
  reset();
  await ensureApiKeysTable();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

  await touchApiKey(scoped.id);
  assert.ok(rows.find(r => r.id === scoped.id)!.last_used_at, 'last_used_at is stamped');
  // last_used_at is reporting, not authorization: an unknown id is a no-op.
  await touchApiKey('does-not-exist');
});
