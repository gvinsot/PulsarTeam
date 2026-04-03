import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { Octokit } from '@octokit/rest';
import { getPool, getBoardById, rowToTask } from '../services/database.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Check if the authenticated user has access to a task's owning agent */
function requireTaskAccess(mgr, task, user) {
  if (user.role === 'admin') return true;
  const agent = mgr.agents.get(task.agentId);
  if (!agent) return true; // agent deleted — allow access
  if (agent.ownerId && agent.ownerId !== user.userId) return false;
  return true;
}

/** Log an audit event for task operations */
async function auditLog(action, taskId, userId, username, details = null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO task_audit_logs (task_id, action, user_id, username, details)
       VALUES ($1, $2, $3, $4, $5)`,
      [taskId, action, userId, username, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('Failed to write task audit log:', err.message);
  }
}

/** Validate destination board access (exists + user has write permission) */
async function validateBoardAccess(boardId, userId, userRole) {
  if (!boardId) return { ok: true, board: null };
  const board = await getBoardById(boardId);
  if (!board) return { ok: false, error: 'Destination board not found', status: 404 };
  if (board.user_id !== userId && !board.is_default && userRole !== 'admin') {
    return { ok: false, error: 'No write access to destination board', status: 403 };
  }
  return { ok: true, board };
}

/** Validate that a column exists in a board; fallback to first column */
function validateColumn(board, columnId) {
  if (!board?.workflow?.columns?.length) return columnId;
  const exists = board.workflow.columns.some(c => c.id === columnId);
  if (exists) return columnId;
  return board.workflow.columns[0].id;
}

// ── GET /tasks — list all tasks (from the tasks table) ─────────────────────
router.get('/', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json([]);

    const { board_id, agent_id, status } = req.query;
    let query = 'SELECT * FROM tasks WHERE deleted_at IS NULL';
    const params = [];

    if (board_id) {
      params.push(board_id);
      query += ` AND board_id = $${params.length}`;
    }
    if (agent_id) {
      params.push(agent_id);
      query += ` AND agent_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND status = $${params.length}`;
    }

    query += ' ORDER BY created_at';
    const result = await pool.query(query, params);

    // Enrich with agent name
    const mgr = req.app.get('agentManager');
    const tasks = result.rows.map(row => {
      const task = rowToTask(row);
      const agent = mgr.agents.get(task.agentId);
      task.agentName = agent?.name || null;
      // Resolve assignee name
      if (task.assignee) {
        const assigneeAgent = mgr.agents.get(task.assignee);
        task.assigneeName = assigneeAgent?.name || null;
        task.assigneeIcon = assigneeAgent?.icon || null;
      }
      return task;
    });

    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /tasks/:id — update a task ──────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { title, description, column, agentId, type, priority, dueDate, boardId } = req.body;
    const now = new Date().toISOString();
    const username = req.user?.username || 'user';

    // ── Block column/board move when an agent is actively processing ─────
    const wantsColumnChange = column !== undefined && column !== task.status;
    const wantsBoardChange = boardId !== undefined && boardId !== (task.boardId || null);
    if (task.actionRunning && (wantsColumnChange || wantsBoardChange)) {
      return res.status(409).json({ error: 'Cannot move task while an agent is processing it. Stop the agent first.' });
    }

    // Track what changed for history / notifications
    const oldBoardId = task.boardId || null;
    const oldStatus = task.status;
    let boardChanged = false;
    let statusChanged = false;
    let oldBoardName = null;
    let newBoardName = null;
    const editedFields = [];

    // ── Board move with permission check ───────────────────────────────────
    if (boardId !== undefined && boardId !== oldBoardId) {
      const access = await validateBoardAccess(boardId, req.user.userId, req.user.role);
      if (!access.ok) return res.status(access.status).json({ error: access.error });

      if (oldBoardId) {
        const oldBoard = await getBoardById(oldBoardId);
        oldBoardName = oldBoard?.name || null;
      }
      newBoardName = access.board?.name || null;
      boardChanged = true;
      task.boardId = boardId;

      // Validate/reset column for the new board
      if (column !== undefined && access.board) {
        task.status = validateColumn(access.board, column);
      } else if (access.board) {
        task.status = access.board.workflow?.columns?.[0]?.id || task.status;
      }
      if (task.status !== oldStatus) {
        statusChanged = true;
      }
    } else if (column !== undefined && column !== task.status) {
      statusChanged = true;
      task.status = column;
    }

    // ── Update other fields ────────────────────────────────────────────────
    if (title !== undefined && title !== task.title) { task.title = title; editedFields.push('title'); }
    if (description !== undefined && description !== task.text) { task.text = description; editedFields.push('description'); }
    if (agentId !== undefined && agentId !== task.assignee) { task.assignee = agentId; editedFields.push('assignee'); }
    if (type !== undefined && type !== task.taskType) { task.taskType = type; editedFields.push('taskType'); }
    if (priority !== undefined && priority !== task.priority) { task.priority = priority; editedFields.push('priority'); }
    if (dueDate !== undefined && dueDate !== task.dueDate) { task.dueDate = dueDate; editedFields.push('dueDate'); }
    task.updatedAt = now;

    // ── History entry ──────────────────────────────────────────────────────
    const hasChanges = boardChanged || statusChanged || editedFields.length > 0;
    if (hasChanges) {
      if (!task.history) task.history = [];
      const entry = {
        at: now,
        by: username,
        type: boardChanged ? 'board_move' : 'edit',
        status: task.status,
        fields: [...editedFields],
      };
      if (boardChanged) {
        entry.fromBoard = oldBoardId;
        entry.toBoard = task.boardId;
        entry.fromBoardName = oldBoardName;
        entry.toBoardName = newBoardName;
      }
      if (statusChanged) {
        entry.from = oldStatus;
        entry.fields.push('status');
      }
      task.history.push(entry);
    }

    // ── Sync changes back to in-memory task (getTask returns a copy) ────
    const memAgent = mgr.agents.get(task.agentId);
    if (memAgent) {
      const memTask = mgr._getAgentTasks(task.agentId).find(t => t.id === req.params.id);
      if (memTask) {
        if (title !== undefined) memTask.title = task.title;
        if (description !== undefined) memTask.text = task.text;
        if (boardChanged || column !== undefined) memTask.status = task.status;
        if (boardId !== undefined) memTask.boardId = task.boardId;
        if (agentId !== undefined) memTask.assignee = task.assignee;
        if (type !== undefined) memTask.taskType = task.taskType;
        if (priority !== undefined) memTask.priority = task.priority;
        if (dueDate !== undefined) memTask.dueDate = task.dueDate;
        memTask.updatedAt = task.updatedAt;
      }
    }

    mgr.saveTaskDirectly(task);

    // ── Notifications ──────────────────────────────────────────────────────
    if (boardChanged) {
      mgr._emit('task:moved', {
        taskId: task.id,
        fromBoard: oldBoardId,
        toBoard: task.boardId,
        fromBoardName: oldBoardName,
        toBoardName: newBoardName,
        column: task.status,
        movedBy: username,
      });
    }
    mgr._emit('task:updated', task);
    if (task.agentId) {
      const agent = mgr.agents.get(task.agentId);
      if (agent) mgr._emit('agent:updated', mgr._sanitize(agent));
    }

    await auditLog('update', req.params.id, req.user.userId, username, {
      boardChanged, statusChanged,
      editedFields,
      fromBoard: boardChanged ? oldBoardId : undefined,
      toBoard: boardChanged ? task.boardId : undefined,
    });

    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /tasks/bulk-move — move multiple tasks to another board/column ──────
router.post('/bulk-move', async (req, res) => {
  try {
    const { taskIds, boardId, column } = req.body;
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return res.status(400).json({ error: 'taskIds must be a non-empty array' });
    }
    if (!boardId) {
      return res.status(400).json({ error: 'boardId is required' });
    }

    const mgr = req.app.get('agentManager');
    const username = req.user?.username || 'user';

    const access = await validateBoardAccess(boardId, req.user.userId, req.user.role);
    if (!access.ok) return res.status(access.status).json({ error: access.error });

    const targetColumn = column
      ? validateColumn(access.board, column)
      : access.board?.workflow?.columns?.[0]?.id || 'todo';

    const now = new Date().toISOString();
    const results = { moved: [], failed: [] };

    for (const taskId of taskIds) {
      const task = mgr.getTask(taskId);
      if (!task) { results.failed.push({ taskId, error: 'Task not found' }); continue; }
      if (!requireTaskAccess(mgr, task, req.user)) { results.failed.push({ taskId, error: 'Access denied' }); continue; }
      if (task.actionRunning) { results.failed.push({ taskId, error: 'Task is being processed by an agent. Stop the agent first.' }); continue; }

      const oldBoardId = task.boardId;
      const oldStatus = task.status;
      let oldBoardName = null;
      if (oldBoardId) { const ob = await getBoardById(oldBoardId); oldBoardName = ob?.name || null; }

      task.boardId = boardId;
      task.status = targetColumn;
      task.updatedAt = now;
      if (!task.history) task.history = [];
      task.history.push({
        at: now, by: username, type: 'board_move',
        fromBoard: oldBoardId, toBoard: boardId,
        fromBoardName: oldBoardName, toBoardName: access.board?.name || null,
        from: oldStatus, status: targetColumn,
        fields: ['boardId', 'status'], bulk: true,
      });

      mgr.saveTaskDirectly(task);
      mgr._emit('task:updated', task);
      if (task.agentId) {
        const agent = mgr.agents.get(task.agentId);
        if (agent) mgr._emit('agent:updated', mgr._sanitize(agent));
      }
      results.moved.push({ taskId: task.id, title: task.title || task.text?.slice(0, 60) });
    }

    mgr._emit('task:bulk-moved', {
      boardId, boardName: access.board?.name || null,
      column: targetColumn, count: results.moved.length, movedBy: username,
    });

    await auditLog('bulk_move', null, req.user.userId, username, {
      boardId, column: targetColumn, movedCount: results.moved.length, failedCount: results.failed.length,
    });

    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /tasks/:id — soft delete ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Block deletion of tasks being executed by a busy agent
    const agent = mgr.agents.get(task.agentId);
    if (task.startedAt && mgr._isActiveTaskStatus(task.status) && agent?.status === 'busy') {
      return res.status(409).json({ error: 'Task is being executed. Stop the agent first.' });
    }

    const ok = mgr.deleteTask(task.agentId, req.params.id, req.user.userId);
    if (!ok) return res.status(404).json({ error: 'Task not found' });

    // Record deleted_by in the database
    const pool = getPool();
    if (pool) {
      await pool.query(
        'UPDATE tasks SET deleted_by = $1 WHERE id = $2',
        [req.user.userId, req.params.id]
      ).catch(() => {});
    }

    await auditLog('soft_delete', req.params.id, req.user.userId, req.user.username, {
      taskTitle: task.title || task.text?.slice(0, 100),
      agentId: task.agentId,
    });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /tasks/deleted — list soft-deleted tasks (admin only) ───────────────
router.get('/deleted', requireRole('admin'), async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const deleted = await mgr.getDeletedTasks();
    res.json(deleted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /tasks/:id/restore — restore a soft-deleted task (admin only) ──────
router.post('/:id/restore', requireRole('admin'), async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const restored = await mgr.restoreTask(req.params.id);
    if (!restored) return res.status(404).json({ error: 'Deleted task not found' });

    await auditLog('restore', req.params.id, req.user.userId, req.user.username, {
      taskTitle: restored.title || restored.text?.slice(0, 100),
      agentId: restored.agentId,
    });

    res.json(restored);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /tasks/:id/permanent — permanently delete (admin only) ───────────
router.delete('/:id/permanent', requireRole('admin'), async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');

    await auditLog('hard_delete', req.params.id, req.user.userId, req.user.username);

    const ok = await mgr.hardDeleteTask(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Task not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /tasks/:id/history — view task modification history ─────────────────
router.get('/:id/history', async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(task.history || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /tasks/stats — task statistics ──────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json({ total: 0, active: 0, deleted: 0, deletionRate: 0 });

    const [totalResult, activeResult, deletedResult, recentDeletedResult] = await Promise.all([
      pool.query('SELECT COUNT(*) as count FROM tasks'),
      pool.query('SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NULL'),
      pool.query('SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NOT NULL'),
      pool.query('SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at >= NOW() - INTERVAL \'30 days\''),
    ]);

    const total = parseInt(totalResult.rows[0].count, 10);
    const active = parseInt(activeResult.rows[0].count, 10);
    const deleted = parseInt(deletedResult.rows[0].count, 10);
    const recentDeleted = parseInt(recentDeletedResult.rows[0].count, 10);

    res.json({
      total,
      active,
      deleted,
      deletionRate30d: total > 0 ? Math.round((recentDeleted / total) * 10000) / 100 : 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /tasks/audit — view audit logs (admin only) ─────────────────────────
router.get('/audit', requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json([]);

    const limit = Math.min(Math.max(parseInt(req.query.limit) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset) || 0, 0);

    const result = await pool.query(
      `SELECT * FROM task_audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /tasks/purge — purge tasks deleted more than 90 days ago (admin only)
router.post('/purge', requireRole('admin'), async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json({ purged: 0 });

    const retentionDays = parseInt(req.query.days) || 90;
    const result = await pool.query(
      'DELETE FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at < NOW() - INTERVAL \'1 day\' * $1',
      [retentionDays]
    );

    const purged = result.rowCount || 0;
    await auditLog('bulk_purge', null, req.user.userId, req.user.username, {
      retentionDays,
      purgedCount: purged,
    });

    res.json({ purged });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Helper: extract owner/repo from task context ────────────────────────────
function resolveOwnerRepo(task, mgr) {
  if (task.project && task.project.includes('/')) {
    const [owner, repo] = task.project.split('/');
    if (owner && repo) return { owner, repo };
  }
  if (task.githubIssue?.owner && task.githubIssue?.repo) {
    return { owner: task.githubIssue.owner, repo: task.githubIssue.repo };
  }
  if (task.agentId) {
    const agent = mgr.agents.get(task.agentId);
    if (agent?.sshUrl) {
      const m = agent.sshUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/);
      if (m) return { owner: m[1], repo: m[2] };
    }
    if (agent?.projectName && agent.projectName.includes('/')) {
      const [owner, repo] = agent.projectName.split('/');
      if (owner && repo) return { owner, repo };
    }
  }
  return null;
}

// ── GET /tasks/:id/commits/:hash/diff — fetch commit diff from GitHub ───────
router.get('/:id/commits/:hash/diff', async (req, res) => {
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return res.status(501).json({ error: 'GITHUB_TOKEN not configured' });

    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const ownerRepo = resolveOwnerRepo(task, mgr);
    if (!ownerRepo) {
      return res.status(400).json({ error: 'Cannot determine GitHub repository for this task' });
    }

    const octokit = new Octokit({ auth: token });
    const { data: commit } = await octokit.repos.getCommit({
      owner: ownerRepo.owner,
      repo: ownerRepo.repo,
      ref: req.params.hash,
    });

    res.json({
      sha: commit.sha,
      message: commit.commit.message,
      author: commit.commit.author?.name || commit.author?.login || 'unknown',
      date: commit.commit.author?.date,
      stats: commit.stats,
      files: (commit.files || []).map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch || '',
      })),
    });
  } catch (err) {
    console.error('Commit diff error:', err.message);
    if (err.status === 404) return res.status(404).json({ error: 'Commit not found on GitHub' });
    res.status(500).json({ error: err.message });
  }
});

export default router;
