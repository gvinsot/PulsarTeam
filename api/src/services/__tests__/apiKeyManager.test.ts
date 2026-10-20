/**
 * Tests for apiKeyManager — HMAC storage, timing-safe validation, and the
 * SCOPED (per user, per scope) keys. The ownerless instance-wide "legacy" key
 * no longer exists: a row without an owner resolves to nothing.
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
  // NULL only on a dead ownerless row, which must resolve to nothing.
  user_id: string | null;
  scope: string | null;
  name: string | null;
  // Set on an `insert` key only.
  board_id: string | null;
  // Insert keys only: column ids, or null for every column.
  allowed_columns: string[] | null;
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

      // ── DELETEs
      if (norm.startsWith('DELETE FROM api_keys WHERE user_id = $1 AND scope = $2')) {
        const [userId, scope] = params as [string, string];
        return { rows: [], rowCount: removeWhere(r => r.user_id === userId && r.scope === scope) };
      }
      if (norm.startsWith('DELETE FROM api_keys WHERE id = $1 AND user_id = $2')) {
        const [id, userId] = params as [string, string];
        return { rows: [], rowCount: removeWhere(r => r.id === id && r.user_id === userId) };
      }

      if (norm.startsWith('INSERT INTO api_keys')) {
        const [id, key_hash, prefix, hash_version, user_id, scope, name, board_id, allowed] =
          params as [string, string, string, number, string?, string?, string?, string?, string?];
        rows.push({
          id,
          key_hash,
          prefix,
          created_at: new Date(),
          hash_version,
          user_id: user_id ?? null,
          scope: scope ?? null,
          name: name ?? null,
          board_id: board_id ?? null,
          allowed_columns: allowed ? JSON.parse(allowed) : null,
          last_used_at: null,
        });
        return { rows: [] };
      }

      if (norm.startsWith('UPDATE api_keys SET last_used_at')) {
        const row = rows.find(r => r.id === params[0]);
        if (row) row.last_used_at = new Date();
        return { rows: [], rowCount: row ? 1 : 0 };
      }

      if (
        norm.startsWith('SELECT k.id, k.prefix, k.scope, k.name, k.board_id, b.name AS board_name')
      ) {
        const [userId, v] = params as [string, number];
        return {
          rows: rows
            .filter(r => r.user_id === userId && r.hash_version === v)
            .map(({ id, prefix, scope, name, board_id, created_at, last_used_at }) => ({
              id,
              prefix,
              scope,
              name,
              board_id,
              board_name: board_id ? `Board ${board_id}` : null,
              created_at,
              last_used_at,
            })),
        };
      }

      if (
        norm.startsWith(
          'SELECT id, key_hash, user_id, scope, board_id, allowed_columns FROM api_keys'
        )
      ) {
        const v = params[0] as number;
        return {
          rows: rows
            .filter(r => r.hash_version === v)
            .map(({ id, key_hash, user_id, scope, board_id, allowed_columns }) => ({
              id,
              key_hash,
              user_id,
              scope,
              board_id,
              allowed_columns,
            })),
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
  resolveApiKey,
  createScopedApiKey,
  createInsertApiKey,
  createBrowserApiKey,
  createLlmApiKey,
  listApiKeysForUser,
  revokeScopedApiKey,
  scopeSatisfies,
  touchApiKey,
  __testing,
} = await import('../apiKeyManager.js');

function reset() {
  rows.length = 0;
  queries.length = 0;
}

test('createScopedApiKey returns plaintext key and stores only the HMAC', async () => {
  reset();
  await ensureApiKeysTable();

  const { id, key, prefix } = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
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

test('resolveApiKey accepts the freshly minted key and rejects a wrong one', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

  assert.ok(await resolveApiKey(key));
  assert.equal(await resolveApiKey('swarm_sk_' + 'a'.repeat(64)), null);
  assert.equal(await resolveApiKey(''), null);
  assert.equal(await resolveApiKey(undefined as unknown as string), null);
});

test('validation uses crypto.timingSafeEqual on equal-length buffers', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

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
    assert.ok(await resolveApiKey(key));
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

test('a scoped key names its owner and its scope', async () => {
  reset();
  await ensureApiKeysTable();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin', name: 'ci' });

  const resolved = await resolveApiKey(scoped.key);
  assert.deepEqual(
    { userId: resolved?.userId, scope: resolved?.scope },
    { userId: 'user-1', scope: 'admin' }
  );
  assert.ok(!('legacy' in (resolved as object)), 'there is no legacy flag any more');
});

test('an ownerless (former legacy) row resolves to nothing', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  // Simulate a row left over from the removed instance-wide key: no owner, no
  // scope, no board. It must never be honoured again.
  rows[0].user_id = null;
  rows[0].scope = null;

  assert.equal(await resolveApiKey(key), null);
});

test('revoking a scoped key kills it', async () => {
  reset();
  await ensureApiKeysTable();
  const scoped = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });

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

test('a half-written row (owner without scope) is refused everywhere, not granted anything', async () => {
  reset();
  await ensureApiKeysTable();
  const { key } = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  // Simulate a row that has an owner but lost its scope — e.g. a partial
  // backfill. Defaulting it to any tool set would be a silent grant.
  rows[0].scope = null;

  assert.equal(await resolveApiKey(key), null);
});

// ── Insert keys ─────────────────────────────────────────────────────────────

const BOARD = '11111111-1111-4111-8111-111111111111';

test('an insert key names its owner, its scope AND its board', async () => {
  reset();
  await ensureApiKeysTable();
  const created = await createInsertApiKey({ userId: 'user-1', boardId: BOARD, name: 'form' });
  assert.equal(created.scope, 'insert');
  assert.equal(created.board_id, BOARD);

  const resolved = await resolveApiKey(created.key);
  assert.deepEqual(resolved, {
    id: created.id,
    userId: 'user-1',
    scope: 'insert',
    boardId: BOARD,
    allowedColumns: null,
  });
});

test('insert keys accumulate: minting another never kills the first', async () => {
  reset();
  await ensureApiKeysTable();
  const form = await createInsertApiKey({ userId: 'user-1', boardId: BOARD, name: 'form' });
  const webhook = await createInsertApiKey({ userId: 'user-1', boardId: BOARD, name: 'webhook' });
  const ladder = await createScopedApiKey({ userId: 'user-1', scope: 'management' });

  assert.ok(await resolveApiKey(form.key), 'one integration per key: the first survives');
  assert.ok(await resolveApiKey(webhook.key));
  assert.ok(await resolveApiKey(ladder.key), 'insert keys do not touch the ladder keys');

  // …and rotating a ladder key leaves every insert key alone.
  await createScopedApiKey({ userId: 'user-1', scope: 'management' });
  assert.ok(await resolveApiKey(form.key));

  const mine = await listApiKeysForUser('user-1');
  assert.equal(mine.filter((k: any) => k.scope === 'insert').length, 2);
  assert.equal(mine.find((k: any) => k.id === form.id).board_id, BOARD);

  assert.equal(await revokeScopedApiKey(form.id, 'user-1'), true);
  assert.equal(await resolveApiKey(form.key), null);
  assert.ok(await resolveApiKey(webhook.key), 'revoking one insert key spares the others');
});

test('an insert row without its board, or a ladder row with one, resolves to nothing', async () => {
  reset();
  await ensureApiKeysTable();
  const insert = await createInsertApiKey({ userId: 'user-1', boardId: BOARD });
  const ladder = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  rows.find(r => r.id === insert.id)!.board_id = null;
  rows.find(r => r.id === ladder.id)!.board_id = BOARD;

  assert.equal(await resolveApiKey(insert.key), null);
  assert.equal(await resolveApiKey(ladder.key), null);
});

test('createScopedApiKey refuses the insert scope — it needs a board', async () => {
  reset();
  await ensureApiKeysTable();
  await assert.rejects(
    createScopedApiKey({ userId: 'user-1', scope: 'insert' as any }),
    /Unknown API key scope/
  );
  await assert.rejects(createInsertApiKey({ userId: 'user-1', boardId: '' }), /bound to a board/);
  assert.equal(rows.length, 0);
});

test('insert is off the ladder in both directions', () => {
  assert.equal(scopeSatisfies('insert', 'insert'), true);
  assert.equal(scopeSatisfies('insert', 'management'), false);
  assert.equal(scopeSatisfies('insert', 'admin'), false);
  assert.equal(scopeSatisfies('admin', 'insert'), false);
  assert.equal(scopeSatisfies('management', 'insert'), false);
});

test('browser keys name their owner and no board, and accumulate like insert keys', async () => {
  reset();
  await ensureApiKeysTable();
  const scraper = await createBrowserApiKey({ userId: 'user-1', name: 'scraper' });
  const digest = await createBrowserApiKey({ userId: 'user-1' });
  const ladder = await createScopedApiKey({ userId: 'user-1', scope: 'admin' });
  assert.equal(scraper.scope, 'browser');
  assert.equal(scraper.board_id, null);
  assert.equal(digest.name, 'browser key');

  assert.deepEqual(await resolveApiKey(scraper.key), {
    id: scraper.id,
    userId: 'user-1',
    scope: 'browser',
    boardId: null,
    allowedColumns: null,
  });
  assert.ok(await resolveApiKey(digest.key), 'minting another never kills the first');
  assert.ok(await resolveApiKey(ladder.key), 'browser keys do not touch the ladder keys');

  assert.equal(await revokeScopedApiKey(scraper.id, 'user-1'), true);
  assert.equal(await resolveApiKey(scraper.key), null);
  assert.ok(await resolveApiKey(digest.key), 'revoking one browser key spares the others');

  // A browser row that somehow carries a board is half-written: refused.
  rows.find(r => r.id === digest.id)!.board_id = BOARD;
  assert.equal(await resolveApiKey(digest.key), null);
});

test('createScopedApiKey refuses the browser scope — it is not a ladder rung', async () => {
  reset();
  await ensureApiKeysTable();
  await assert.rejects(
    createScopedApiKey({ userId: 'user-1', scope: 'browser' as any }),
    /Unknown API key scope/
  );
  assert.equal(rows.length, 0);
});

test('browser is off the ladder in both directions, and apart from insert', () => {
  assert.equal(scopeSatisfies('browser', 'browser'), true);
  for (const other of ['admin', 'management', 'insert'] as const) {
    assert.equal(scopeSatisfies('browser', other), false, `browser opens no ${other} surface`);
    assert.equal(scopeSatisfies(other, 'browser'), false, `${other} does not open browser`);
  }
});

test('llm keys name their owner and no board, and accumulate', async () => {
  reset();
  await ensureApiKeysTable();
  const first = await createLlmApiKey({ userId: 'user-1', name: 'chatbot' });
  const second = await createLlmApiKey({ userId: 'user-1' });
  assert.equal(first.scope, 'llm');
  assert.equal(first.board_id, null);
  assert.equal(second.name, 'llm key');
  assert.deepEqual(await resolveApiKey(first.key), {
    id: first.id,
    userId: 'user-1',
    scope: 'llm',
    boardId: null,
    allowedColumns: null,
  });
  assert.equal(await revokeScopedApiKey(first.id, 'user-1'), true);
  assert.equal(await resolveApiKey(first.key), null);
  assert.ok(await resolveApiKey(second.key), 'revoking one llm key spares the others');
});

test('llm is off the ladder in both directions', () => {
  assert.equal(scopeSatisfies('llm', 'llm'), true);
  for (const other of ['admin', 'management', 'insert', 'browser'] as const) {
    assert.equal(scopeSatisfies('llm', other), false, `llm opens no ${other} surface`);
    assert.equal(scopeSatisfies(other, 'llm'), false, `${other} does not open llm`);
  }
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
