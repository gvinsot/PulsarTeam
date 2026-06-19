import { Router } from 'express';
import { requireRole } from '../middleware/auth.js';
import { checkBoardAccess } from '../middleware/authz.js';
import { getPool, getBoardById, rowToTask, getOAuthToken, getTaskById } from '../services/database.js';
import { setTaskSignal, clearTaskSignal } from '../services/agentManager/tasks.js';
import { updateTaskExecutionStatus, saveTaskToDb } from '../services/database.js';
import { validateBody } from '../lib/validate.js';
import { getUserBoardIdSet } from '../lib/boardAccess.js';
import { isCliRunner } from '../services/runners.js';
import {
  reorderTasksSchema,
  updateTaskSchema,
  bulkMoveSchema,
} from '../schemas/tasks.js';

const router = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

const REPO_FULLNAME_RE = /^[\w.-]+\/[\w.-]+$/;
const MAX_SECONDARY_REPOS = 10;

function normalizeSecondaryReposForTask(input: any, primaryFullName?: string | null) {
  if (!Array.isArray(input)) return [];
  const primary = primaryFullName || null;
  const seen = new Set<string>();
  const out: Array<{ provider: string; fullName: string }> = [];
  for (const raw of input) {
    const fullName = typeof raw === 'string'
      ? raw
      : (raw && typeof raw.fullName === 'string' ? raw.fullName : null);
    if (!fullName || !REPO_FULLNAME_RE.test(fullName)) continue;
    if (primary && fullName === primary) continue;
    if (seen.has(fullName)) continue;
    seen.add(fullName);
    const provider = raw && typeof raw === 'object' && typeof raw.provider === 'string' && raw.provider
      ? raw.provider
      : 'github';
    out.push({ provider, fullName });
    if (out.length >= MAX_SECONDARY_REPOS) break;
  }
  return out;
}

/** Check if the authenticated user has access to a task (via agent ownership OR board access) */
async function requireTaskAccess(mgr, task, user) {
  if (user.role === 'admin') return true;
  const agent = task.agentId ? mgr.agents.get(task.agentId) : null;
  // Agent owner always has access (covers agent-scoped tasks).
  if (agent && (!agent.ownerId || agent.ownerId === user.userId)) return true;
  // Board edit access (covers unassigned/board-only tasks and shared boards).
  if (task.boardId) {
    const access = await checkBoardAccess(task.boardId, user.userId, user.role, 'edit');
    if (access.ok) return true;
  }
  // Orphaned task with no agent and no board to gate on — allow so it stays deletable.
  if (!agent && !task.boardId) return true;
  return false;
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
  const access = await checkBoardAccess(boardId, userId, userRole, 'edit');
  if (!access.ok) {
    return { ok: false, error: access.error || 'No write access to destination board', status: access.status || 403 };
  }
  return { ok: true, board: access.board };
}

/** Validate that a column exists in a board; fallback to first column */
function validateColumn(board, columnId) {
  if (!board?.workflow?.columns?.length) return columnId;
  const exists = board.workflow.columns.some(c => c.id === columnId);
  if (exists) return columnId;
  return board.workflow.columns[0].id;
}

/** Look up the in-memory task object for an agent (getTask returns a copy). */
export function getMemTask(mgr, agentId, taskId) {
  return mgr._getAgentTasks(agentId).find(t => t.id === taskId) ?? null;
}

/** Clear the actionRunning trio on a task object (uses delete, not = null). */
function clearActionRunning(t) {
  t.actionRunning = false;
  delete t.actionRunningAgentId;
  delete t.actionRunningMode;
}

/** Stop the agent executing a task and clear its actionRunning flags. */
function stopTaskExecutor(mgr, task) {
  const executorId = task.actionRunningAgentId || task.assignee || task.agentId;
  if (executorId) mgr.stopAgent(executorId);
  clearActionRunning(task);
}

function requestTaskCliInterrupt(mgr, task): void {
  const executorId = task.actionRunningAgentId || task.assignee || task.agentId;
  if (!executorId || !mgr?.executionManager) return;
  const executor = mgr.agents.get(executorId);
  const provider = mgr.executionManager.getProviderType?.(executorId);
  if (executor && !isCliRunner(executor) && (!provider || provider === 'sandbox')) return;
  const interrupt =
    mgr.executionManager.interruptCliTerminalSessions
    || mgr.executionManager.interruptTerminalSession;
  if (!interrupt) return;
  Promise.resolve(interrupt.call(mgr.executionManager, executorId))
    .then((sent: boolean) => {
      if (sent) {
        console.log(`🛑 [Execution] Sent CLI interrupt to task executor ${executor?.name || executorId}`);
      }
    })
    .catch((err: any) => {
      console.warn(`⚠️ [Execution] CLI interrupt failed for task executor ${executorId}: ${err?.message || err}`);
    });
}

/**
 * Clear the stale execution state on the in-memory task after a status change
 * (the 8-field reset shared by the memTask sync blocks). Intentionally does NOT
 * stamp completedAt or fire setTaskSignal — those differ per call site and stay
 * inline at the call sites.
 */
function clearExecutionState(t) {
  t.startedAt = null;
  t.executionStatus = null;
  delete t._pendingOnEnter;
  t.completedActionIdx = null;
  clearActionRunning(t);
}

/**
 * Emit the task:updated + agent:updated pair for a task. Used by PUT /:id and
 * bulk-move. NOT used by /:id/stop, which emits only task:updated with a
 * constructed payload and no agent:updated.
 */
function emitTaskUpdate(mgr, task) {
  if (task.assignee) {
    const assigneeAgent = mgr.agents.get(task.assignee);
    task.assigneeName = assigneeAgent?.name || null;
    task.assigneeIcon = assigneeAgent?.icon || null;
  } else {
    task.assigneeName = null;
    task.assigneeIcon = null;
  }
  mgr._emit('task:updated', { agentId: task.agentId, task });
  if (task.agentId) {
    const agent = mgr.agents.get(task.agentId);
    if (agent) mgr._emit('agent:updated', mgr._sanitize(agent));
  }
}

// ── GET /tasks — list all tasks (from the tasks table) ─────────────────────
router.get('/', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json([]);

    const { board_id, agent_id, status, project, repo_full_name } = req.query;
    // JOIN-based query: project name is derived from boards.project_id.
    // Repo + storage live directly on the task row.
    let query = `
      SELECT t.*,
             p.id   AS _project_id,
             p.name AS _project_name
      FROM tasks t
      LEFT JOIN boards   b ON t.board_id = b.id
      LEFT JOIN projects p ON b.project_id = p.id
      WHERE t.deleted_at IS NULL`;
    const params: any[] = [];

    // Scope to user's accessible boards (admins see all)
    if (req.user.role !== 'admin') {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      if (boardIds.size === 0) return res.json([]);
      params.push([...boardIds]);
      query += ` AND t.board_id = ANY($${params.length})`;
    }

    if (board_id) {
      params.push(board_id);
      query += ` AND t.board_id = $${params.length}`;
    }
    if (agent_id) {
      params.push(agent_id);
      query += ` AND t.agent_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      query += ` AND t.status = $${params.length}`;
    }
    if (project) {
      // Filter by project name (derived through boards.project_id)
      params.push(project);
      query += ` AND p.name = $${params.length}`;
    }
    if (repo_full_name) {
      params.push(repo_full_name);
      query += ` AND t.repo_full_name = $${params.length}`;
    }

    query += ' ORDER BY t.position ASC, t.created_at ASC';
    const result = await pool.query(query, params);

    // Enrich with agent name
    const mgr = req.app.get('agentManager');
    const tasks = result.rows.map(row => {
      const task: any = rowToTask(row);
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

// ── PUT /tasks/reorder — update positions for tasks in a column ────────────
// IMPORTANT: This must be defined BEFORE /:id to prevent Express from
// matching '/reorder' as a task :id parameter.
router.put('/reorder', validateBody(reorderTasksSchema), async (req, res) => {
  try {
    const { orderedIds } = req.body;

    const pool = getPool();
    if (!pool) return res.status(500).json({ error: 'Database not available' });

    const mgr = req.app.get('agentManager');

    // Verify user has access to at least the first task's board
    if (req.user.role !== 'admin') {
      const firstTask = mgr.getTask(orderedIds[0]);
      if (firstTask?.boardId) {
        const access = await validateBoardAccess(firstTask.boardId, req.user.userId, req.user.role);
        if (!access.ok) return res.status(access.status).json({ error: access.error });
      }
    }

    // Update all positions in a single atomic statement so a mid-flight
    // failure can't leave the board half-reordered.
    const positions = orderedIds.map((_, index) => index);
    await pool.query(
      `UPDATE tasks SET position = u.pos, updated_at = NOW()
       FROM unnest($1::uuid[], $2::bigint[]) AS u(id, pos)
       WHERE tasks.id = u.id`,
      [orderedIds, positions]
    );

    // Also update in-memory positions
    for (let i = 0; i < orderedIds.length; i++) {
      const task = mgr.getTask(orderedIds[i]);
      if (task) {
        const memAgent = mgr.agents.get(task.agentId);
        if (memAgent) {
          const memTask = getMemTask(mgr, task.agentId, orderedIds[i]);
          if (memTask) memTask.position = i;
        }
      }
    }

    res.json({ ok: true, count: orderedIds.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /tasks/:id — update a task ──────────────────────────────────────────
router.put('/:id', validateBody(updateTaskSchema), async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    // Fall back to the DB for unassigned/board-only tasks, which never live in
    // the agentId-keyed in-memory store that getTask() searches.
    const task = mgr.getTask(req.params.id) || await getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!await requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const {
      title, description, column, agentId, type, taskType, priority, dueDate,
      boardId, position, isManual, recurrence, repoFullName, repoProvider,
      secondaryRepos, storagePath, storageProvider,
    } = req.body;
    const now = new Date().toISOString();
    const username = req.user?.username || 'user';

    // ── Stop agent when task is moved to another column/board ───────────
    const wantsColumnChange = column !== undefined && column !== task.status;
    const wantsBoardChange = boardId !== undefined && boardId !== (task.boardId || null);
    if (task.actionRunning && (wantsColumnChange || wantsBoardChange)) {
      // Stop the executing agent so the task can be moved and clear
      // actionRunning on our copy so it persists correctly.
      stopTaskExecutor(mgr, task);
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
      // Validate the requested column exists in the task's current board
      // workflow. Without this, callers could push tasks into arbitrary
      // unknown columns, breaking board rendering and transitions.
      const currentBoardId = task.boardId || null;
      if (currentBoardId) {
        const currentBoard = await getBoardById(currentBoardId);
        const cols = currentBoard?.workflow?.columns;
        if (cols?.length && !cols.some((c: any) => c.id === column)) {
          const validIds = cols.map((c: any) => c.id).join(', ');
          return res.status(400).json({
            error: `Invalid column "${column}" for board "${currentBoard?.name || currentBoardId}". Valid columns: ${validIds}`,
          });
        }
      }
      statusChanged = true;
      task.status = column;
    }

    const previousAssignee = statusChanged && agentId === undefined ? (task.assignee || null) : null;
    if (previousAssignee) {
      task.assignee = null;
      editedFields.push('assignee');
    }

    // ── Update other fields ────────────────────────────────────────────────
    if (title !== undefined && title !== task.title) { task.title = title; editedFields.push('title'); }
    if (description !== undefined && description !== task.text) { task.text = description; editedFields.push('description'); }
    if (agentId !== undefined && agentId !== task.assignee) {
      if (agentId) {
        const assignee = mgr.agents.get(agentId);
        if (!assignee) return res.status(404).json({ error: 'Assignee agent not found' });
        if (req.user.role !== 'admin' && assignee.boardId) {
          const access = await checkBoardAccess(assignee.boardId, req.user.userId, req.user.role, 'edit');
          if (!access.ok) return res.status(access.status || 403).json({ error: access.error || 'Access denied to assignee agent' });
        }
      }
      task.assignee = agentId;
      if (!editedFields.includes('assignee')) editedFields.push('assignee');
    }
    const nextTaskType = taskType !== undefined ? taskType : type;
    if (nextTaskType !== undefined && nextTaskType !== task.taskType) {
      task.taskType = nextTaskType || null;
      editedFields.push('taskType');
    }
    if (priority !== undefined && priority !== task.priority) { task.priority = priority; editedFields.push('priority'); }
    if (dueDate !== undefined && dueDate !== task.dueDate) { task.dueDate = dueDate; editedFields.push('dueDate'); }
    if (isManual !== undefined && isManual !== task.isManual) { task.isManual = !!isManual; editedFields.push('isManual'); }
    if (recurrence !== undefined) {
      const oldValue = task.recurrence || null;
      if (recurrence && recurrence.enabled) {
        task.recurrence = {
          enabled: true,
          period: recurrence.period || 'daily',
          intervalMinutes: recurrence.intervalMinutes || 1440,
          originalStatus: recurrence.originalStatus || oldValue?.originalStatus || 'backlog',
          historyRetentionDays: recurrence.historyRetentionDays || null,
          lastResetAt: oldValue?.lastResetAt || now,
        };
      } else {
        task.recurrence = null;
      }
      if (JSON.stringify(oldValue) !== JSON.stringify(task.recurrence || null)) editedFields.push('recurrence');
    }
    if (repoFullName !== undefined) {
      const value = repoFullName && REPO_FULLNAME_RE.test(repoFullName) ? repoFullName : null;
      if (value !== (task.repoFullName || null)) {
        task.repoFullName = value;
        task.repoProvider = value ? (repoProvider || task.repoProvider || 'github') : null;
        task.secondaryRepos = normalizeSecondaryReposForTask(task.secondaryRepos || [], value);
        editedFields.push('repoFullName');
      } else if (value && repoProvider !== undefined && repoProvider !== task.repoProvider) {
        task.repoProvider = repoProvider || 'github';
        editedFields.push('repoProvider');
      }
    }
    if (secondaryRepos !== undefined) {
      const oldValue = JSON.stringify(task.secondaryRepos || []);
      task.secondaryRepos = normalizeSecondaryReposForTask(secondaryRepos, task.repoFullName || null);
      if (JSON.stringify(task.secondaryRepos) !== oldValue) editedFields.push('secondaryRepos');
    }
    if (storagePath !== undefined) {
      const value = typeof storagePath === 'string' && storagePath.trim().length > 0
        ? storagePath.trim().slice(0, 500)
        : null;
      if (value !== (task.storagePath || null)) {
        task.storagePath = value;
        task.storageProvider = value ? (storageProvider || task.storageProvider || 'onedrive') : null;
        editedFields.push('storagePath');
      } else if (value && storageProvider !== undefined && storageProvider !== task.storageProvider) {
        task.storageProvider = storageProvider || 'onedrive';
        editedFields.push('storageProvider');
      }
    }
    if (position !== undefined) { task.position = position; }
    task.updatedAt = now;

    // Clear execution state on the copy when status changed — this ensures
    // the DB row is also cleaned up when saveTaskDirectly persists the copy.
    // NOTE: intentionally a SHORTER reset than clearExecutionState() applied to
    // the memTask below — completedActionIdx/_pendingOnEnter are persisted columns
    // and must be retained on the copy that saveTaskDirectly writes; nulling them
    // here would wipe them from the DB row (observable after restart rehydration).
    if (statusChanged) {
      task.startedAt = null;
      task.executionStatus = null;
      clearActionRunning(task);
      if (task.status === 'done') task.completedAt = now;
    }

    // ── History entry ──────────────────────────────────────────────────────
    const hasChanges = boardChanged || statusChanged || editedFields.length > 0;
    if (hasChanges) {
      if (!task.history) task.history = [];
      const entry: any = {
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
        if (previousAssignee) {
          entry.previousAssignee = previousAssignee;
          entry.assignee = null;
        }
        entry.fields.push('status');
      }
      task.history.push(entry);
    }

    // ── Sync changes back to in-memory task (getTask returns a copy) ────
    const memAgent = mgr.agents.get(task.agentId);
    if (memAgent) {
      const memTask = getMemTask(mgr, task.agentId, req.params.id);
      if (memTask) {
        if (title !== undefined) memTask.title = task.title;
        if (description !== undefined) memTask.text = task.text;
        if (boardChanged || column !== undefined) memTask.status = task.status;
        if (boardId !== undefined) memTask.boardId = task.boardId;
        if (agentId !== undefined) memTask.assignee = task.assignee;
        if (type !== undefined || taskType !== undefined) memTask.taskType = task.taskType;
        if (priority !== undefined) memTask.priority = task.priority;
        if (dueDate !== undefined) memTask.dueDate = task.dueDate;
        if (isManual !== undefined) memTask.isManual = task.isManual;
        if (recurrence !== undefined) memTask.recurrence = task.recurrence;
        if (repoFullName !== undefined) {
          memTask.repoFullName = task.repoFullName;
          memTask.repoProvider = task.repoProvider;
          memTask.secondaryRepos = task.secondaryRepos;
        }
        if (secondaryRepos !== undefined) memTask.secondaryRepos = task.secondaryRepos;
        if (storagePath !== undefined) {
          memTask.storagePath = task.storagePath;
          memTask.storageProvider = task.storageProvider;
        }
        if (position !== undefined) memTask.position = task.position;
        memTask.updatedAt = task.updatedAt;

        // When status changed, clear stale execution state so the workflow
        // engine starts fresh and the task loop doesn't incorrectly resume.
        // Also signal the reminder loop to stop — the agent should no longer
        // work on this task since it was moved by a user.
        if (statusChanged) {
          clearExecutionState(memTask);
          memTask.assignee = task.assignee || null;
          if (task.status === 'done') memTask.completedAt = now;
          // Signal the reminder loop / execution wait to exit
          setTaskSignal(req.params.id as string, 'stopped', true);
        }
      }
    }

    await mgr.saveTaskDirectly(task);

    // ── Trigger workflow processing when status changed ────
    if (statusChanged) {
      if (task.status !== 'error') {
        mgr._checkAutoRefine({ ...task }, { by: username });
      }
    }

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
    emitTaskUpdate(mgr, task);

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
router.post('/bulk-move', validateBody(bulkMoveSchema), async (req, res) => {
  try {
    const { taskIds, boardId, column } = req.body;

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
      if (!await requireTaskAccess(mgr, task, req.user)) { results.failed.push({ taskId, error: 'Access denied' }); continue; }
      // Stop the executing agent if it's actively processing this task
      if (task.actionRunning) {
        stopTaskExecutor(mgr, task);
      }

      const oldBoardId = task.boardId;
      const oldStatus = task.status;
      const previousAssignee = task.assignee || null;
      let oldBoardName = null;
      if (oldBoardId) { const ob = await getBoardById(oldBoardId); oldBoardName = ob?.name || null; }

      task.boardId = boardId;
      task.status = targetColumn;
      if (oldStatus !== targetColumn && previousAssignee) {
        task.assignee = null;
      }
      task.updatedAt = now;
      const changedFields = ['boardId', 'status'];
      if (oldStatus !== targetColumn && previousAssignee) changedFields.push('assignee');
      if (!task.history) task.history = [];
      const historyEntry: any = {
        at: now, by: username, type: 'board_move',
        fromBoard: oldBoardId, toBoard: boardId,
        fromBoardName: oldBoardName, toBoardName: access.board?.name || null,
        from: oldStatus, status: targetColumn,
        fields: changedFields, bulk: true,
      };
      if (oldStatus !== targetColumn && previousAssignee) {
        historyEntry.previousAssignee = previousAssignee;
        historyEntry.assignee = null;
      }
      task.history.push(historyEntry);

      await mgr.saveTaskDirectly(task);

      // Sync execution state in memory and trigger workflow if status changed
      if (oldStatus !== targetColumn) {
        const memTask = getMemTask(mgr, task.agentId, taskId);
        if (memTask) {
          memTask.status = targetColumn;
          memTask.boardId = boardId;
          memTask.assignee = task.assignee || null;
          memTask.updatedAt = now;
          clearExecutionState(memTask);
        }
        // Signal the reminder loop / execution wait to exit
        setTaskSignal(taskId, 'stopped', true);
        if (targetColumn !== 'error') {
          mgr._checkAutoRefine({ ...task }, { by: username });
        }
      }

      emitTaskUpdate(mgr, task);
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

// ── POST /tasks/:id/stop — task-level stop (clears stuck actionRunning) ────
// Used as a fallback when the executor agent has been recycled and the
// agent-level stop endpoint returns 404. Clears actionRunning flags and
// signals any waiting workflow loop, but does NOT relaunch the task.
router.post('/:id/stop', async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!await requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Clear stuck flags in memory
    const memTask = getMemTask(mgr, task.agentId, req.params.id);
    const target = memTask || task;
    requestTaskCliInterrupt(mgr, target);
    target.actionRunning = false;
    target.actionRunningAgentId = null;
    target.actionRunningMode = null;
    // Mark as stopped only for active-status tasks; error-status tasks keep
    // their error state so the user sees the Resume button as recovery.
    if (mgr._isActiveTaskStatus(target.status)) {
      target.executionStatus = 'stopped';
      target.startedAt = null;
    }

    // Signal any pending workflow lock so it unblocks immediately
    setTaskSignal(req.params.id, 'stopped', true);

    await saveTaskToDb({ ...target, agentId: task.agentId });
    mgr._emit('task:updated', { agentId: task.agentId, task: { ...target, agentId: task.agentId } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /tasks/:id/clear-stopped — clear the "stopped" execution status ───
router.patch('/:id/clear-stopped', async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!await requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    clearTaskSignal(req.params.id, 'stopped');
    await updateTaskExecutionStatus(req.params.id, null);

    // Reset circuit breaker so the task loop doesn't skip this task
    mgr._taskResumeFailures?.delete(req.params.id);

    // Update in-memory task
    const memTask = getMemTask(mgr, task.agentId, req.params.id);
    if (memTask) {
      memTask.executionStatus = null;
    }
    task.executionStatus = null;

    // If task is in 'error' status, restore it to the previous active status
    // so the task loop picks it up for re-execution
    if (task.status === 'error') {
      const restoreStatus = task.errorFromStatus || 'pending';
      await mgr.setTaskStatus(task.agentId, task.id, restoreStatus, { by: 'user' });
      // setTaskStatus clears startedAt — set it so the task loop picks it up
      const updatedTask = getMemTask(mgr, task.agentId, req.params.id);
      if (updatedTask) {
        updatedTask.startedAt = new Date().toISOString();
      }
    } else {
      // For non-error tasks, just re-stamp startedAt so the task loop resumes
      if (memTask) {
        memTask.startedAt = new Date().toISOString();
      }
      task.startedAt = new Date().toISOString();
    }

    mgr._emit('task:updated', { agentId: task.agentId, task: { ...task, agentId: task.agentId } });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /tasks/:id — soft delete ─────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const mgr = req.app.get('agentManager');
    // Fall back to the DB for unassigned/board-only tasks, which never live in
    // the agentId-keyed in-memory store that getTask() searches.
    const task = mgr.getTask(req.params.id) || await getTaskById(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!await requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Block deletion of tasks being executed by a busy agent
    const agent = task.agentId ? mgr.agents.get(task.agentId) : null;
    if (task.startedAt && mgr._isActiveTaskStatus(task.status) && agent?.status === 'busy') {
      return res.status(409).json({ error: 'Task is being executed. Stop the agent first.' });
    }

    const ok = await mgr.deleteTask(task.agentId, req.params.id);
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
    if (!await requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }
    res.json(task.history || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /tasks/project-stats — aggregated task stats per project (via boards) ─
router.get('/project-stats', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json({ projects: [] });

    const days = Math.min(Math.max(parseInt(req.query.days as string) || 30, 1), 90);

    // Scope counts and project names to resources visible to the caller.
    let boardFilter = '';
    let projectFilter = '';
    let summaryParams: any[] = [];
    let dailyParams: any[] = [days];
    let daysParamIdx = 1;
    if (req.user.role !== 'admin') {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      summaryParams = [[...boardIds], req.user.userId];
      dailyParams = [[...boardIds], days];
      daysParamIdx = 2;
      boardFilter = ' AND t.board_id = ANY($1)';
      projectFilter = `WHERE p.owner_id = $2
        OR EXISTS (
          SELECT 1 FROM boards visible_b
          WHERE visible_b.project_id = p.id AND visible_b.id = ANY($1)
        )`;
    }

    // 1. Per-project summary counts — join tasks → boards → projects
    const summaryResult = await pool.query(`
      SELECT
        p.id AS project_id,
        p.name AS project_name,
        COUNT(t.id)::int AS total,
        COUNT(*) FILTER (WHERE t.status = 'done')::int AS done,
        COUNT(*) FILTER (WHERE t.status NOT IN ('done','error','backlog'))::int AS active,
        COUNT(*) FILTER (WHERE t.status IN ('error','backlog'))::int AS waiting,
        COUNT(*) FILTER (WHERE t.task_type = 'bug')::int AS bugs,
        COUNT(*) FILTER (WHERE t.task_type = 'feature')::int AS features
      FROM projects p
      LEFT JOIN boards b ON b.project_id = p.id
      LEFT JOIN tasks t ON t.board_id = b.id AND t.deleted_at IS NULL${boardFilter ? ' AND ' + boardFilter.slice(5) : ''}
      ${projectFilter}
      GROUP BY p.id, p.name
      ORDER BY p.name
    `, summaryParams);

    // 2. Daily created/completed counts per project (last N days)
    const dailyResult = await pool.query(`
      SELECT project_id, day::date AS day, created, completed FROM (
        SELECT b.project_id, d.day,
          COUNT(*) FILTER (WHERE t.created_at::date = d.day)::int AS created,
          COUNT(*) FILTER (WHERE t.completed_at::date = d.day)::int AS completed
        FROM tasks t
        JOIN boards b ON t.board_id = b.id
        CROSS JOIN generate_series(
          (CURRENT_DATE - ($${daysParamIdx} || ' days')::interval)::date,
          CURRENT_DATE,
          '1 day'::interval
        ) AS d(day)
        WHERE t.deleted_at IS NULL AND b.project_id IS NOT NULL${boardFilter}
          AND (t.created_at >= CURRENT_DATE - ($${daysParamIdx} || ' days')::interval
               OR t.completed_at >= CURRENT_DATE - ($${daysParamIdx} || ' days')::interval)
        GROUP BY b.project_id, d.day
      ) sub
      WHERE created > 0 OR completed > 0
      ORDER BY project_id, day
    `, dailyParams);

    const dailyByProject: Record<string, { date: string; created: number; completed: number }[]> = {};
    for (const row of dailyResult.rows) {
      const key = row.project_id;
      if (!dailyByProject[key]) dailyByProject[key] = [];
      dailyByProject[key].push({
        date: row.day instanceof Date ? row.day.toISOString().split('T')[0] : String(row.day).split('T')[0],
        created: row.created,
        completed: row.completed,
      });
    }

    const projects = summaryResult.rows.map(r => ({
      id: r.project_id,
      name: r.project_name,
      total: r.total,
      done: r.done,
      active: r.active,
      waiting: r.waiting,
      bugs: r.bugs,
      features: r.features,
      completion: r.total > 0 ? Math.round((r.done / r.total) * 100) : 0,
      daily: dailyByProject[r.project_id] || [],
    }));

    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /tasks/stats — task statistics ──────────────────────────────────────
router.get('/stats', async (req, res) => {
  try {
    const pool = getPool();
    if (!pool) return res.json({ total: 0, active: 0, deleted: 0, deletionRate: 0 });

    let boardFilter = '';
    const params: any[] = [];
    if (req.user.role !== 'admin') {
      const boardIds = await getUserBoardIdSet(req.user.userId);
      if (boardIds.size === 0) return res.json({ total: 0, active: 0, deleted: 0, deletionRate30d: 0 });
      params.push([...boardIds]);
      boardFilter = ` AND board_id = ANY($1)`;
    }

    const [totalResult, activeResult, deletedResult, recentDeletedResult] = await Promise.all([
      pool.query(`SELECT COUNT(*) as count FROM tasks WHERE 1=1${boardFilter}`, params),
      pool.query(`SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NULL${boardFilter}`, params),
      pool.query(`SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NOT NULL${boardFilter}`, params),
      pool.query(`SELECT COUNT(*) as count FROM tasks WHERE deleted_at IS NOT NULL AND deleted_at >= NOW() - INTERVAL '30 days'${boardFilter}`, params),
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

    const limit = Math.min(Math.max(parseInt(req.query.limit as string) || 50, 1), 200);
    const offset = Math.max(parseInt(req.query.offset as string) || 0, 0);

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

    const retentionDays = parseInt(req.query.days as string) || 90;
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
async function resolveOwnerRepo(task, mgr) {
  // 1. task.repoFullName (stored directly on the task row)
  if (task.repoFullName && task.repoFullName.includes('/')) {
    const [owner, repo] = task.repoFullName.split('/');
    if (owner && repo) return { owner, repo };
  }
  // 2. Explicit githubIssue
  if (task.githubIssue?.owner && task.githubIssue?.repo) {
    return { owner: task.githubIssue.owner, repo: task.githubIssue.repo };
  }
  // 3. Fallback: agent's currently-active project (string in "owner/repo" form)
  const agentProject = mgr.agents.get(task.agentId)?.project;
  if (agentProject && agentProject.includes('/')) {
    const [owner, repo] = agentProject.split('/');
    if (owner && repo) return { owner, repo };
  }
  return null;
}

// ── GET /tasks/:id/commits/:hash/diff — fetch commit diff from GitHub ───────
router.get('/:id/commits/:hash/diff', async (req, res) => {
  try {
    // Validate the commit hash before using it in a URL — prevents path/header injection
    // and accidental call to a different GitHub endpoint.
    if (!/^[0-9a-f]{7,40}$/i.test(req.params.hash || '')) {
      return res.status(400).json({ error: 'Invalid commit hash' });
    }

    const mgr = req.app.get('agentManager');
    const task = mgr.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (!await requireTaskAccess(mgr, task, req.user)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    if (!task.boardId) {
      return res.status(400).json({ error: 'Task has no board — cannot resolve GitHub credentials' });
    }
    const tok = getOAuthToken('github', 'board', task.boardId);
    if (!tok || !tok.accessToken) {
      return res.status(400).json({ error: 'No GitHub plugin connected on this board', code: 'GITHUB_NOT_CONNECTED' });
    }

    const ownerRepo = await resolveOwnerRepo(task, mgr);
    if (!ownerRepo) {
      return res.status(400).json({ error: 'Cannot determine GitHub repository for this task' });
    }
    // Defense-in-depth: also validate owner/repo segments derived from task data.
    if (!/^[A-Za-z0-9_.\-]+$/.test(ownerRepo.owner) || !/^[A-Za-z0-9_.\-]+$/.test(ownerRepo.repo)) {
      return res.status(400).json({ error: 'Invalid GitHub repository identifier' });
    }

    const resp = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(ownerRepo.owner)}/${encodeURIComponent(ownerRepo.repo)}/commits/${encodeURIComponent(req.params.hash)}`,
      { headers: { Authorization: `Bearer ${tok.accessToken}`, Accept: 'application/vnd.github.v3+json', 'User-Agent': 'PulsarTeam' } }
    );
    if (!resp.ok) {
      if (resp.status === 404) return res.status(404).json({ error: 'Commit not found on GitHub' });
      throw new Error(`GitHub API error: ${resp.status} ${resp.statusText}`);
    }
    const commit = await resp.json();

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
    res.status(500).json({ error: err.message });
  }
});

export default router;
