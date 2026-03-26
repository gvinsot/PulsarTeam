import express from 'express';
import { getBoardsByUser, getBoardById, createBoard, updateBoard, deleteBoard } from '../services/database.js';
import { getWorkflow } from '../services/configManager.js';

export function boardRoutes() {
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

  // GET /tasks/by-assignee/:agentId — all tasks assigned to an agent across all boards
  router.get('/tasks/by-assignee/:agentId', async (req, res) => {
    try {
      const boards = await getBoardsByUser(req.user.userId);
      const tasks = [];
      for (const board of boards) {
        for (const col of (board.workflow?.columns || [])) {
          for (const task of (col.tasks || [])) {
            if (task.assignee === req.params.agentId) {
              tasks.push({
                ...task,
                boardId: board.id,
                boardName: board.name,
                columnId: col.id,
                columnName: col.name,
              });
            }
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

  // POST / — create a new board (optionally clone from default workflow)
  router.post('/', async (req, res) => {
    try {
      const { name, workflow, filters } = req.body;
      const boardName = (name || 'My Board').slice(0, 100);

      // If no workflow provided, copy the default workflow
      let boardWorkflow = workflow;
      if (!boardWorkflow || !boardWorkflow.columns) {
        const defaultWf = await getWorkflow('_default');
        boardWorkflow = {
          columns: defaultWf.columns,
          transitions: defaultWf.transitions,
          version: 1,
        };
      }

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
