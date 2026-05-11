import express from 'express';
import {
  storeOAuthToken,
  getOAuthToken,
  deleteOAuthToken,
} from '../services/database/oauthTokens.js';

const router = express.Router();
const PROVIDER = 'claude_code';
const SCOPE_TYPE = 'user';

router.get('/:ownerId', (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

  const record = getOAuthToken(PROVIDER, SCOPE_TYPE, ownerId);
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

  res.json({ ok: true });
});

router.delete('/:ownerId', async (req, res) => {
  const { ownerId } = req.params;
  if (!ownerId) return res.status(400).json({ error: 'ownerId required' });

  await deleteOAuthToken(PROVIDER, SCOPE_TYPE, ownerId);
  res.json({ ok: true });
});

export const internalClaudeTokenRoutes = () => router;
