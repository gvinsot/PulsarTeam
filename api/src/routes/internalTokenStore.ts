import express from 'express';
import {
  storeOAuthToken,
  fetchOAuthTokenWithDbFallback,
  deleteOAuthToken,
} from '../services/database/oauthTokens.js';
import type { OAuthProvider, OAuthTokenRecord } from '../services/database/oauthTokens.js';
import { getPool } from '../services/database/connection.js';
import { tryDecrypt } from '../lib/crypto.js';

/**
 * Shared token-store routes for the internal runner endpoints
 * (/claude-tokens, /codex-tokens): GET/POST/DELETE /:ownerId against the
 * oauth_tokens store under scope_type='user'.
 *
 * Only the provider, the GET response shape (serialize), and the POST body
 * parsing (parse) differ between the two; everything else — the ownerId guard,
 * the store, and the read-back verification — is identical.
 */

const SCOPE_TYPE = 'user';

/**
 * Read the token back from the DB and confirm it decrypts to what we just wrote.
 *
 * storeOAuthToken swallows DB write errors (the in-memory cache always holds
 * the new token). Claude refresh tokens rotate, so the runner must learn when
 * the rotated token was NOT durably persisted and retry — otherwise it is lost
 * on the next API restart. No pool means a deliberately DB-less deployment:
 * memory IS the store, so treat it as persisted.
 */
async function verifyPersisted(provider: OAuthProvider, ownerId: string, accessToken: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return true;
  try {
    const result = await pool.query(
      'SELECT access_token FROM oauth_tokens WHERE provider = $1 AND scope_type = $2 AND scope_id = $3',
      [provider, SCOPE_TYPE, ownerId]
    );
    return result.rows.length > 0 && tryDecrypt(result.rows[0].access_token) === accessToken;
  } catch {
    return false;
  }
}

export interface TokenStoreShape {
  /** GET response body built from the stored record. */
  serialize: (record: OAuthTokenRecord) => Record<string, any>;
  /**
   * Parse the POST body into the fields to store, or null when invalid
   * (route then returns 400 { error: 'accessToken required' }).
   */
  parse: (body: any) => {
    accessToken: string;
    refreshToken?: string | null;
    expiresAt?: number | null;
    meta?: Record<string, any>;
  } | null;
}

export function internalTokenRoutes(provider: OAuthProvider, shape: TokenStoreShape): express.Router {
  const router = express.Router();

  router.get('/:ownerId', async (req, res) => {
    const { ownerId } = req.params;
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    // DB fallback so a sibling deployment that wrote the token a moment ago
    // (or that this replica started before) is still resolvable.
    const record = await fetchOAuthTokenWithDbFallback(provider, SCOPE_TYPE, ownerId);
    if (!record) return res.status(404).json({ error: 'Token not found' });

    res.json(shape.serialize(record));
  });

  router.post('/:ownerId', async (req, res) => {
    const { ownerId } = req.params;
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    const parsed = shape.parse(req.body || {});
    if (!parsed) return res.status(400).json({ error: 'accessToken required' });

    await storeOAuthToken({
      provider,
      scopeType: SCOPE_TYPE,
      scopeId: ownerId,
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      meta: parsed.meta,
    });

    // Read back to verify durable persistence so the runner can retry.
    if (!(await verifyPersisted(provider, ownerId, parsed.accessToken))) {
      return res.status(500).json({ error: 'failed to persist token' });
    }

    res.json({ ok: true });
  });

  router.delete('/:ownerId', async (req, res) => {
    const { ownerId } = req.params;
    if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

    await deleteOAuthToken(provider, SCOPE_TYPE, ownerId);
    res.json({ ok: true });
  });

  return router;
}
