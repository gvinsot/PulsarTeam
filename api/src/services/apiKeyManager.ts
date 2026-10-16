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
 * ── Every row is SCOPED (`user_id` + `scope` both set) ──────────────────────
 *
 * Keys are minted by the user themselves. The key names its owner and its tool
 * set; it does NOT carry the owner's claims. `resolveApiKey` returns the owner
 * id and the middleware re-reads the user row on every request, so a demotion
 * or a deletion restricts the key on its very next use rather than whenever it
 * happens to be rotated.
 *
 *   – `admin` / `management`: one row per (user, scope), `board_id` NULL.
 *   – `insert`: bound to ONE board (`board_id` set), opens only task creation
 *     on that board. Several per user — one per integration — so each can be
 *     revoked on its own. The owner's edit access to the board is re-checked
 *     on every request too (middleware/apiKeyAuth.ts).
 *
 * The original ownerless instance-wide ("legacy") key has been removed for
 * good: migration 202610160001 deletes any such row, and a row that is not
 * cleanly scoped (no owner, no scope, an insert key without its board, a
 * ladder key WITH a board…) resolves to nothing and is refused everywhere.
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

/**
 * The tool sets a key can open. NOT roles: `admin` is the administrative TOOL
 * SET, and a key holding it is still bounded by what its owner may already
 * administer in the UI. The genuinely instance-wide tools check
 * `role === 'admin'` for themselves.
 *
 * `insert` is the narrowest: task creation on the one board the key is bound
 * to. It is off the ladder — see `scopeSatisfies`.
 */
export const API_KEY_SCOPES = ['admin', 'management', 'insert'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** The scopes that sit on the ladder: one key per (user, scope), no board. */
export const LADDER_API_KEY_SCOPES = ['admin', 'management'] as const;
export type LadderApiKeyScope = (typeof LADDER_API_KEY_SCOPES)[number];

/**
 * The scope ladder, one way only: an `admin` key opens the management surface,
 * a `management` key never opens the admin one.
 */
const SCOPE_RANK: Record<LadderApiKeyScope, number> = { management: 0, admin: 1 };

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * Does a key granted `granted` satisfy an endpoint demanding `required`?
 *
 * `insert` is off the ladder in BOTH directions. An insert key opens nothing
 * but the insert surface, however high the ladder is read. And no ladder key
 * opens the insert surface — not even `admin`: that surface takes its board
 * from the key, and a ladder key has none to give.
 */
export function scopeSatisfies(granted: ApiKeyScope, required: ApiKeyScope): boolean {
  if (granted === 'insert' || required === 'insert') return granted === required;
  return SCOPE_RANK[granted] >= SCOPE_RANK[required];
}

/** What `resolveApiKey` hands back. Never contains the owner's claims. */
export interface ResolvedApiKey {
  id: string;
  userId: string;
  scope: ApiKeyScope;
  /** The board an `insert` key is bound to; NULL for every other kind. */
  boardId: string | null;
  /** Column ids an `insert` key may write to; null = every column of its board. */
  allowedColumns: string[] | null;
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

const INTERNAL_TOKEN_PREFIX = 'swarm_int_';
const INTERNAL_TOKEN_TTL_MS = 5 * 60_000;

function internalSignature(payload: string): string {
  return crypto
    .createHmac('sha256', getHmacSecret())
    .update(`pulsarteam:internal-mcp-token:v1:${payload}`)
    .digest('base64url');
}

/**
 * Short-lived, stateless token letting the server call its own /api/mcp/<scope>
 * surface on behalf of a user who attached the built-in PulsarTeam plugin, with
 * no key to paste. It names only the owner and scope; the owner is re-read live
 * on every request, exactly like a stored scoped key.
 */
export function mintInternalMcpToken(userId: string, scope: LadderApiKeyScope): string {
  const payload = Buffer.from(
    JSON.stringify({ u: userId, s: scope, e: Date.now() + INTERNAL_TOKEN_TTL_MS })
  ).toString('base64url');
  return `${INTERNAL_TOKEN_PREFIX}${payload}.${internalSignature(payload)}`;
}

function resolveInternalToken(token: string): ResolvedApiKey | null {
  const [payload, sig, ...rest] = token.slice(INTERNAL_TOKEN_PREFIX.length).split('.');
  if (!payload || !sig || rest.length) return null;
  const expected = internalSignature(payload);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (typeof data.u !== 'string' || typeof data.e !== 'number' || data.e < Date.now()) {
      return null;
    }
    if (!(LADDER_API_KEY_SCOPES as readonly string[]).includes(data.s)) return null;
    return {
      id: 'internal',
      userId: data.u,
      scope: data.s,
      boardId: null,
      allowedColumns: null,
    };
  } catch {
    return null;
  }
}

/**
 * Resolve a presented key to its row, in constant time.
 *
 * Walks the full candidate set so the work done is independent of which (if
 * any) row matches, and only reads the matching row's metadata afterwards —
 * the comparison loop itself branches on nothing but the hash.
 */
export async function resolveApiKey(key: string): Promise<ResolvedApiKey | null> {
  if (typeof key === 'string' && key.startsWith(INTERNAL_TOKEN_PREFIX)) {
    return resolveInternalToken(key);
  }
  const pool = getPool();
  if (!pool) return null;
  if (typeof key !== 'string' || key.length === 0) return null;

  const candidate = hmacKey(key);

  const result = await pool.query(
    `SELECT id, key_hash, user_id, scope, board_id, allowed_columns FROM ${TABLE} WHERE hash_version = $1`,
    [CURRENT_HASH_VERSION]
  );

  let matched: Record<string, unknown> | null = null;
  for (const row of result.rows) {
    // Do not short-circuit — keep work constant across rows.
    if (safeHexEqual(candidate, row.key_hash)) matched = row;
  }
  if (!matched) return null;

  const userId = (matched.user_id as string | null) ?? null;
  const rawScope = matched.scope ?? null;
  const boardId = (matched.board_id as string | null) ?? null;

  // Scoped means every piece the scope needs is present, and nothing it does
  // not. An insert key names its board; a ladder key names none.
  const scoped =
    !!userId && isApiKeyScope(rawScope) && (rawScope === 'insert' ? !!boardId : !boardId);
  if (!scoped) {
    // Ownerless or half-written: refused everywhere rather than granted a
    // default tool set.
    return null;
  }
  return {
    id: matched.id as string,
    userId: userId as string,
    scope: rawScope as ApiKeyScope,
    boardId: rawScope === 'insert' ? boardId : null,
    allowedColumns:
      rawScope === 'insert' && Array.isArray(matched.allowed_columns)
        ? (matched.allowed_columns as unknown[]).filter((c): c is string => typeof c === 'string')
        : null,
  };
}

/**
 * Mint a ladder-scoped key for one user. One row per (user, scope): minting
 * again for the same pair REPLACES the previous key, which is also how a user
 * rotates.
 *
 * Returns the full key — the only time it is visible in clear.
 */
export async function createScopedApiKey({
  userId,
  scope,
  name,
}: {
  userId: string;
  scope: LadderApiKeyScope;
  name?: string | null;
}) {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  // `insert` is refused here on purpose: it needs a board, and replacing "the"
  // insert key would silently kill every other integration feeding a board.
  if (!(LADDER_API_KEY_SCOPES as readonly string[]).includes(scope)) {
    throw new Error(`Unknown API key scope: ${scope}`);
  }

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

  return { id, key, prefix, scope, name: label, board_id: null };
}

/**
 * Mint an `insert` key bound to one board. Never replaces anything: a user may
 * hold several for the same board (one per form, webhook or script), each
 * revoked on its own with `revokeScopedApiKey`.
 *
 * The CALLER must have proven the owner can edit `boardId` — this function
 * stores, it does not authorize. The proof is repeated on every request the
 * key makes (middleware/apiKeyAuth.ts), so a later unshare still bites.
 *
 * Returns the full key — the only time it is visible in clear.
 */
export async function createInsertApiKey({
  userId,
  boardId,
  name,
  allowedColumns = null,
}: {
  userId: string;
  boardId: string;
  name?: string | null;
  /** Column ids the key may write to; null = every column. Validated by the caller. */
  allowedColumns?: string[] | null;
}) {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');
  if (!boardId) throw new Error('An insert key must be bound to a board');

  const key = generateApiKey();
  const id = crypto.randomUUID();
  const prefix = key.slice(0, 12) + '...' + key.slice(-4);
  const keyHash = hmacKey(key);
  const label = (name || '').trim() || 'insert key';

  await pool.query(
    `INSERT INTO ${TABLE} (id, key_hash, prefix, created_at, hash_version, user_id, scope, name, board_id, allowed_columns)
     VALUES ($1, $2, $3, NOW(), $4, $5, $6, $7, $8, $9)`,
    [
      id,
      keyHash,
      prefix,
      CURRENT_HASH_VERSION,
      userId,
      'insert',
      label,
      boardId,
      allowedColumns ? JSON.stringify(allowedColumns) : null,
    ]
  );

  return {
    id,
    key,
    prefix,
    scope: 'insert' as const,
    name: label,
    board_id: boardId,
    allowed_columns: allowedColumns,
  };
}

/** The caller's own scoped keys (every kind), metadata only. */
export async function listApiKeysForUser(userId: string) {
  const pool = getPool();
  if (!pool) return [];
  // LEFT JOIN: the board name is display only. The cascade removes a key whose
  // board is deleted, so a NULL name here only means the join raced a delete.
  const result = await pool.query(
    `SELECT k.id, k.prefix, k.scope, k.name, k.board_id, b.name AS board_name,
            k.allowed_columns, k.created_at, k.last_used_at
     FROM ${TABLE} k LEFT JOIN boards b ON b.id = k.board_id
     WHERE k.user_id = $1 AND k.hash_version = $2
     ORDER BY k.created_at DESC`,
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
