import express from 'express';
import { getJiraSyncStatus, fullSync, getJiraColumns, handleWebhook, verifyWebhook } from '../services/jiraSync.js';

export function jiraRoutes(agentManager) {
  const router = express.Router();

  // GET /jira/status — sync status for UI
  router.get('/status', (req, res) => {
    res.json(getJiraSyncStatus());
  });

  // GET /jira/columns — Jira board columns (for workflow config dropdowns)
  router.get('/columns', async (req, res) => {
    try {
      const columns = await getJiraColumns();
      res.json(columns);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /jira/sync — trigger manual sync
  router.post('/sync', async (req, res) => {
    try {
      await fullSync(agentManager);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}

/**
 * Jira webhook endpoint — mounted WITHOUT JWT auth (Jira can't authenticate).
 * Secured via X-Jira-Webhook-Secret header.
 */
export function jiraWebhookRoute(agentManager) {
  const router = express.Router();

  router.post('/', async (req, res) => {
    if (!verifyWebhook(req)) {
      return res.status(401).json({ error: 'Invalid webhook secret' });
    }

    try {
      await handleWebhook(req.body, agentManager);
      res.status(200).json({ ok: true });
    } catch (err) {
      console.error('[Jira] Webhook handler error:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
