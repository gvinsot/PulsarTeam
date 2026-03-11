import express from 'express';

/**
 * REST API for external swarm access, secured via API key.
 *
 * GET  /api/swarm/agents           — List agents with status
 * GET  /api/swarm/agents/:id       — Get detailed agent status
 * POST /api/swarm/agents/:id/tasks — Add a task to an agent
 */
export function swarmApiRoutes(agentManager) {
  const router = express.Router();

  // ── List agents ────────────────────────────────────────────────────────
  router.get('/agents', (req, res) => {
    const { project, status } = req.query;
    const allAgents = Array.from(agentManager.agents.values());
    let agents = allAgents.filter(a => a.enabled !== false);

    if (project) {
      agents = agents.filter(a => a.project === project);
    }
    if (status) {
      agents = agents.filter(a => a.status === status);
    }

    const result = agents.map(a => ({
      id: a.id,
      name: a.name,
      role: a.role,
      status: a.status,
      project: a.project || null,
      currentTask: a.currentTask || null,
      pendingTasks: (a.todoList || []).filter(t => t.status === 'pending').length,
      totalMessages: a.metrics?.totalMessages || 0,
    }));

    res.json({ count: result.length, agents: result });
  });

  // ── Get agent status ───────────────────────────────────────────────────
  router.get('/agents/:id', (req, res) => {
    const agent = agentManager.agents.get(req.params.id)
      || Array.from(agentManager.agents.values()).find(
        a => a.name.toLowerCase() === req.params.id.toLowerCase()
      );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      description: agent.description,
      status: agent.status,
      project: agent.project || null,
      currentTask: agent.currentTask || null,
      enabled: agent.enabled !== false,
      todoList: (agent.todoList || []).map(t => ({
        id: t.id,
        text: t.text,
        status: t.status,
        project: t.project || null,
        createdAt: t.createdAt,
        completedAt: t.completedAt || null,
      })),
      metrics: {
        totalMessages: agent.metrics?.totalMessages || 0,
        totalTokensIn: agent.metrics?.totalTokensIn || 0,
        totalTokensOut: agent.metrics?.totalTokensOut || 0,
        totalErrors: agent.metrics?.totalErrors || 0,
      },
    });
  });

  // ── Add task ───────────────────────────────────────────────────────────
  router.post('/agents/:id/tasks', (req, res) => {
    const { task, project } = req.body;
    if (!task) {
      return res.status(400).json({ error: 'task field is required' });
    }

    const agent = agentManager.agents.get(req.params.id)
      || Array.from(agentManager.agents.values()).find(
        a => a.name.toLowerCase() === req.params.id.toLowerCase()
      );

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    const todo = agentManager.addTodo(agent.id, task, project || undefined);

    res.status(201).json({
      success: true,
      todo,
      agent: { id: agent.id, name: agent.name },
    });
  });

  return router;
}
