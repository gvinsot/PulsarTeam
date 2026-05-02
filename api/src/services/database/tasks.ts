import { getPool } from './connection.js';

/** Convert a DB row to the in-memory task object format */
export function rowToTask(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    text: row.text || '',
    title: row.title || undefined,
    status: row.status || 'backlog',
    project: row.project || null,
    boardId: row.board_id || null,
    assignee: row.assignee || null,
    taskType: row.task_type || undefined,
    priority: row.priority || undefined,
    dueDate: row.due_date || undefined,
    source: row.source || null,
    recurrence: row.recurrence || null,
    commits: row.commits || [],
    history: row.history || [],
    error: row.error || undefined,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    completedAt: row.completed_at?.toISOString?.() || row.completed_at || undefined,
    startedAt: row.started_at?.toISOString?.() || row.started_at || undefined,
    deletedAt: row.deleted_at?.toISOString?.() || row.deleted_at || undefined,
    deletedBy: row.deleted_by || undefined,
    executionStatus: row.execution_status || undefined,
    completedActionIdx: row.completed_action_idx != null ? row.completed_action_idx : undefined,
    actionRunning: row.action_running || false,
    actionRunningAgentId: row.action_running_agent_id || undefined,
    actionRunningMode: row.action_running_mode || undefined,
    errorFromStatus: row.error_from_status || undefined,
    isManual: row.is_manual || false,
    position: parseInt(row.position, 10) || 0,
  };
}

export async function getTasksByAgent(agentId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE agent_id = $1 AND deleted_at IS NULL ORDER BY created_at',
      [agentId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to load tasks for agent:', err.message);
    return [];
  }
}

export async function getAllTasks() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at');
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to load all tasks:', err.message);
    return [];
  }
}

export async function getTaskById(taskId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NULL', [taskId]);
    if (result.rows.length === 0) return null;
    return rowToTask(result.rows[0]);
  } catch (err) {
    console.error('Failed to get task:', err.message);
    return null;
  }
}

// Per-task write queue: serializes all saves for the same task so that
// fire-and-forget calls cannot overtake each other at the DB level.
const _taskWriteQueue = new Map();  // taskId -> Promise

export async function saveTaskToDb(task) {
  const pool = getPool();
  if (!pool) return;

  const taskId = task.id;

  // Chain this save after the previous one for the same task.
  // This guarantees that even fire-and-forget calls execute in order.
  const prev = _taskWriteQueue.get(taskId) || Promise.resolve();
  const current = prev.then(() => _doSaveTask(task)).catch(() => {});
  _taskWriteQueue.set(taskId, current);

  // Await our own turn so callers who `await saveTaskToDb()` get the guarantee
  return current;
}

async function _doSaveTask(task) {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO tasks (id, agent_id, text, title, status, project, board_id, assignee,
                          task_type, priority, due_date, source, recurrence, commits, history,
                          error, created_at, updated_at, completed_at, started_at,
                          execution_status, completed_action_idx, action_running, action_running_agent_id,
                          action_running_mode, error_from_status, is_manual, position)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
       ON CONFLICT (id) DO UPDATE SET
         text = $3, title = $4, status = $5, project = $6, board_id = $7, assignee = $8,
         task_type = $9, priority = $10, due_date = $11, source = $12, recurrence = $13,
         commits = $14, history = $15, error = $16, updated_at = NOW(),
         completed_at = $18, started_at = $19,
         execution_status = $20, completed_action_idx = $21, action_running = $22, action_running_agent_id = $23,
         action_running_mode = $24, error_from_status = $25, is_manual = $26, position = $27`,
      [
        task.id,
        task.agentId,
        task.text || '',
        task.title || null,
        task.status || 'backlog',
        task.project || null,
        task.boardId || null,
        task.assignee || null,
        task.taskType || null,
        task.priority || null,
        task.dueDate || null,
        task.source ? JSON.stringify(task.source) : null,
        task.recurrence ? JSON.stringify(task.recurrence) : null,
        JSON.stringify(task.commits || []),
        JSON.stringify(task.history || []),
        task.error || null,
        task.createdAt || new Date().toISOString(),
        task.completedAt || null,
        task.startedAt || null,
        task.executionStatus || null,
        task.completedActionIdx != null ? task.completedActionIdx : null,
        task.actionRunning || false,
        task.actionRunningAgentId || null,
        task.actionRunningMode || null,
        task.errorFromStatus || null,
        task.isManual || false,
        task.position ?? 0,
      ]
    );
  } catch (err) {
    console.error('Failed to save task:', err.message);
  }
}

export async function deleteTaskFromDb(taskId, deletedBy = null) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query(
      'UPDATE tasks SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [taskId, deletedBy]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to soft-delete task:', err.message);
    return false;
  }
}

export async function hardDeleteTaskFromDb(taskId) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to hard-delete task:', err.message);
    return false;
  }
}

export async function restoreTaskFromDb(taskId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'UPDATE tasks SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *',
      [taskId]
    );
    if (result.rows.length === 0) return null;
    return rowToTask(result.rows[0]);
  } catch (err) {
    console.error('Failed to restore task:', err.message);
    return null;
  }
}

export async function getDeletedTasks() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get deleted tasks:', err.message);
    return [];
  }
}

export async function getDeletedTaskById(taskId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NOT NULL', [taskId]);
    if (result.rows.length === 0) return null;
    return rowToTask(result.rows[0]);
  } catch (err) {
    console.error('Failed to get deleted task:', err.message);
    return null;
  }
}

export async function deleteTasksByAgent(agentId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE tasks SET deleted_at = NOW(), updated_at = NOW() WHERE agent_id = $1 AND deleted_at IS NULL',
      [agentId]
    );
  } catch (err) {
    console.error('Failed to soft-delete tasks for agent:', err.message);
  }
}

/**
 * Find tasks that need agent resume: active status, started, not currently watched,
 * with their assignee agent idle and enabled.
 */
export async function getTasksForResume() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT t.*, a.data as agent_data
      FROM tasks t
      JOIN agents a ON COALESCE(t.assignee, t.agent_id) = a.id
      WHERE t.deleted_at IS NULL
        AND t.started_at IS NOT NULL
        AND t.status NOT IN ('done', 'backlog', 'error')
        AND (t.execution_status IS NULL OR t.execution_status NOT IN ('watching', 'stopped'))
        AND (t.is_manual IS NULL OR t.is_manual = FALSE)
      ORDER BY t.started_at ASC
    `);
    return result.rows.map(row => ({
      ...rowToTask(row),
      _agentStatus: row.agent_data?.status || 'idle',
      _agentEnabled: row.agent_data?.enabled !== false,
    }));
  } catch (err) {
    console.error('Failed to get tasks for resume:', err.message);
    return [];
  }
}

/**
 * Clear execution flags for all tasks involving a given agent (as assignee or owner).
 */
export async function clearTaskExecutionFlags(agentId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`
      UPDATE tasks SET
        execution_status = NULL,
        started_at = NULL,
        completed_action_idx = NULL,
        action_running = FALSE,
        action_running_agent_id = NULL,
        action_running_mode = NULL,
        error_from_status = NULL,
        updated_at = NOW()
      WHERE deleted_at IS NULL
        AND (assignee = $1 OR agent_id = $1)
        AND (started_at IS NOT NULL OR execution_status IS NOT NULL OR action_running = TRUE)
    `, [agentId]);
  } catch (err) {
    console.error('Failed to clear task execution flags:', err.message);
  }
}

/**
 * Update only the execution_status of a task (lightweight update for watching/stopped transitions).
 */
export async function updateTaskExecutionStatus(taskId, executionStatus) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE tasks SET execution_status = $2, updated_at = NOW() WHERE id = $1',
      [taskId, executionStatus || null]
    );
  } catch (err) {
    console.error('Failed to update task execution status:', err.message);
  }
}

/**
 * Clear action_running flags for tasks assigned to a specific agent.
 */
export async function clearActionRunningForAgent(agentId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`
      UPDATE tasks SET
        action_running = FALSE,
        action_running_agent_id = NULL,
        action_running_mode = NULL,
        updated_at = NOW()
      WHERE action_running_agent_id = $1 AND action_running = TRUE
    `, [agentId]);
  } catch (err) {
    console.error('Failed to clear action_running for agent:', err.message);
  }
}

/**
 * Clear action_running flags for ALL tasks on startup (service restart recovery).
 * After a crash, no actions are actually running — the flags are stale.
 */
export async function clearAllStaleActionRunning() {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const result = await pool.query(`
      UPDATE tasks SET
        action_running = FALSE,
        action_running_agent_id = NULL,
        updated_at = NOW()
      WHERE action_running = TRUE AND deleted_at IS NULL
    `);
    return result.rowCount || 0;
  } catch (err) {
    console.error('Failed to clear stale action_running flags:', err.message);
    return 0;
  }
}

// ── Additional task queries ───────────────────────────────────────────────────

/**
 * Get active tasks (not done/backlog/error) for a given agent (as owner).
 */
export async function getActiveTasksByAgent(agentId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE agent_id = $1 AND status NOT IN ('done','backlog','error') AND deleted_at IS NULL ORDER BY created_at`,
      [agentId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get active tasks for agent:', err.message);
    return [];
  }
}

/**
 * Get all tasks for a board.
 */
export async function getTasksByBoard(boardId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE board_id = $1 AND deleted_at IS NULL ORDER BY created_at',
      [boardId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get tasks for board:', err.message);
    return [];
  }
}

/**
 * Find the board that has the most tasks for a given project.
 * Returns the board_id or null if no tasks exist for this project.
 */
export async function getBoardWithMostTasksForProject(project) {
  const pool = getPool();
  if (!pool || !project) return null;
  try {
    const result = await pool.query(
      `SELECT board_id, COUNT(*) as task_count
       FROM tasks
       WHERE project ILIKE $1 AND board_id IS NOT NULL AND deleted_at IS NULL
       GROUP BY board_id
       ORDER BY task_count DESC
       LIMIT 1`,
      [project]
    );
    return result.rows.length > 0 ? result.rows[0].board_id : null;
  } catch (err) {
    console.error('Failed to get board with most tasks for project:', err.message);
    return null;
  }
}

/**
 * Get all tasks assigned to an agent (either as assignee or as owner when no assignee).
 */
export async function getTasksByAssignee(agentId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1)) AND deleted_at IS NULL ORDER BY created_at`,
      [agentId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get tasks by assignee:', err.message);
    return [];
  }
}

/**
 * Find the first active task (with startedAt) for a given executor agent.
 * Checks both assignee and owner. Returns null if none found.
 */
export async function getActiveTaskForExecutor(agentId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND started_at IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY started_at ASC LIMIT 1`,
      [agentId]
    );
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to get active task for executor:', err.message);
    return null;
  }
}

/**
 * Check if an agent has any active task (optionally excluding one task).
 * Returns true/false. Replaces the in-memory agentHasActiveTask cross-agent scan.
 */
export async function hasActiveTask(agentId, excludeTaskId = null) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const params = [agentId];
    let excludeClause = '';
    if (excludeTaskId) {
      excludeClause = ' AND id != $2';
      params.push(excludeTaskId);
    }
    const result = await pool.query(
      `SELECT 1 FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND deleted_at IS NULL${excludeClause}
       LIMIT 1`,
      params
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error('Failed to check active task:', err.message);
    return false;
  }
}

/**
 * Count active tasks for an agent (for load-balancing).
 */
export async function countActiveTasksForAgent(agentId, excludeTaskId = null) {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const params = [agentId];
    let excludeClause = '';
    if (excludeTaskId) {
      excludeClause = ' AND id != $2';
      params.push(excludeTaskId);
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int as count FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND deleted_at IS NULL${excludeClause}`,
      params
    );
    return result.rows[0]?.count || 0;
  } catch (err) {
    console.error('Failed to count active tasks:', err.message);
    return 0;
  }
}

/**
 * Get recurring tasks that are done and ready for reset.
 */
export async function getRecurringDoneTasks() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE recurrence IS NOT NULL
         AND status = 'done'
         AND completed_at IS NOT NULL
         AND deleted_at IS NULL`
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get recurring done tasks:', err.message);
    return [];
  }
}

/**
 * Get tasks filtered by status and/or board.
 * Both parameters are optional — pass null to skip a filter.
 */
export async function getTasksByStatusAndBoard(status = null, boardId = null) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const conditions = ['deleted_at IS NULL'];
    const params = [];
    let idx = 1;
    if (status) {
      conditions.push(`status = $${idx}`);
      params.push(status);
      idx++;
    }
    if (boardId) {
      conditions.push(`board_id = $${idx}`);
      params.push(boardId);
      idx++;
    }
    const result = await pool.query(
      `SELECT * FROM tasks WHERE ${conditions.join(' AND ')} ORDER BY position, created_at`,
      params
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get tasks by status/board:', err.message);
    return [];
  }
}

/**
 * Find a task by Jira key (stored in source JSONB).
 */
export async function getTaskByJiraKey(jiraKey) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE source->>'jiraKey' = $1 AND deleted_at IS NULL LIMIT 1`,
      [jiraKey]
    );
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to get task by Jira key:', err.message);
    return null;
  }
}

/**
 * Update specific fields of a task. Returns the updated task.
 */
export async function updateTaskFields(taskId, fields) {
  const pool = getPool();
  if (!pool) return null;
  const allowed = [
    'text', 'title', 'status', 'project', 'board_id', 'assignee',
    'task_type', 'priority', 'due_date', 'source', 'recurrence',
    'commits', 'history', 'error', 'completed_at', 'started_at',
    'execution_status', 'completed_action_idx', 'action_running', 'action_running_agent_id',
    'action_running_mode', 'error_from_status',
    'is_manual', 'position',
  ];
  // Map camelCase to snake_case
  const camelToSnake = {
    boardId: 'board_id', taskType: 'task_type', dueDate: 'due_date',
    completedAt: 'completed_at', startedAt: 'started_at',
    executionStatus: 'execution_status', completedActionIdx: 'completed_action_idx',
    actionRunning: 'action_running', actionRunningAgentId: 'action_running_agent_id',
    actionRunningMode: 'action_running_mode', errorFromStatus: 'error_from_status',
    isManual: 'is_manual',
  };
  const sets = [];
  const values = [taskId];
  let paramIdx = 2;
  for (const [key, value] of Object.entries(fields)) {
    const col = camelToSnake[key] || key;
    if (!allowed.includes(col)) continue;
    // JSON-serialize objects
    const val = (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date))
      ? JSON.stringify(value) : (Array.isArray(value) ? JSON.stringify(value) : value);
    sets.push(`${col} = $${paramIdx}`);
    values.push(val);
    paramIdx++;
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = NOW()');
  try {
    const result = await pool.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to update task fields:', err.message);
    return null;
  }
}
