import express from 'express';
import {
  getBoardsByUser, getBoardById, createBoard, updateBoard, deleteBoard,
  getBoardShares, getBoardShare, createBoardShare, updateBoardShare, deleteBoardShare,
  logBoardAudit, getBoardAuditLogs, getAllUsers,
} from '../services/database.js';

const DEFAULT_BOARD_WORKFLOW = {
  columns: [
    { id: 'todo',        label: 'Todo',        color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done',        label: 'Done',        color: '#22c55e' },
  ],
  transitions: [],
  version: 1,
};

const VALID_PERMISSIONS = ['read', 'edit', 'admin'];

// ── Permission helper ─────────────────────────────────────────────────────

/** Check if user has at least the required permission on a board.
 *  Returns { ok, permission, isOwner } or { ok: false, status, error }. */
async function checkBoardAccess(boardId, userId, userRole, requiredPermission = 'read') {
  const board = await getBoardById(boardId);
  if (!board) return { ok: false, status: 404, error: 'Board not found' };

  // Default board is accessible to all authenticated users (read-only for non-admins)
  if (board.is_default) {
    return { ok: true, board, permission: userRole === 'admin' ? 'admin' : 'read', isOwner: false };
  }

  // Owner has full access
  if (board.user_id === userId) {
    return { ok: true, board, permission: 'admin', isOwner: true };
  }

  // Admin users have full access
  if (userRole === 'admin') {
    return { ok: true, board, permission: 'admin', isOwner: false };
  }

  // Check sharing
  const share = await getBoardShare(boardId, userId);
  if (!share) return { ok: false, status: 403, error: 'Access denied' };

  const levels = { read: 0, edit: 1, admin: 2 };
  if ((levels[share.permission] || 0) < (levels[requiredPermission] || 0)) {
    return { ok: false, status: 403, error: `Requires ${requiredPermission} permission` };
  }

  return { ok: true, board, permission: share.permission, isOwner: false };
}

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
      const allAgents = agentManager.getAllForUser(req.user.userId, req.user.role);
      const tasks = [];
      for (const agent of allAgents) {
        for (const task of (agent.todoList || [])) {
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

  // GET /:id — get a specific board (owner + shared users + admins)
  router.get('/:id', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'read');
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      res.json({ ...access.board, _permission: access.permission, _isOwner: access.isOwner });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST / — create a new board
  router.post('/', async (req, res) => {
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
  router.put('/:id', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'edit');
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (access.board.is_default) return res.status(403).json({ error: 'Default board cannot be modified.' });

      const updated = await updateBoard(req.params.id, req.body);
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // PUT /:id/workflow — update board workflow (requires edit permission)
  router.put('/:id/workflow', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'edit');
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (access.board.is_default) return res.status(403).json({ error: 'Default board workflow cannot be modified.' });

      const workflow = req.body;
      if (!workflow || !workflow.columns) {
        return res.status(400).json({ error: 'Invalid workflow: must have columns' });
      }
      const newWorkflow = { ...workflow, version: (access.board.workflow?.version || 0) + 1 };
      const updated = await updateBoard(req.params.id, { workflow: newWorkflow });
      res.json(updated);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // DELETE /:id — delete a board (owner or admin only)
  router.delete('/:id', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'admin');
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      if (access.board.is_default) return res.status(403).json({ error: 'Default board cannot be deleted.' });
      if (!access.isOwner && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Only the board owner can delete it' });
      }

      await deleteBoard(req.params.id);
      await logBoardAudit(req.params.id, 'delete', req.user.userId, req.user.username, null, null, { name: access.board.name });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Sharing endpoints ─────────────────────────────────────────────────────

  // GET /:id/shares — list all shares for a board (owner or admin)
  router.get('/:id/shares', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'admin');
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const shares = await getBoardShares(req.params.id);
      res.json(shares);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /:id/shares — share a board with a user (owner or admin)
  router.post('/:id/shares', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'admin');
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { userId, username, permission } = req.body;
      if (!permission || !VALID_PERMISSIONS.includes(permission)) {
        return res.status(400).json({ error: 'Invalid permission. Must be: read, edit, or admin' });
      }

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
      if (targetUserId === access.board.user_id) {
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
  router.put('/:id/shares/:userId', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'admin');
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      const { permission } = req.body;
      if (!permission || !VALID_PERMISSIONS.includes(permission)) {
        return res.status(400).json({ error: 'Invalid permission. Must be: read, edit, or admin' });
      }

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
        const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'admin');
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
  router.get('/:id/audit', async (req, res) => {
    try {
      const access = await checkBoardAccess(req.params.id, req.user.userId, req.user.role, 'admin');
      if (!access.ok) return res.status(access.status).json({ error: access.error });
      const logs = await getBoardAuditLogs(req.params.id);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
