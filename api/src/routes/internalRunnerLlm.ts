import express from 'express';
import { getLlmConfig } from '../services/database.js';
import { getSettings } from '../services/configManager.js';

/**
 * Internal endpoint consumed by the runner service to resolve the
 * "fallback LLM" used when the Claude paid-plan interactive driver
 * encounters a Y/N or list prompt it doesn't have a hardcoded answer for.
 *
 * The runner authenticates with the shared CODER_API_KEY.
 *
 * Response (200):
 *   { configured: true, endpoint, apiKey, model, provider }
 * Response when admin hasn't selected one:
 *   { configured: false }
 */
export function internalRunnerLlmRoutes() {
  const router = express.Router();

  router.get('/claude-fallback', async (_req, res) => {
    try {
      const settings = await getSettings();
      const id = (settings.claudeFallbackLlmConfigId || '').toString().trim();
      if (!id) return res.json({ configured: false });

      const cfg = await getLlmConfig(id);
      if (!cfg) {
        return res.json({ configured: false, error: 'configured-id-missing' });
      }

      res.json({
        configured: true,
        endpoint: cfg.endpoint || '',
        apiKey: cfg.apiKey || '',
        model: cfg.model || '',
        provider: cfg.provider || '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  return router;
}
