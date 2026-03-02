import express from 'express';

export function leaderToolsRoutes(agentManager) {
  const router = express.Router();

  // Swarm Leader tool: read last message(s) from a specified agent
  // Query params:
  // - agentId: exact agent id
  // - agentName: exact agent name (case-insensitive)
  // - limit: number of last messages to return (1..50, default 1)
  router.get('/last-messages', (req, res) => {
    const { agentId, agentName, limit } = req.query;

    if (!agentId && !agentName) {
      return res.status(400).json({ error: 'agentId or agentName is required' });
    }

    const result = agentId
      ? agentManager.getLastMessages(agentId, limit ?? 1)
      : agentManager.getLastMessagesByName(agentName, limit ?? 1);

    if (!result) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    return res.json(result);
  });

  return router;
}