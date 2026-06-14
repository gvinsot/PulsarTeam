import express from 'express';
import {
  getBoardsByUser, createBoard, updateBoard, deleteBoard,
  getBoardShares, createBoardShare, updateBoardShare, deleteBoardShare,
  logBoardAudit, getBoardAuditLogs, getAllUsers, getAllBoards,
} from '../services/database.js';
import { checkBoardAccess, authorizeBoardAccess } from '../middleware/auth.js';
import { validateBody } from '../lib/validate.js';
import {
  createBoardSchema,
  updateBoardSchema,
  updateWorkflowSchema,
  updatePluginsSchema,
  pluginAssignSchema,
  mcpAuthSchema,
  createShareSchema,
  updateShareSchema,
} from '../schemas/boards.js';

const DEFAULT_BOARD_WORKFLOW = {
  columns: [
    { id: 'todo', label: 'Todo', color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done', label: 'Done', color: '#22c55e' },
  ],
  transitions: [
    {
      from: 'in_progress',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { type: 'run_agent', mode: 'decide', role: '', instructions: 'Execute the task fully, and when you are finished, update the task to next state.' },
        { type: 'change_status', target: '__next__' },
      ],
    },
  ],
  version: 1,
};


export function boardRoutes(agentManager) {
  const router = express.Router();

  // GET / — list all boards for the current user (owned + shared)
  router.get('/', async (req, res) => {
    try {
      const boards = await getBoardsByUser(req.user.userId);
      res.json(boards);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /tasks/by-assignee/:agentId
  router.get('/tasks/by-assignee/:agentId', async (req, res) => {
    try {
      const targetAgentId = req.params.agentId;
      const boards = await getBoardsByUser(req.user.userId);
      const userBoardIds = new Set(boards.map(b => b.id));
      const allAgents = agentManager.getAllForUser(req.user.userId, req.user.role, userBoardIds);
      const tasks = [];
      for (const agent of allAgents) {
        for (const task of agentManager._getAgentTasks(agent.id)) {
          if (task.assignee === targetAgentId || (!task.assignee && agent.id === targetAgentId)) {
            tasks.push({ ...task, _ownerId: agent.id, _ownerName: agent.name });
          }
        }
      }
      res.json(tasks);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /users — list all users (for share autocomplete)
  router.get('/users', async (req, res) => {
    try {
      const users = await getAllUsers();
      // Don't expose passwords — getAllUsers already only selects id, username, display_name, role
      res.json(users);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /all — admin-only: list ALL boards across all users (for Processes view)
  router.get('/all', async (req, res) => {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
      }
      const boards = await getAllBoards();
      res.json(boards);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id — get a specific board (owner + shared users + admins)
  router.get('/:id', authorizeBoardAccess('read'), async (req, res) => {
    try {
      const { board, permission, isOwner } = req.boardAccess;
      res.json({ ...board, _permission: permission, _isOwner: isOwner });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST / — create a new board
  router.post('/', validateBody(createBoardSchema), async (req, res) => {
    try {
      const { name, workflow, filters } = req.body;
      const boardName = (name || 'My Board').slice(0, 100);
      const boardWorkflow = (workflow && Array.isArray(workflow.columns) && workflow.columns.length > 0)
        ? { columns: workflow.columns, transitions: workflow.transitions || [], version: 1 }
        : JSON.parse(JSON.stringify(DEFAULT_BOARD_WORKFLOW));
      const board = await createBoard(req.user.userId, boardName, boardWorkflow, filters || {});
      await logBoardAudit(board.id, 'create', req.user.userId, req.user.username, null, null, { name: boardName });
      res.status(201).json(board);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id — update a board (requires edit permission)
  router.put('/:id', validateBody(updateBoardSchema), authorizeBoardAccess('edit'), async (req, res) => {
    try {
      if (req.boardAccess.board.is_default) return res.status(403).json({ error: 'Default board cannot be modified.' });

      const updated = await updateBoard(req.params.id, req.body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id/workflow — update board workflow (requires edit permission)
  router.put('/:id/workflow', validateBody(updateWorkflowSchema), authorizeBoardAccess('edit'), async (req, res) => {
    try {
      const { board } = req.boardAccess;
      if (board.is_default) return res.status(403).json({ error: 'Default board workflow cannot be modified.' });

      const workflow = req.body;
      const newWorkflow = { ...workflow, version: (board.workflow?.version || 0) + 1 };
      const updated = await updateBoard(req.params.id, { workflow: newWorkflow });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Board Plugins ─────────────────────────────────────────────────────

  // GET /:id/plugins — get board plugins
  router.get('/:id/plugins', authorizeBoardAccess('read'), async (req, res) => {
    try {
      const { board } = req.boardAccess;
      res.json({
        plugins: board.plugins || [],
        mcpAuth: board.mcp_auth || {},
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id/plugins — update board plugins (skill IDs array)
  router.put('/:id/plugins', validateBody(updatePluginsSchema), authorizeBoardAccess('edit'), async (req, res) => {
    try {
      const { plugins } = req.body;
      const updated = await updateBoard(req.params.id, { plugins });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/plugins/assign — add a plugin to the board
  router.post('/:id/plugins/assign', validateBody(pluginAssignSchema), authorizeBoardAccess('edit'), async (req, res) => {
    try {
      const { board } = req.boardAccess;
      const { pluginId } = req.body;

      const currentPlugins = Array.isArray(board.plugins) ? board.plugins : [];
      if (currentPlugins.includes(pluginId)) {
        return res.json(board); // already assigned
      }
      const updated = await updateBoard(req.params.id, { plugins: [...currentPlugins, pluginId] });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/plugins/remove — remove a plugin from the board
  router.post('/:id/plugins/remove', validateBody(pluginAssignSchema), authorizeBoardAccess('edit'), async (req, res) => {
    try {
      const { board } = req.boardAccess;
      const { pluginId } = req.body;

      const currentPlugins = Array.isArray(board.plugins) ? board.plugins : [];
      const updated = await updateBoard(req.params.id, {
        plugins: currentPlugins.filter(id => id !== pluginId),
      });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id/mcp-auth — update board MCP auth config
  router.put('/:id/mcp-auth', validateBody(mcpAuthSchema), authorizeBoardAccess('edit'), async (req, res) => {
    try {
      const updated = await updateBoard(req.params.id, { mcp_auth: req.body });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /:id — delete a board (owner or admin only)
  router.delete('/:id', authorizeBoardAccess('admin'), async (req, res) => {
    try {
      const { board, isOwner } = req.boardAccess;
      if (board.is_default) return res.status(403).json({ error: 'Default board cannot be deleted.' });
      if (!isOwner && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only the board owner can delete it' });
      }

      await deleteBoard(req.params.id);
      await logBoardAudit(req.params.id, 'delete', req.user.userId, req.user.username, null, null, { name: board.name });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sharing endpoints ─────────────────────────────────────────────────────

  // GET /:id/shares — list all shares for a board (owner or admin)
  router.get('/:id/shares', authorizeBoardAccess('admin'), async (req, res) => {
    try {
      const shares = await getBoardShares(req.params.id);
      res.json(shares);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/shares — share a board with a user (owner or admin)
  router.post('/:id/shares', validateBody(createShareSchema), authorizeBoardAccess('admin'), async (req, res) => {
    try {
      const { board } = req.boardAccess;
      const { userId, username, permission } = req.body;

      // Resolve user — accept userId or username
      let targetUserId = userId;
      let targetUsername = username;
      if (!targetUserId && targetUsername) {
        const users = await getAllUsers();
        const user = users.find(u => u.username.toLowerCase() === targetUsername.toLowerCase());
        if (!user) return res.status(404).json({ error: `User "${targetUsername}" not found` });
        targetUserId = user.id;
        targetUsername = user.username;
      }
      if (!targetUserId) return res.status(400).json({ error: 'userId or username is required' });

      // Can't share with yourself
      if (targetUserId === req.user.userId) {
        return res.status(400).json({ error: 'Cannot share a board with yourself' });
      }

      // Can't share with the board owner
      if (targetUserId === board.user_id) {
        return res.status(400).json({ error: 'Cannot share with the board owner' });
      }

      const share = await createBoardShare(req.params.id, targetUserId, permission, req.user.userId);
      await logBoardAudit(req.params.id, 'share', req.user.userId, req.user.username, targetUserId, targetUsername, { permission });

      res.status(201).json(share);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id/shares/:userId — update a share's permission (owner or admin)
  router.put('/:id/shares/:userId', validateBody(updateShareSchema), authorizeBoardAccess('admin'), async (req, res) => {
    try {
      const { permission } = req.body;

      const updated = await updateBoardShare(req.params.id, req.params.userId, permission);
      if (!updated) return res.status(404).json({ error: 'Share not found' });

      await logBoardAudit(req.params.id, 'update_permission', req.user.userId, req.user.username, req.params.userId, null, { permission });

      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /:id/shares/:userId — revoke a share (owner, admin, or the shared user themselves)
  router.delete('/:id/shares/:userId', async (req, res) => {
    try {
      // Users can remove themselves from a shared board
      const isSelf = req.params.userId === req.user.userId;
      if (!isSelf) {
        const access = await checkBoardAccess(req.params.id as string, req.user.userId, req.user.role, 'admin');
        if (!access.ok) return res.status(access.status).json({ error: access.error });
      }

      const ok = await deleteBoardShare(req.params.id, req.params.userId);
      if (!ok) return res.status(404).json({ error: 'Share not found' });

      await logBoardAudit(req.params.id, isSelf ? 'leave' : 'revoke', req.user.userId, req.user.username, req.params.userId, null);

      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /:id/audit — view audit logs for a board (owner or admin)
  router.get('/:id/audit', authorizeBoardAccess('admin'), async (req, res) => {
    try {
      const logs = await getBoardAuditLogs(req.params.id);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
