import express from 'express';
import { getBoardsByUser, getBoardById, createBoard, updateBoard, deleteBoard } from '../services/database.js';

const DEFAULT_BOARD_WORKFLOW = {
  columns: [
    { id: 'todo',        label: 'Todo',        color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done',        label: 'Done',        color: '#22c55e' },
  ],
  transitions: [],
  version: 1,
};

export function boardRoutes(agentManager) {
  const router = express.Router();

  // GET / — list all boards for the current user
  router.get('/', async (req, res) => {
    try {
      const boards = await getBoardsByUser(req.user.userId);
      res.json(boards);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/by-assignee/:agentId — all tasks assigned to an agent across all agents' todoLists
  router.get('/tasks/by-assignee/:agentId', async (req, res) => {
    try {
      const targetAgentId = req.params.agentId;
      const allAgents = agentManager.getAll();
      const tasks = [];
      for (const agent of allAgents) {
        for (const task of (agent.todoList || [])) {
          if (task.assignee === targetAgentId || (!task.assignee && agent.id === targetAgentId)) {
            tasks.push({
              ...task,
              _ownerId: agent.id,
              _ownerName: agent.name,
            });
          }
        }
      }
      res.json(tasks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id — get a specific board
  router.get('/:id', async (req, res) => {
    try {
      const board = await getBoardById(req.params.id);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      if (board.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });
      res.json(board);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST / — create a new board with clean default workflow
  router.post('/', async (req, res) => {
    try {
      const { name, workflow, filters } = req.body;
      const boardName = (name || 'My Board').slice(0, 100);

      // Use provided workflow if valid, otherwise use clean default (Todo / In Progress / Done)
      const boardWorkflow = (workflow && Array.isArray(workflow.columns) && workflow.columns.length > 0)
        ? { columns: workflow.columns, transitions: workflow.transitions || [], version: 1 }
        : JSON.parse(JSON.stringify(DEFAULT_BOARD_WORKFLOW));

      const board = await createBoard(req.user.userId, boardName, boardWorkflow, filters || {});
      res.status(201).json(board);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id — update a board (name, workflow, filters, position)
  router.put('/:id', async (req, res) => {
    try {
      const board = await getBoardById(req.params.id);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      if (board.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });

      const updated = await updateBoard(req.params.id, req.body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id/workflow — update board workflow specifically
  router.put('/:id/workflow', async (req, res) => {
    try {
      const board = await getBoardById(req.params.id);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      if (board.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });

      const workflow = req.body;
      if (!workflow || !workflow.columns) {
        return res.status(400).json({ error: 'Invalid workflow: must have columns' });
      }

      // Increment version
      const newWorkflow = {
        ...workflow,
        version: (board.workflow?.version || 0) + 1,
      };

      const updated = await updateBoard(req.params.id, { workflow: newWorkflow });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /:id — delete a board
  router.delete('/:id', async (req, res) => {
    try {
      const board = await getBoardById(req.params.id);
      if (!board) return res.status(404).json({ error: 'Board not found' });
      if (board.user_id !== req.user.userId) return res.status(403).json({ error: 'Access denied' });

      await deleteBoard(req.params.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
