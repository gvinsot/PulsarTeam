import express from 'express';
import { z } from 'zod';
import { errorMessage } from '../lib/errors.js';
import {
  API_KEY_SCOPES,
  createScopedApiKey,
  generateNewApiKey,
  getApiKeyInfo,
  listApiKeysForUser,
  listLegacyApiKeys,
  revokeApiKey,
  revokeLegacyApiKeys,
  revokeScopedApiKey,
  type ApiKeyScope,
} from '../services/apiKeyManager.js';
import { requireRole, sessionUser } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validateBody } from '../lib/validate.js';

/**
 * /api/settings/api-key — two panels, deliberately split by who owns what.
 *
 *  • `/` and `/legacy` are ADMIN-ONLY and manage the single ownerless
 *    instance-wide key: the original design, still accepted on /api/swarm/*
 *    so integrations do not break, and refused on every scoped endpoint. The
 *    `/legacy` pair exists so an operator can see that such a key is still
 *    outstanding and retire it once the integrations have moved.
 *
 *  • `/mine` is for EVERY authenticated user and manages their own scoped keys,
 *    one per (user, scope). These are what open /api/mcp/admin and
 *    /api/mcp/management. They are personal credentials: an admin cannot list,
 *    mint or read another user's keys through this router, which is the whole
 *    point of replacing the shared secret.
 */
const router = express.Router();

const createScopedKeySchema = z.object({
  scope: z.enum(API_KEY_SCOPES),
  name: z.string().max(200).optional(),
});

// ── Per-user scoped keys ────────────────────────────────────────────────────
// Mounted BEFORE the admin gate below, so a non-admin can still reach them.

// GET /api/settings/api-key/mine — the caller's own scoped keys (metadata only)
router.get(
  '/mine',
  asyncHandler(async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      res.json({ keys: await listApiKeysForUser(user.userId) });
    } catch (err) {
      console.error('Failed to list scoped API keys:', errorMessage(err));
      res.status(500).json({ error: 'Failed to list API keys' });
    }
  })
);

// POST /api/settings/api-key/mine — mint (or rotate) one scope's key.
// Returns the full key ONCE; minting again for the same scope replaces it.
router.post(
  '/mine',
  validateBody(createScopedKeySchema),
  asyncHandler(async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      const result = await createScopedApiKey({
        userId: user.userId,
        scope: req.body.scope as ApiKeyScope,
        name: req.body.name,
      });
      res.status(201).json(result);
    } catch (err) {
      console.error('Failed to create scoped API key:', errorMessage(err));
      res.status(500).json({ error: 'Failed to create API key' });
    }
  })
);

// DELETE /api/settings/api-key/mine/:id — revoke one of the caller's own keys.
// The owner is part of the delete predicate, so another user's key id simply
// matches nothing: the answer is "not found", never "forbidden", which would
// confirm the id exists.
router.delete(
  '/mine/:id',
  asyncHandler(async (req, res) => {
    const user = sessionUser(req, res);
    if (!user) return;
    try {
      const ok = await revokeScopedApiKey(req.params.id, user.userId);
      if (!ok) return res.status(404).json({ error: 'API key not found' });
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to revoke scoped API key:', errorMessage(err));
      res.status(500).json({ error: 'Failed to revoke API key' });
    }
  })
);

// ── Legacy instance-wide key (admin only) ──────────────────────────────────

router.use(requireRole('admin'));

// GET /api/settings/api-key/legacy — every outstanding ownerless key
router.get(
  '/legacy',
  asyncHandler(async (_req, res) => {
    try {
      res.json({ keys: await listLegacyApiKeys() });
    } catch (err) {
      console.error('Failed to list legacy API keys:', errorMessage(err));
      res.status(500).json({ error: 'Failed to list legacy API keys' });
    }
  })
);

// DELETE /api/settings/api-key/legacy — retire them all
router.delete(
  '/legacy',
  asyncHandler(async (_req, res) => {
    try {
      const revoked = await revokeLegacyApiKeys();
      res.json({ success: true, revoked });
    } catch (err) {
      console.error('Failed to revoke legacy API keys:', errorMessage(err));
      res.status(500).json({ error: 'Failed to revoke legacy API keys' });
    }
  })
);

// GET /api/settings/api-key — current legacy key info (prefix only)
router.get(
  '/',
  asyncHandler(async (_req, res) => {
    try {
      const info = await getApiKeyInfo();
      res.json({ apiKey: info });
    } catch (err) {
      console.error('Failed to get API key info:', errorMessage(err));
      res.status(500).json({ error: 'Failed to retrieve API key info' });
    }
  })
);

// POST /api/settings/api-key — generate a new legacy key (returns full key once)
router.post(
  '/',
  asyncHandler(async (_req, res) => {
    try {
      const result = await generateNewApiKey();
      res.json(result);
    } catch (err) {
      console.error('Failed to generate API key:', errorMessage(err));
      res.status(500).json({ error: 'Failed to generate API key' });
    }
  })
);

// DELETE /api/settings/api-key — revoke the legacy key
router.delete(
  '/',
  asyncHandler(async (_req, res) => {
    try {
      await revokeApiKey();
      res.json({ success: true });
    } catch (err) {
      console.error('Failed to revoke API key:', errorMessage(err));
      res.status(500).json({ error: 'Failed to revoke API key' });
    }
  })
);

export { router as apiKeyRoutes };
