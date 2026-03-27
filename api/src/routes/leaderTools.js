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

  // Swarm Leader tool: get detailed status for a specific agent by name
  // Query params:
  // - agentName: agent name (case-insensitive)
  // - agentId: agent id (alternative to agentName)
  router.get('/agent-status', (req, res) => {
    const { agentId, agentName } = req.query;

    if (!agentId && !agentName) {
      return res.status(400).json({ error: 'agentId or agentName is required' });
    }

    let targetId = agentId;
    if (!targetId && agentName) {
      const agents = agentManager.getAll();
      const found = agents.find(a => a.name.toLowerCase() === agentName.toLowerCase());
      if (!found) return res.status(404).json({ error: 'Agent not found' });
      targetId = found.id;
    }

    const status = agentManager.getAgentStatus(targetId);
    if (!status) return res.status(404).json({ error: 'Agent not found' });
    return res.json(status);
  });

  // Swarm Leader tool: get lightweight status for ALL enabled agents
  // Returns an array of agent status objects (each includes project, currentTask, tasks, etc.)
  // Much lighter than GET /agents which returns full agent data with conversation history
  // Optional query param: ?project=ProjectName to filter by project
  router.get('/all-statuses', (req, res) => {
    const { project } = req.query;
    let statuses = agentManager.getAllStatuses(req.user.userId, req.user.role);

    // Optional project filter
    if (project) {
      const lowerProject = project.toLowerCase();
      statuses = statuses.filter(s =>
        (s.project || '').toLowerCase() === lowerProject
      );
    }

    return res.json(statuses);
  });

  // Swarm Leader tool: get swarm-wide status with project assignments
  router.get('/swarm-status', (req, res) => {
    return res.json(agentManager.getSwarmStatus(req.user.userId, req.user.role));
  });

  // Swarm Leader tool: get agents working on a specific project
  router.get('/by-project/:project', (req, res) => {
    const agents = agentManager.getAgentsByProject(req.params.project, req.user.userId, req.user.role);
    return res.json(agents);
  });

  // Swarm Leader tool: get project summary — all projects with their agent distribution
  router.get('/project-summary', (req, res) => {
    return res.json(agentManager.getProjectSummary(req.user.userId, req.user.role));
  });

  return router;
}
