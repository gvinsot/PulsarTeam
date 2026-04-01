import express from 'express';
import { getSettings, updateSettings, getWorkflow } from '../services/configManager.js';

export function settingsRoutes() {
  const router = express.Router();

  // ── General settings ──────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const settings = await getSettings();
      res.json(settings);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/', async (req, res) => {
    try {
      const settings = await updateSettings(req.body || {});
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Workflow configuration ────────────────────────────────────────
  // GET /workflow — get default board workflow (read-only)
  router.get('/workflow', async (req, res) => {
    try {
      const workflow = await getWorkflow('_default');
      res.json(workflow);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}
