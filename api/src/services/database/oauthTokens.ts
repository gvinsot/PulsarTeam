import pg from 'pg';
import { getPool } from './connection.js';
import { encryptIfPlain, tryDecrypt } from '../../lib/crypto.js';

/**
 * Unified OAuth token store.
 *
 * Replaces the per-plugin in-memory Maps with a single DB-backed table.
 * Tokens are scoped by (provider, scope_type, scope_id):
 *   - provider:   'gmail' | 'gdrive' | 'onedrive' | 'outlook' | 'slack' | 'github' | 'jira' | 's3' | 'wordpress'
 *   - scope_type: 'agent' | 'board' | 'user'
 *   - scope_id:   agentId | boardId | userId
 *
 * The table has no `environment` column on purpose: when two deployments share
 * the same database (e.g. prod + qa), they share the OAuth token pool — tasks
 * are env-scoped but credentials follow the user/board/agent across envs.
 *
 * In-memory cache for fast lookups (populated from DB on startup). Cross-replica
 * sync is handled via PostgreSQL LISTEN/NOTIFY on the `oauth_token_change`
 * channel: every write fires NOTIFY, every replica refreshes the affected key.
 * As a defence in depth, callers in the hot path (resolveAccessToken,
 * fetchOAuthTokenWithDbFallback) read through to the DB on cache miss so a
 * notification dropped or a replica started before a write still resolves.
 */

export type OAuthProvider = 'gmail' | 'gdrive' | 'onedrive' | 'outlook' | 'slack' | 'github' | 'jira' | 's3' | 'wordpress' | 'claude_code' | 'codex';
export type ScopeType = 'agent' | 'board' | 'user';

export interface OAuthTokenRecord {
  provider: OAuthProvider;
  scopeType: ScopeType;
  scopeId: string;
  accessToken: string;
  refreshToken?: string | null;
  expiresAt?: number | null;
  meta?: Record<string, any>;
}

// In-memory cache: "provider:scope_type:scope_id" → token record
const tokenCache = new Map<string, OAuthTokenRecord>();

function cacheKey(provider: string, scopeType: string, scopeId: string): string {
  return `${provider}:${scopeType}:${scopeId}`;
}

const NOTIFY_CHANNEL = 'oauth_token_change';

/** Fire a NOTIFY so every API replica sharing this DB refreshes its cache. */
async function notifyTokenChange(provider: string, scopeType: string, scopeId: string, op: 'upsert' | 'delete'): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`SELECT pg_notify($1, $2)`, [
      NOTIFY_CHANNEL,
      JSON.stringify({ provider, scopeType, scopeId, op }),
    ]);
  } catch (err) {
    console.error('[OAuthStore] pg_notify failed:', (err as Error).message);
  }
}

/** Read one record straight from the DB (used as a fallback when the cache is cold/stale). */
async function loadOAuthTokenFromDb(provider: OAuthProvider, scopeType: ScopeType, scopeId: string): Promise<OAuthTokenRecord | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT provider, scope_type, scope_id, access_token, refresh_token, expires_at, meta FROM oauth_tokens WHERE provider = $1 AND scope_type = $2 AND scope_id = $3',
      [provider, scopeType, scopeId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const record: OAuthTokenRecord = {
      provider: row.provider,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      accessToken: tryDecrypt(row.access_token),
      refreshToken: tryDecrypt(row.refresh_token),
      expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
      meta: row.meta || {},
    };
    tokenCache.set(cacheKey(provider, scopeType, scopeId), record);
    return record;
  } catch (err) {
    console.error('[OAuthStore] loadOAuthTokenFromDb failed:', (err as Error).message);
    return null;
  }
}

/**
 * Cache-first lookup that falls back to the DB on miss. Use this in any hot
 * path where stale cache would break the feature (e.g. token resolution for an
 * outbound API call, the runner fetching its claude_code token). Lightweight
 * boolean status checks can keep using the synchronous getOAuthToken.
 */
export async function fetchOAuthTokenWithDbFallback(
  provider: OAuthProvider,
  scopeType: ScopeType,
  scopeId: string
): Promise<OAuthTokenRecord | null> {
  const cached = getOAuthToken(provider, scopeType, scopeId);
  if (cached) return cached;
  return await loadOAuthTokenFromDb(provider, scopeType, scopeId);
}

/**
 * Store (upsert) an OAuth token.
 *
 * The in-memory cache is always updated. DB persistence failures are logged
 * and swallowed by default (token-refresh hot paths must keep serving from
 * the just-updated cache); pass `throwOnPersistError: true` in user-facing
 * connect/callback flows so the user is told the connection will not survive
 * a restart instead of getting a false success.
 */
export async function storeOAuthToken(
  record: OAuthTokenRecord,
  opts: { throwOnPersistError?: boolean } = {}
): Promise<void> {
  const key = cacheKey(record.provider, record.scopeType, record.scopeId);
  tokenCache.set(key, record);

  const pool = getPool();
  if (!pool) {
    if (opts.throwOnPersistError) {
      throw new Error(`OAuth token (${key}) not persisted: database not connected`);
    }
    return;
  }

  try {
    await pool.query(
      `INSERT INTO oauth_tokens (provider, scope_type, scope_id, access_token, refresh_token, expires_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (provider, scope_type, scope_id)
       DO UPDATE SET access_token = $4, refresh_token = COALESCE($5, oauth_tokens.refresh_token),
                     expires_at = $6, meta = COALESCE($7::jsonb, oauth_tokens.meta),
                     updated_at = NOW()`,
      [
        record.provider,
        record.scopeType,
        record.scopeId,
        encryptIfPlain(record.accessToken),
        encryptIfPlain(record.refreshToken || null),
        record.expiresAt ? new Date(record.expiresAt).toISOString() : null,
        record.meta ? JSON.stringify(record.meta) : null,
      ]
    );
    await notifyTokenChange(record.provider, record.scopeType, record.scopeId, 'upsert');
  } catch (err) {
    console.error(`[OAuthStore] Failed to persist token (${key}):`, (err as Error).message);
    if (opts.throwOnPersistError) throw err;
  }
}

/** Get an OAuth token by (provider, scopeType, scopeId). */
export function getOAuthToken(provider: OAuthProvider, scopeType: ScopeType, scopeId: string): OAuthTokenRecord | null {
  const key = cacheKey(provider, scopeType, scopeId);
  return tokenCache.get(key) || null;
}

/** Check if a token exists and is not expired (or is refreshable for providers with refresh tokens). */
export function hasOAuthToken(provider: OAuthProvider, scopeType: ScopeType, scopeId: string): boolean {
  const token = getOAuthToken(provider, scopeType, scopeId);
  if (!token) return false;
  if (!token.expiresAt) return true; // non-expiring tokens (Slack, GitHub)
  // Consider valid if not expired, or if a refresh token exists (can be refreshed)
  return token.expiresAt > Date.now() || !!token.refreshToken;
}

/** Delete an OAuth token. */
export async function deleteOAuthToken(provider: OAuthProvider, scopeType: ScopeType, scopeId: string): Promise<void> {
  const key = cacheKey(provider, scopeType, scopeId);
  tokenCache.delete(key);

  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      'DELETE FROM oauth_tokens WHERE provider = $1 AND scope_type = $2 AND scope_id = $3',
      [provider, scopeType, scopeId]
    );
    await notifyTokenChange(provider, scopeType, scopeId, 'delete');
  } catch (err) {
    console.error(`[OAuthStore] Failed to delete token (${key}):`, (err as Error).message);
  }
}

/** Delete all tokens for a given scope (e.g., when deleting an agent or board). */
export async function deleteOAuthTokensByScope(scopeType: ScopeType, scopeId: string): Promise<void> {
  const affectedProviders: string[] = [];
  for (const [key, record] of tokenCache) {
    if (key.includes(`:${scopeType}:${scopeId}`)) {
      tokenCache.delete(key);
      affectedProviders.push(record.provider);
    }
  }

  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      'DELETE FROM oauth_tokens WHERE scope_type = $1 AND scope_id = $2',
      [scopeType, scopeId]
    );
    for (const provider of affectedProviders) {
      await notifyTokenChange(provider, scopeType, scopeId, 'delete');
    }
  } catch (err) {
    console.error(`[OAuthStore] Failed to delete tokens for ${scopeType}:${scopeId}:`, (err as Error).message);
  }
}

/** Get all tokens for a scope (e.g., all plugins connected to a board). */
export function getOAuthTokensByScope(scopeType: ScopeType, scopeId: string): OAuthTokenRecord[] {
  const results: OAuthTokenRecord[] = [];
  const suffix = `:${scopeType}:${scopeId}`;
  for (const [key, record] of tokenCache) {
    if (key.endsWith(suffix)) {
      results.push(record);
    }
  }
  return results;
}

/**
 * Resolve an access token with fallback chain: agent → board → user.
 * For providers with refresh tokens (Gmail, OneDrive), auto-refresh if expired.
 * The refreshFn is provider-specific and handles token refresh.
 */
export async function resolveAccessToken(
  provider: OAuthProvider,
  agentId: string | null,
  boardId: string | null,
  refreshFn?: (record: OAuthTokenRecord) => Promise<string>
): Promise<string> {
  const scopes: Array<{ type: ScopeType; id: string }> = [];
  if (agentId) scopes.push({ type: 'agent', id: agentId });
  if (boardId) scopes.push({ type: 'board', id: boardId });
  // user-level fallback: scan for any 'user' scoped tokens
  scopes.push({ type: 'user', id: '__any__' });

  for (const scope of scopes) {
    let token: OAuthTokenRecord | null = null;

    if (scope.id === '__any__') {
      // Scan for any user-scoped token for this provider. Falls through to a
      // DB query when the cache has none — covers the cross-replica case where
      // env A persisted a user-scoped token but env B hasn't seen the NOTIFY yet.
      for (const [key, record] of tokenCache) {
        if (key.startsWith(`${provider}:user:`)) {
          token = record;
          break;
        }
      }
      if (!token) {
        const pool = getPool();
        if (pool) {
          try {
            const result = await pool.query(
              'SELECT provider, scope_type, scope_id, access_token, refresh_token, expires_at, meta FROM oauth_tokens WHERE provider = $1 AND scope_type = $2 LIMIT 1',
              [provider, 'user']
            );
            if (result.rows.length > 0) {
              const row = result.rows[0];
              token = {
                provider: row.provider,
                scopeType: row.scope_type,
                scopeId: row.scope_id,
                accessToken: tryDecrypt(row.access_token),
                refreshToken: tryDecrypt(row.refresh_token),
                expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
                meta: row.meta || {},
              };
              tokenCache.set(cacheKey(token.provider, token.scopeType, token.scopeId), token);
            }
          } catch (err) {
            console.error('[OAuthStore] resolveAccessToken user-scope DB fallback failed:', (err as Error).message);
          }
        }
      }
    } else {
      token = await fetchOAuthTokenWithDbFallback(provider, scope.type, scope.id);
    }

    if (!token) continue;

    // Check expiry and refresh if needed
    if (token.expiresAt && Date.now() >= token.expiresAt) {
      if (refreshFn && token.refreshToken) {
        try {
          return await refreshFn(token);
        } catch {
          continue; // refresh failed, try next scope
        }
      }
      continue; // expired with no refresh capability
    }

    return token.accessToken;
  }

  throw new Error(`Not connected to ${provider}. Please authenticate first.`);
}

/** Load all tokens from the DB into the in-memory cache (called on startup). */
export async function loadOAuthTokens(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  try {
    const result = await pool.query(
      'SELECT provider, scope_type, scope_id, access_token, refresh_token, expires_at, meta FROM oauth_tokens'
    );

    tokenCache.clear();
    let skipped = 0;
    for (const row of result.rows) {
      // Per-row guard: one undecryptable row (e.g. written with a different
      // ENCRYPTION_KEY by a sibling deployment) must not abort the whole load.
      try {
        const record: OAuthTokenRecord = {
          provider: row.provider,
          scopeType: row.scope_type,
          scopeId: row.scope_id,
          accessToken: tryDecrypt(row.access_token),
          refreshToken: tryDecrypt(row.refresh_token),
          expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null,
          meta: row.meta || {},
        };
        const key = cacheKey(record.provider, record.scopeType, record.scopeId);
        tokenCache.set(key, record);
      } catch (err) {
        skipped++;
        console.error(`[OAuthStore] Skipping token ${row.provider}:${row.scope_type}:${row.scope_id}:`, (err as Error).message);
      }
    }
    if (skipped > 0) {
      console.warn(`[OAuthStore] ${skipped} token(s) skipped: undecryptable with the current ENCRYPTION_KEY`);
    }

    if (tokenCache.size > 0) {
      console.log(`✅ Loaded ${tokenCache.size} OAuth token(s) from database`);
    }
  } catch (err) {
    console.error('[OAuthStore] Failed to load tokens:', (err as Error).message);
  }

  // Subscribe to oauth_token_change so sibling replicas (e.g. prod + qa sharing
  // the same DB) keep their in-memory caches in sync after each write.
  await startOAuthTokenListener();
}

let _listenerClient: pg.PoolClient | null = null;
let _listenerReconnectTimer: NodeJS.Timeout | null = null;

async function startOAuthTokenListener(): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  if (_listenerClient) return; // already listening

  try {
    const client = await pool.connect();
    _listenerClient = client;

    client.on('notification', (msg: pg.Notification) => {
      if (msg.channel !== NOTIFY_CHANNEL || !msg.payload) return;
      let payload: { provider: string; scopeType: string; scopeId: string; op: 'upsert' | 'delete' };
      try {
        payload = JSON.parse(msg.payload);
      } catch {
        return;
      }
      const key = cacheKey(payload.provider, payload.scopeType, payload.scopeId);
      if (payload.op === 'delete') {
        if (tokenCache.delete(key)) {
          console.log(`[OAuthStore] cache evict via NOTIFY: ${key}`);
        }
        return;
      }
      // upsert: reload the affected key from DB (best effort)
      loadOAuthTokenFromDb(payload.provider as OAuthProvider, payload.scopeType as ScopeType, payload.scopeId)
        .then((rec) => {
          if (rec) console.log(`[OAuthStore] cache refresh via NOTIFY: ${key}`);
        })
        .catch(() => { /* already logged inside */ });
    });

    client.on('error', (err: Error) => {
      console.error('[OAuthStore] LISTEN client error:', err.message);
      // Drop the dead handle; schedule reconnect.
      try { client.release(true); } catch { /* ignore */ }
      _listenerClient = null;
      scheduleListenerReconnect();
    });

    await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    console.log(`[OAuthStore] LISTEN ${NOTIFY_CHANNEL} active (cross-replica cache sync)`);
  } catch (err) {
    console.error('[OAuthStore] Failed to start LISTEN:', (err as Error).message);
    // Return the checked-out client to the pool (destructively) — without this
    // every failed attempt leaks a client until the pool is exhausted. The
    // try/catch absorbs a double release when the 'error' handler already ran.
    try { _listenerClient?.release(true); } catch { /* ignore */ }
    _listenerClient = null;
    scheduleListenerReconnect();
  }
}

function scheduleListenerReconnect(): void {
  if (_listenerReconnectTimer) return;
  _listenerReconnectTimer = setTimeout(() => {
    _listenerReconnectTimer = null;
    startOAuthTokenListener().catch(() => { /* logged inside */ });
  }, 5000);
  // Don't keep the process alive just for this reconnect timer.
  _listenerReconnectTimer.unref?.();
}

/** Get the raw cache (for debugging/status endpoints). */
export function getOAuthTokenCache(): Map<string, OAuthTokenRecord> {
  return tokenCache;
}
