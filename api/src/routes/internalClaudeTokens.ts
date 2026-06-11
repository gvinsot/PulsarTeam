import express from 'express';
import {
  storeOAuthToken,
  fetchOAuthTokenWithDbFallback,
  deleteOAuthToken,
} from '../services/database/oauthTokens.js';
import { getPool } from '../services/database/connection.js';
import { tryDecrypt } from '../lib/crypto.js';

const router = express.Router();
const PROVIDER = 'claude_code';
const SCOPE_TYPE = 'user';

router.get('/:ownerId', async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

  // DB fallback so a sibling deployment that wrote the token a moment ago
  // (or that this replica started before) is still resolvable.
  const record = await fetchOAuthTokenWithDbFallback(PROVIDER, SCOPE_TYPE, ownerId);
  if (!record) return res.status(404).json({ error: 'Token not found' });

  res.json({
    accessToken: record.accessToken,
    refreshToken: record.refreshToken || null,
    expiresAt: record.expiresAt || null,
  });
});

router.post('/:ownerId', async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

  const { accessToken, refreshToken, expiresIn, expiresAt } = req.body || {};
  if (!accessToken || typeof accessToken !== 'string') {
    return res.status(400).json({ error: 'accessToken required' });
  }

  let expiresAtMs: number | null = null;
  if (typeof expiresAt === 'number') {
    expiresAtMs = expiresAt;
  } else if (typeof expiresIn === 'number') {
    expiresAtMs = Date.now() + expiresIn * 1000;
  }

  await storeOAuthToken({
    provider: PROVIDER,
    scopeType: SCOPE_TYPE,
    scopeId: ownerId,
    accessToken,
    refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : null,
    expiresAt: expiresAtMs,
  });

  // storeOAuthToken swallows DB write errors (the in-memory cache always
  // holds the new token). Claude refresh tokens rotate, so the runner must
  // learn when the rotated token was NOT durably persisted and retry —
  // otherwise it is lost on the next API restart. Read back to verify.
  // No pool means a deliberately DB-less deployment: memory IS the store.
  const pool = getPool();
  if (pool) {
    let persisted = false;
    try {
      const result = await pool.query(
        'SELECT access_token FROM oauth_tokens WHERE provider = $1 AND scope_type = $2 AND scope_id = $3',
        [PROVIDER, SCOPE_TYPE, ownerId]
      );
      persisted = result.rows.length > 0 && tryDecrypt(result.rows[0].access_token) === accessToken;
    } catch {
      persisted = false;
    }
    if (!persisted) {
      return res.status(500).json({ error: 'failed to persist token' });
    }
  }

  res.json({ ok: true });
});

router.delete('/:ownerId', async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

  await deleteOAuthToken(PROVIDER, SCOPE_TYPE, ownerId);
  res.json({ ok: true });
});

export const internalClaudeTokenRoutes = () => router;
