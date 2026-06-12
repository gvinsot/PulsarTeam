import crypto from 'crypto';
import { getPool } from './database.js';
import { readSecret } from '../secrets.js';

const TABLE = 'api_keys';

// Bump when the hashing scheme changes. Rows with an older version are
// ignored by all queries, forcing the admin to mint a new key.
const CURRENT_HASH_VERSION = 2;

/**
 * Manages MCP API keys stored in PostgreSQL.
 * Only one active key exists at a time (singleton pattern).
 *
 * Storage scheme (v2):
 *   key_hash = HMAC-SHA256(api_key, server_secret)
 *
 * The server secret is read from API_KEY_SECRET (Docker secret or env). If
 * unset, it is deterministically derived from JWT_SECRET via HKDF so that
 * existing deployments do not require an extra secret to be provisioned.
 * Without the server secret, a database dump alone is not enough to validate
 * a key — the attacker also needs the secret.
 */

/** Resolve the HMAC secret used to fingerprint API keys. */
function getHmacSecret(): Buffer {
  const explicit = readSecret('API_KEY_SECRET', '');
  if (explicit) return Buffer.from(explicit, 'utf-8');

  const jwt = readSecret('JWT_SECRET', '');
  if (!jwt) {
    throw new Error(
      'API key HMAC secret is not configured (set API_KEY_SECRET or JWT_SECRET)'
    );
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
 * Get the current API key metadata (prefix only, never the full key).
 */
export async function getApiKeyInfo() {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, prefix, created_at FROM ${TABLE}
     WHERE hash_version = $1
     ORDER BY created_at DESC LIMIT 1`,
    [CURRENT_HASH_VERSION]
  );
  return result.rows[0] || null;
}

/**
 * Generate a new API key, replacing any existing one.
 * Returns the full key — this is the only time it is visible in clear.
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

  // Singleton: replace any existing key. DELETE+INSERT must be atomic — if the
  // INSERT fails after a committed DELETE, every external caller is locked out
  // until an admin mints and redistributes a new key.
  const replaceKey = async (q: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => {
    await q.query(`DELETE FROM ${TABLE}`);
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
 * Validate an API key in constant time against the stored HMAC.
 * Walks the full candidate set so the work done is independent of which
 * (if any) row matches.
 */
export async function validateApiKey(key: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  if (typeof key !== 'string' || key.length === 0) return false;

  const candidate = hmacKey(key);

  const result = await pool.query(
    `SELECT key_hash FROM ${TABLE} WHERE hash_version = $1`,
    [CURRENT_HASH_VERSION]
  );

  let matched = false;
  for (const row of result.rows) {
    // Do not short-circuit — keep work constant across rows.
    if (safeHexEqual(candidate, row.key_hash)) matched = true;
  }
  return matched;
}

/**
 * Delete the current API key (revoke access).
 */
export async function revokeApiKey() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`DELETE FROM ${TABLE}`);
}

// Exposed for tests only.
export const __testing = { hmacKey, safeHexEqual, CURRENT_HASH_VERSION };
