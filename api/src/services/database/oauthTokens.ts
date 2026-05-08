import { getPool } from './connection.js';
import { encryptIfPlain, tryDecrypt } from '../../lib/crypto.js';

/**
 * Unified OAuth token store.
 *
 * Replaces the per-plugin in-memory Maps with a single DB-backed table.
 * Tokens are scoped by (provider, scope_type, scope_id):
 *   - provider:   'gmail' | 'onedrive' | 'slack' | 'github' | 'jira' | 's3'
 *   - scope_type: 'agent' | 'board' | 'user'
 *   - scope_id:   agentId | boardId | userId
 *
 * In-memory cache for fast lookups (populated from DB on startup).
 */

export type OAuthProvider = 'gmail' | 'onedrive' | 'slack' | 'github' | 'jira' | 's3';
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

/** Store (upsert) an OAuth token. */
export async function storeOAuthToken(record: OAuthTokenRecord): Promise<void> {
  const key = cacheKey(record.provider, record.scopeType, record.scopeId);
  tokenCache.set(key, record);

  const pool = getPool();
  if (!pool) return;

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
  } catch (err) {
    console.error(`[OAuthStore] Failed to persist token (${key}):`, (err as Error).message);
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
  } catch (err) {
    console.error(`[OAuthStore] Failed to delete token (${key}):`, (err as Error).message);
  }
}

/** Delete all tokens for a given scope (e.g., when deleting an agent or board). */
export async function deleteOAuthTokensByScope(scopeType: ScopeType, scopeId: string): Promise<void> {
  for (const [key] of tokenCache) {
    if (key.includes(`:${scopeType}:${scopeId}`)) {
      tokenCache.delete(key);
    }
  }

  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      'DELETE FROM oauth_tokens WHERE scope_type = $1 AND scope_id = $2',
      [scopeType, scopeId]
    );
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
      // Scan for any user-scoped token for this provider
      for (const [key, record] of tokenCache) {
        if (key.startsWith(`${provider}:user:`)) {
          token = record;
          break;
        }
      }
    } else {
      token = getOAuthToken(provider, scope.type, scope.id);
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
    for (const row of result.rows) {
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
    }

    if (tokenCache.size > 0) {
      console.log(`✅ Loaded ${tokenCache.size} OAuth token(s) from database`);
    }
  } catch (err) {
    console.error('[OAuthStore] Failed to load tokens:', (err as Error).message);
  }
}

/** Get the raw cache (for debugging/status endpoints). */
export function getOAuthTokenCache(): Map<string, OAuthTokenRecord> {
  return tokenCache;
}
