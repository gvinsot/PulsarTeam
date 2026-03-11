import crypto from 'crypto';
import { getPool } from './database.js';

const TABLE = 'api_keys';

/**
 * Manages MCP API keys stored in PostgreSQL.
 * Only one active key exists at a time (singleton pattern).
 */

export async function ensureApiKeysTable() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      id TEXT PRIMARY KEY,
      key_hash TEXT NOT NULL,
      prefix TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

function hashKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function generateApiKey() {
  // Format: swarm_sk_<32 hex chars>
  return `swarm_sk_${crypto.randomBytes(32).toString('hex')}`;
}

/**
 * Get the current API key metadata (prefix only, never the full key).
 */
export async function getApiKeyInfo() {
  const pool = getPool();
  if (!pool) return null;

  const result = await pool.query(
    `SELECT id, prefix, created_at FROM ${TABLE} ORDER BY created_at DESC LIMIT 1`
  );
  return result.rows[0] || null;
}

/**
 * Generate a new API key, replacing any existing one.
 * Returns the full key (only time it's visible).
 */
export async function generateNewApiKey() {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  // Delete all existing keys
  await pool.query(`DELETE FROM ${TABLE}`);

  const key = generateApiKey();
  const id = crypto.randomUUID();
  const prefix = key.slice(0, 12) + '...' + key.slice(-4);

  await pool.query(
    `INSERT INTO ${TABLE} (id, key_hash, prefix, created_at) VALUES ($1, $2, $3, NOW())`,
    [id, hashKey(key), prefix]
  );

  return { id, key, prefix };
}

/**
 * Validate an API key against the stored hash.
 */
export async function validateApiKey(key) {
  const pool = getPool();
  if (!pool) return false;

  const hash = hashKey(key);
  const result = await pool.query(
    `SELECT id FROM ${TABLE} WHERE key_hash = $1 LIMIT 1`,
    [hash]
  );
  return result.rows.length > 0;
}

/**
 * Delete the current API key (revoke access).
 */
export async function revokeApiKey() {
  const pool = getPool();
  if (!pool) return;

  await pool.query(`DELETE FROM ${TABLE}`);
}
