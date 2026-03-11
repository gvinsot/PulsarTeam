import express from 'express';
import { getApiKeyInfo, generateNewApiKey, revokeApiKey } from '../services/apiKeyManager.js';

const router = express.Router();

// GET /api/settings/api-key — get current key info (prefix only)
router.get('/', async (req, res) => {
  try {
    const info = await getApiKeyInfo();
    res.json({ apiKey: info });
  } catch (err) {
    console.error('Failed to get API key info:', err.message);
    res.status(500).json({ error: 'Failed to retrieve API key info' });
  }
});

// POST /api/settings/api-key — generate a new key (returns full key once)
router.post('/', async (req, res) => {
  try {
    const result = await generateNewApiKey();
    res.json(result);
  } catch (err) {
    console.error('Failed to generate API key:', err.message);
    res.status(500).json({ error: 'Failed to generate API key' });
  }
});

// DELETE /api/settings/api-key — revoke current key
router.delete('/', async (req, res) => {
  try {
    await revokeApiKey();
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to revoke API key:', err.message);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

export { router as apiKeyRoutes };
