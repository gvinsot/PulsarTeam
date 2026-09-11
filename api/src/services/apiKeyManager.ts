import crypto from 'crypto';
import { getPool } from './database.js';
import { readSecret } from '../secrets.js';

const TABLE = 'api_keys';

// Bump when the hashing scheme changes. Rows with an older version are
// ignored by all queries, forcing the admin to mint a new key.
const CURRENT_HASH_VERSION = 2;

/**
 * Manages MCP API keys stored in PostgreSQL.
 *
 * ── Two kinds of row live in `api_keys` ─────────────────────────────────────
 *
 *  • LEGACY (`user_id IS NULL`, `scope IS NULL`). The original design: ONE
 *    instance-wide key, owned by nobody, that `validateApiKey` answered
 *    true/false for. Nothing downstream ever learned who was calling, so every
 *    tool it reached ran with no tenant at all. These rows still exist on
 *    deployments that minted one, and they still open `/api/swarm/*` so no
 *    integration breaks — but they are REFUSED by `requireApiKeyScope`, i.e.
 *    by every endpoint added after them. `listLegacyApiKeys` /
 *    `revokeLegacyApiKeys` exist so an operator can see and retire them.
 *
 *  • SCOPED (`user_id` + `scope` both set). One row per (user, scope), minted
 *    by the user themselves. The key names its owner and its tool set; it does
 *    NOT carry the owner's claims. `resolveApiKey` returns the owner id and
 *    the middleware re-reads the user row on every request, so a demotion or a
 *    deletion restricts the key on its very next use rather than whenever it
 *    happens to be rotated.
 *
 * Storage scheme (v2), identical for both kinds:
 *   key_hash = HMAC-SHA256(api_key, server_secret)
 *
 * The server secret is read from API_KEY_SECRET (Docker secret or env). If
 * unset, it is deterministically derived from JWT_SECRET via HKDF so that
 * existing deployments do not require an extra secret to be provisioned.
 * Without the server secret, a database dump alone is not enough to validate
 * a key — the attacker also needs the secret.
 */

/**
 * The tool sets a key can open. NOT roles: `admin` is the administrative TOOL
 * SET, and a key holding it is still bounded by what its owner may already
 * administer in the UI. The genuinely instance-wide tools check
 * `role === 'admin'` for themselves.
 */
export const API_KEY_SCOPES = ['admin', 'management'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/**
 * The scope ladder, one way only: an `admin` key opens the management surface,
 * a `management` key never opens the admin one.
 */
const SCOPE_RANK: Record<ApiKeyScope, number> = { management: 0, admin: 1 };

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** Does a key granted `granted` satisfy an endpoint demanding `required`? */
export function scopeSatisfies(granted: ApiKeyScope, required: ApiKeyScope): boolean {
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

/** What `resolveApiKey` hands back. Never contains the owner's claims. */
export interface ResolvedApiKey {
  id: string;
  /** NULL only for a legacy row. */
  userId: string | null;
  /** NULL only for a legacy row. */
  scope: ApiKeyScope | null;
  /** True for the ownerless instance-wide key — see the module header. */
  legacy: boolean;
}

/** Resolve the HMAC secret used to fingerprint API keys. */
function getHmacSecret(): Buffer {
  const explicit = readSecret('API_KEY_SECRET', '');
  if (explicit) return Buffer.from(explicit, 'utf-8');

  const jwt = readSecret('JWT_SECRET', '');
  if (!jwt) {
    throw new Error('API key HMAC secret is not configured (set API_KEY_SECRET or JWT_SECRET)');
  }
  // Domain-separate from JWT signing so the same bytes are never reused
  // across primitives.
  return Buffer.from(
    crypto.hkdfSync(
      'sha256',
      Buffer.from(jwt, 'utf-8'),
      Buffer.alloc(0),
      Buffer.from('pulsarteam:api-key-hmac:v1', 'utf-8'),
      32
    )
  );
}

function hmacKey(key: string): string {
  return crypto.createHmac('sha256', getHmacSecret()).update(key).digest('hex');
}

function generateApiKey(): string {
  // Format: swarm_sk_<32 hex chars>
  return `swarm_sk_${crypto.randomBytes(32).toString('hex')}`;
}

/** Constant-time comparison of two equal-length hex strings. */
function safeHexEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export async function ensureApiKeysTable() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      hash_version INTEGER NOT NULL
    )
  `);
}

/**
 * Get the current LEGACY API key metadata (prefix only, never the full key).
 *
 * Scoped keys are deliberately invisible here: this backs the instance-wide
 * key panel, and a user's personal keys are not an admin's to display.
 */
export async function getApiKeyInfo() {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, prefix, created_at FROM ${TABLE}
     WHERE hash_version = $1 AND user_id IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [CURRENT_HASH_VERSION]
  );
  return result.rows[0] || null;
}

/**
 * Generate a new legacy (instance-wide, ownerless) API key, replacing the
 * previous one. Returns the full key — the only time it is visible in clear.
 *
 * The replacement DELETE is narrowed to `user_id IS NULL`: it used to clear the
 * whole table, which would now destroy every user's scoped keys as a side
 * effect of an admin rotating the shared one.
 */
export async function generateNewApiKey() {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  // Compute everything that can throw (e.g. getHmacSecret with no secret
  // configured) before the old key is deleted.
  const key = generateApiKey();
  const id = crypto.randomUUID();
  const prefix = key.slice(0, 12) + '...' + key.slice(-4);
  const keyHash = hmacKey(key);

  // Singleton among legacy rows: replace any existing one. DELETE+INSERT must
  // be atomic — if the INSERT fails after a committed DELETE, every external
  // caller is locked out until an admin mints and redistributes a new key.
  const replaceKey = async (q: {
    query: (sql: string, params?: unknown[]) => Promise<unknown>;
  }) => {
    await q.query(`DELETE FROM ${TABLE} WHERE user_id IS NULL`);
    await q.query(
      `INSERT INTO ${TABLE} (id, key_hash, prefix, created_at, hash_version)
       VALUES ($1, $2, $3, NOW(), $4)`,
      [id, keyHash, prefix, CURRENT_HASH_VERSION]
    );
  };

  if (typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await replaceKey(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    // Minimal pool implementations (test doubles) only expose query().
    await replaceKey(pool);
  }

  return { id, key, prefix };
}

/**
 * Resolve a presented key to its row, in constant time.
 *
 * Walks the full candidate set so the work done is independent of which (if
 * any) row matches, and only reads the matching row's metadata afterwards —
 * the comparison loop itself branches on nothing but the hash.
 */
export async function resolveApiKey(key: string): Promise<ResolvedApiKey | null> {
  const pool = getPool();
  if (!pool) return null;
  if (typeof key !== 'string' || key.length === 0) return null;

  const candidate = hmacKey(key);

  const result = await pool.query(
    `SELECT id, key_hash, user_id, scope FROM ${TABLE} WHERE hash_version = $1`,
    [CURRENT_HASH_VERSION]
  );

  let matched: Record<string, unknown> | null = null;
  for (const row of result.rows) {
    // Do not short-circuit — keep work constant across rows.
    if (safeHexEqual(candidate, row.key_hash)) matched = row;
  }
  if (!matched) return null;

  const userId = (matched.user_id as string | null) ?? null;
  const rawScope = matched.scope;
  // A row is scoped only if BOTH halves are present. A half-written row (owner
  // without scope, or the reverse) is treated as legacy, i.e. refused by every
  // scoped endpoint, rather than silently granted a default tool set.
  const scoped = !!userId && isApiKeyScope(rawScope);
  return {
    id: matched.id as string,
    userId: scoped ? userId : null,
    scope: scoped ? (rawScope as ApiKeyScope) : null,
    legacy: !scoped,
  };
}

/**
 * Legacy true/false validation, for `/api/swarm/*` only.
 *
 * It answers true ONLY for a legacy row. A scoped key must not open the swarm
 * surface: those routes run with no tenant context at all (see
 * services/swarmApiMcp.ts `callerScope`), so honouring a `management` key there
 * would hand its holder the whole instance — the exact escalation the scoped
 * keys exist to prevent.
 */
export async function validateApiKey(key: string): Promise<boolean> {
  const resolved = await resolveApiKey(key);
  return !!resolved && resolved.legacy;
}

/**
 * Delete the legacy API key (revoke the instance-wide access).
 * Scoped keys are untouched — see generateNewApiKey.
 */
export async function revokeApiKey() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`DELETE FROM ${TABLE} WHERE user_id IS NULL`);
}

/** Every legacy row still outstanding, so an operator can see what to retire. */
export async function listLegacyApiKeys() {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, prefix, created_at, last_used_at FROM ${TABLE}
     WHERE user_id IS NULL ORDER BY created_at DESC`
  );
  return result.rows;
}

/** Retire every legacy row at once. Returns how many were removed. */
export async function revokeLegacyApiKeys(): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const result = await pool.query(`DELETE FROM ${TABLE} WHERE user_id IS NULL`);
  return result.rowCount ?? 0;
}

/**
 * Mint a scoped key for one user. One row per (user, scope): minting again for
 * the same pair REPLACES the previous key, which is also how a user rotates.
 *
 * Returns the full key — the only time it is visible in clear.
 */
export async function createScopedApiKey({
  userId,
  scope,
  name,
}: {
  userId: string;
  scope: ApiKeyScope;
  name?: string | null;
}) {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  if (!isApiKeyScope(scope)) throw new Error(`Unknown API key scope: ${scope}`);

  const key = generateApiKey();
  const id = crypto.randomUUID();
  const prefix = key.slice(0, 12) + '...' + key.slice(-4);
  const keyHash = hmacKey(key);
  const label = (name || '').trim() || `${scope} key`;

  const replace = async (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => {
    await q.query(`DELETE FROM ${TABLE} WHERE user_id = $1 AND scope = $2`, [userId, scope]);
    await q.query(
      `INSERT INTO ${TABLE} (id, key_hash, prefix, created_at, hash_version, user_id, scope, name)
       VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7)`,
      [id, keyHash, prefix, CURRENT_HASH_VERSION, userId, scope, label]
    );
  };

  if (typeof pool.connect === 'function') {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await replace(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } else {
    await replace(pool);
  }

  return { id, key, prefix, scope, name: label };
}

/** The caller's own scoped keys, metadata only. */
export async function listApiKeysForUser(userId: string) {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, prefix, scope, name, created_at, last_used_at FROM ${TABLE}
     WHERE user_id = $1 AND hash_version = $2
     ORDER BY created_at DESC`,
    [userId, CURRENT_HASH_VERSION]
  );
  return result.rows;
}

/**
 * Revoke one of the caller's own scoped keys.
 *
 * `user_id` is part of the WHERE clause rather than checked afterwards, so a
 * caller passing someone else's key id deletes nothing and is told "not found"
 * — never "forbidden", which would confirm the id exists.
 */
export async function revokeScopedApiKey(id: string, userId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(`DELETE FROM ${TABLE} WHERE id = $1 AND user_id = $2`, [
    id,
    userId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Record that a key was just used. Best-effort and deliberately not awaited by
 * the auth path: a write failure must never turn into a failed authentication.
 */
export async function touchApiKey(id: string): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE ${TABLE} SET last_used_at = NOW() WHERE id = $1`, [id]);
  } catch {
    // Non-fatal: last_used_at is reporting, not authorization.
  }
}

// Exposed for tests only.
export const __testing = { hmacKey, safeHexEqual, CURRENT_HASH_VERSION };
