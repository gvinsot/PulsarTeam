import express from 'express';
import { z } from 'zod';
import { getAllBoards, getBoardById } from '../services/database.js';

const createTaskSchema = z.object({
  task: z.string().min(1).max(5000),
  project: z.string().min(1).max(200),
  status: z.string().optional(),
  board_id: z.string().uuid().optional(),
});

/**
 * REST API for external swarm access, secured via API key.
 *
 * GET  /api/swarm/agents           — List agents with status
 * GET  /api/swarm/agents/:id       — Get detailed agent status
 * POST /api/swarm/agents/:id/tasks — Add a task to an agent
 * GET  /api/swarm/boards           — List all boards
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
      openTasks: agentManager._getAgentTasks(a.id).filter(t => t.status !== 'done').length,
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
      todoList: agentManager._getAgentTasks(agent.id).map(t => ({
        id: t.id,
        text: t.text,
        status: t.status,
        project: t.project || null,
        boardId: t.boardId || null,
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

  // ── List boards ────────────────────────────────────────────────────────
  router.get('/boards', async (req, res) => {
    try {
      const boards = await getAllBoards();
      const result = boards.map(b => ({
        id: b.id,
        name: b.name,
        user: b.display_name || b.username || null,
        user_id: b.user_id,
        columns: (b.workflow?.columns || []).map(c => ({ id: c.id, label: c.label })),
      }));
      res.json({ count: result.length, boards: result });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Add task ───────────────────────────────────────────────────────────
  router.post('/agents/:id/tasks', async (req, res) => {
    console.log(`\u{1F4E5} [SwarmAPI] POST /agents/${req.params.id}/tasks \u2014 body:`, JSON.stringify(req.body));
    let task, project, status, board_id;
    try {
      ({ task, project, status, board_id } = createTaskSchema.parse(req.body));
    } catch (err) {
      console.warn(`\u26A0\uFE0F [SwarmAPI] Task validation failed for agent "${req.params.id}":`, err instanceof z.ZodError ? err.issues : err.message);
      if (err instanceof z.ZodError) {
        return res.status(400).json({ error: 'Validation failed', details: err.issues });
      }
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const agent = agentManager.agents.get(req.params.id)
      || Array.from(agentManager.agents.values()).find(
        a => a.name.toLowerCase() === req.params.id.toLowerCase()
      );

    if (!agent) {
      console.warn(`\u26A0\uFE0F [SwarmAPI] Agent not found: "${req.params.id}"`);
      return res.status(404).json({ error: 'Agent not found' });
    }

    // Auto-assign agent to the project if different from current assignment
    if (project !== agent.project) {
      agentManager.update(agent.id, { project });
    }

    // Resolve board_id: auto-pick if only one board exists
    let resolvedBoardId = board_id || null;
    if (!resolvedBoardId) {
      const boards = await getAllBoards();
      if (boards.length === 1) {
        resolvedBoardId = boards[0].id;
      } else if (boards.length > 1) {
        return res.status(400).json({
          error: 'Multiple boards exist. Please specify board_id. Use GET /api/swarm/boards to list them.',
          boards: boards.map(b => ({ id: b.id, name: b.name, user: b.display_name || b.username })),
        });
      }
    } else {
      const board = await getBoardById(resolvedBoardId);
      if (!board) {
        return res.status(404).json({ error: `Board not found: ${resolvedBoardId}` });
      }
    }

    const newTask = agentManager.addTask(agent.id, task, project, { type: 'api' }, status, { boardId: resolvedBoardId });
    console.log(`\u2705 [SwarmAPI] Task created for agent "${agent.name}" (${agent.id}) \u2014 task: ${newTask?.id}, project: ${project}, board: ${resolvedBoardId || '(none)'}`);

    res.status(201).json({
      success: true,
      task: newTask,
      agent: { id: agent.id, name: agent.name },
      board_id: resolvedBoardId,
    });
  });

  return router;
}
