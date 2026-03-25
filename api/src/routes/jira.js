import express from 'express';
import { getJiraSyncStatus, fullSync, getJiraColumns, handleWebhook, verifyWebhook, getJiraIssueDetails, addCommentToJira, analyzeAndCommentJira } from '../services/jiraSync.js';

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

  // GET /jira/issue/:jiraKey — fetch full issue details
  router.get('/issue/:jiraKey', async (req, res) => {
    try {
      const details = await getJiraIssueDetails(req.params.jiraKey);
      if (!details) return res.status(404).json({ error: 'Issue not found or Jira not configured' });
      res.json(details);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /jira/comment/:jiraKey — post a comment to a Jira issue
  router.post('/comment/:jiraKey', async (req, res) => {
    const { comment } = req.body;
    if (!comment) return res.status(400).json({ error: 'comment is required' });
    try {
      const success = await addCommentToJira(req.params.jiraKey, comment);
      res.json({ success });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /jira/ai-comment/:jiraKey — trigger AI analysis and post as comment
  router.post('/ai-comment/:jiraKey', async (req, res) => {
    const { instructions, role } = req.body || {};
    const jiraKey = req.params.jiraKey;

    // Find the task linked to this Jira key
    let task = null;
    let agentId = null;
    for (const [id, agent] of agentManager.agents) {
      const found = (agent.todoList || []).find(t => t.jiraKey === jiraKey);
      if (found) {
        task = found;
        agentId = id;
        break;
      }
    }

    try {
      await analyzeAndCommentJira(jiraKey, task || { text: jiraKey }, agentId, agentManager, instructions || '', role || '');
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
    console.log(`[Jira] Webhook received: ${req.headers['content-type']} | event=${req.body?.webhookEvent || 'unknown'} | issue=${req.body?.issue?.key || 'none'} | auth-header=${req.headers['x-automation-webhook-token'] ? 'present' : 'missing'}`);

    if (!verifyWebhook(req)) {
      console.warn('[Jira] Webhook rejected: invalid or missing secret');
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
