import { getPool } from './connection.js';

// SELECT clause + joins shared by every task read query.
// Hydrates `project` (name, derived from board.project_id) so `rowToTask`
// doesn't need a separate fetch. Repo lives directly on the task row.
const TASK_SELECT = `
  SELECT t.*,
         p.id   AS _project_id,
         p.name AS _project_name
  FROM tasks t
  LEFT JOIN boards   b ON t.board_id = b.id
  LEFT JOIN projects p ON b.project_id = p.id
`;

/** Convert a DB row to the in-memory task object format */
export function rowToTask(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    text: row.text || '',
    title: row.title || undefined,
    status: row.status || 'backlog',
    boardId: row.board_id || null,
    // Project is derived from board.project_id (read-only on the task object)
    projectId: row._project_id || null,
    project: row._project_name || null,
    // Repo lives directly on the task — picked from the board's GitHub plugin
    repoProvider: row.repo_provider || null,
    repoFullName: row.repo_full_name || null,
    repoHtmlUrl: row.repo_full_name ? `https://github.com/${row.repo_full_name}` : null,
    // Storage lives directly on the task — picked from the board's OneDrive/Drive plugin
    storageProvider: row.storage_provider || null,
    storagePath: row.storage_path || null,
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
    _pendingOnEnter: row.pending_on_enter || undefined,
    actionRunning: row.action_running || false,
    actionRunningAgentId: row.action_running_agent_id || undefined,
    actionRunningMode: row.action_running_mode || undefined,
    errorFromStatus: row.error_from_status || undefined,
    isManual: row.is_manual || false,
    position: parseInt(row.position, 10) || 0,
    environment: row.environment || null,
  };
}

export async function getTasksByAgent(agentId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `${TASK_SELECT} WHERE t.agent_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at`,
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
    const result = await pool.query(`${TASK_SELECT} WHERE t.deleted_at IS NULL ORDER BY t.created_at`);
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
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.deleted_at IS NULL`, [taskId]);
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
  const chained = prev.then(() => _doSaveTask(task));
  // The queue tail swallows rejections so a failed save can't poison the chain
  // for subsequent saves of the same task; the unsuppressed promise is returned
  // so awaiting callers still observe persistence failures.
  const tail = chained.catch(() => {});
  _taskWriteQueue.set(taskId, tail);
  // Evict the entry once settled (unless a newer save already replaced it) so
  // the Map doesn't grow with every task ID ever saved.
  tail.finally(() => {
    if (_taskWriteQueue.get(taskId) === tail) _taskWriteQueue.delete(taskId);
  });

  // Await our own turn so callers who `await saveTaskToDb()` get the guarantee
  return chained;
}

// Live deployments may be missing the `environment` column if the
// initDatabase ALTER silently failed at boot (the migration's .catch
// swallowed the error). When a save trips Postgres' 42703 undefined_column
// for `environment`, run the ADD COLUMN ourselves and retry once. After the
// first successful retry every subsequent save hits the fast path.
let _envColumnEnsured = false;
async function _ensureEnvironmentColumn(pool: any): Promise<boolean> {
  if (_envColumnEnsured) return true;
  try {
    await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS environment TEXT');
    _envColumnEnsured = true;
    console.log('[saveTaskToDb] Self-healed: added missing `environment` column on tasks');
    return true;
  } catch (e: any) {
    console.error('[saveTaskToDb] Self-heal ALTER TABLE failed:', e.message);
    return false;
  }
}

async function _doSaveTask(task, _isRetry = false) {
  const pool = getPool();
  try {
    await pool.query(
      `INSERT INTO tasks (id, agent_id, text, title, status, repo_provider, repo_full_name,
                          storage_provider, storage_path, board_id, assignee,
                          task_type, priority, due_date, source, recurrence, commits, history,
                          error, created_at, updated_at, completed_at, started_at,
                          execution_status, completed_action_idx, action_running, action_running_agent_id,
                          action_running_mode, error_from_status, is_manual, position, environment,
                          pending_on_enter)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32)
       ON CONFLICT (id) DO UPDATE SET
         text = $3, title = $4, status = $5, repo_provider = $6, repo_full_name = $7,
         storage_provider = $8, storage_path = $9,
         board_id = $10, assignee = $11,
         task_type = $12, priority = $13, due_date = $14, source = $15, recurrence = $16,
         commits = $17, history = $18, error = $19, updated_at = NOW(),
         completed_at = $21, started_at = $22,
         execution_status = $23, completed_action_idx = $24, action_running = $25, action_running_agent_id = $26,
         action_running_mode = $27, error_from_status = $28, is_manual = $29, position = $30,
         environment = COALESCE(tasks.environment, $31),
         pending_on_enter = $32`,
      [
        task.id,
        task.agentId,
        task.text || '',
        task.title || null,
        task.status || 'backlog',
        task.repoProvider || (task.repoFullName ? 'github' : null),
        task.repoFullName || null,
        task.storageProvider || (task.storagePath ? 'onedrive' : null),
        task.storagePath || null,
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
        task.environment || null,
        task._pendingOnEnter || null,
      ]
    );
    // Fast path succeeded — flip the cached flag so we skip the probe forever.
    if (!_envColumnEnsured) _envColumnEnsured = true;
  } catch (err: any) {
    // Postgres SQLSTATE 42703 = undefined_column. Self-heal only on the
    // 'environment' column to avoid masking unrelated schema drift.
    const isMissingEnvCol =
      !_isRetry &&
      (err?.code === '42703' || /column "?environment"? .* does not exist/i.test(err?.message || ''));
    if (isMissingEnvCol) {
      const healed = await _ensureEnvironmentColumn(pool);
      if (healed) {
        await _doSaveTask(task, true);
        return;
      }
    }
    console.error(`Failed to save task ${task.id}:`, err.message);
    throw err;
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
    const updated = await pool.query(
      'UPDATE tasks SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id',
      [taskId]
    );
    if (updated.rows.length === 0) return null;
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to restore task:', err.message);
    return null;
  }
}

export async function getDeletedTasks() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(`${TASK_SELECT} WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC`);
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
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1 AND t.deleted_at IS NOT NULL`, [taskId]);
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
 *
 * When `environment` is provided, only tasks tagged with that environment are
 * returned. Tasks created before this column existed (environment IS NULL)
 * are processed by the "prod" instance so legacy behavior is preserved.
 */
export async function getTasksForResume(environment?: string | null) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const params: any[] = [];
    let envFilter = '';
    if (environment) {
      params.push(environment);
      envFilter = environment === 'prod'
        ? `AND (t.environment = $1 OR t.environment IS NULL)`
        : `AND t.environment = $1`;
    }
    const result = await pool.query(`
      SELECT t.*,
             p.id   AS _project_id,
             p.name AS _project_name,
             a.data AS agent_data
      FROM tasks t
      LEFT JOIN boards   b ON t.board_id = b.id
      LEFT JOIN projects p ON b.project_id = p.id
      JOIN agents a ON COALESCE(t.assignee, t.agent_id) = a.id
      WHERE t.deleted_at IS NULL
        AND t.started_at IS NOT NULL
        AND t.status NOT IN ('done', 'backlog', 'error')
        AND (t.execution_status IS NULL OR t.execution_status NOT IN ('watching', 'stopped'))
        AND (t.is_manual IS NULL OR t.is_manual = FALSE)
        ${envFilter}
      ORDER BY t.started_at ASC
    `, params);
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
        pending_on_enter = NULL,
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
 * Clear action_running flags for tasks on startup (service restart recovery).
 * After a crash, no actions are actually running — the flags are stale. The
 * same goes for execution_status='watching': the watch loop that set it died
 * with the process, and leaving it behind would block both the resume loop
 * and the workflow re-arm forever.
 *
 * When `environment` is provided, only tasks tagged for that environment are
 * cleared, so a sibling replica's locks aren't wiped on restart. NULL env is
 * treated as "prod" so legacy tasks still recover on the prod replica.
 */
export async function clearAllStaleActionRunning(environment?: string | null) {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const params: any[] = [];
    let envFilter = '';
    if (environment) {
      params.push(environment);
      envFilter = environment === 'prod'
        ? `AND (environment = $1 OR environment IS NULL)`
        : `AND environment = $1`;
    }
    const result = await pool.query(`
      UPDATE tasks SET
        action_running = FALSE,
        action_running_agent_id = NULL,
        execution_status = CASE WHEN execution_status = 'watching' THEN NULL ELSE execution_status END,
        updated_at = NOW()
      WHERE (action_running = TRUE OR execution_status = 'watching') AND deleted_at IS NULL
      ${envFilter}
    `, params);
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
      `${TASK_SELECT} WHERE t.agent_id = $1 AND t.status NOT IN ('done','backlog','error') AND t.deleted_at IS NULL ORDER BY t.created_at`,
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
      `${TASK_SELECT} WHERE t.board_id = $1 AND t.deleted_at IS NULL ORDER BY t.created_at`,
      [boardId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get tasks for board:', err.message);
    return [];
  }
}

/**
 * Find the board that has the most tasks for a given project name.
 * Resolved through boards.project_id → projects.name. Returns the board_id or null.
 */
export async function getBoardWithMostTasksForProject(projectName) {
  const pool = getPool();
  if (!pool || !projectName) return null;
  try {
    const result = await pool.query(
      `SELECT t.board_id, COUNT(*) AS task_count
       FROM tasks t
       JOIN boards b   ON t.board_id = b.id
       JOIN projects p ON b.project_id = p.id
       WHERE p.name ILIKE $1 AND t.deleted_at IS NULL
       GROUP BY t.board_id
       ORDER BY task_count DESC
       LIMIT 1`,
      [projectName]
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
      `${TASK_SELECT} WHERE (t.assignee = $1 OR (t.assignee IS NULL AND t.agent_id = $1)) AND t.deleted_at IS NULL ORDER BY t.created_at`,
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
      `${TASK_SELECT}
       WHERE (t.assignee = $1 OR (t.assignee IS NULL AND t.agent_id = $1))
         AND t.status NOT IN ('done','backlog','error')
         AND t.started_at IS NOT NULL
         AND t.deleted_at IS NULL
       ORDER BY t.started_at ASC LIMIT 1`,
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
 * Get all recurring tasks (any status). The reset scheduler decides whether
 * each task is due based on its own `recurrence.lastResetAt` (or fallbacks),
 * independently of the workflow status — so a task stuck in `error` or in a
 * mid-workflow column still gets re-armed on its next interval.
 */
export async function getRecurringTasks() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `${TASK_SELECT}
       WHERE t.recurrence IS NOT NULL
         AND t.deleted_at IS NULL`
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get recurring tasks:', err.message);
    return [];
  }
}

/**
 * Free-text + faceted search across the task history.
 *
 * All filters are optional. `query` matches title/text/error case-insensitively.
 * Date filters use ISO timestamps. By default soft-deleted tasks are excluded.
 * Returns up to `limit` rows (default 50, hard cap 200) ordered newest-first.
 */
export async function searchTasks(opts: {
  query?: string | null;
  agentId?: string | null;
  project?: string | null;
  boardId?: string | null;
  status?: string | null;
  repoFullName?: string | null;
  createdAfter?: string | Date | null;
  createdBefore?: string | Date | null;
  completedAfter?: string | Date | null;
  completedBefore?: string | Date | null;
  onlyCompleted?: boolean | null;
  includeDeleted?: boolean | null;
  limit?: number | null;
  offset?: number | null;
} = {}) {
  const pool = getPool();
  if (!pool) return { total: 0, returned: 0, tasks: [] };
  try {
    const conditions: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (!opts.includeDeleted) conditions.push('t.deleted_at IS NULL');

    if (opts.query && opts.query.trim()) {
      conditions.push(`(t.text ILIKE $${idx} OR t.title ILIKE $${idx} OR t.error ILIKE $${idx})`);
      params.push(`%${opts.query.trim()}%`);
      idx++;
    }
    if (opts.agentId) {
      conditions.push(`(t.agent_id = $${idx} OR t.assignee = $${idx})`);
      params.push(opts.agentId);
      idx++;
    }
    if (opts.project) {
      conditions.push(`p.name ILIKE $${idx}`);
      params.push(opts.project);
      idx++;
    }
    if (opts.boardId) {
      conditions.push(`t.board_id = $${idx}`);
      params.push(opts.boardId);
      idx++;
    }
    if (opts.status) {
      conditions.push(`t.status = $${idx}`);
      params.push(opts.status);
      idx++;
    }
    if (opts.repoFullName) {
      conditions.push(`t.repo_full_name ILIKE $${idx}`);
      params.push(opts.repoFullName);
      idx++;
    }
    if (opts.createdAfter) {
      conditions.push(`t.created_at >= $${idx}`);
      params.push(opts.createdAfter);
      idx++;
    }
    if (opts.createdBefore) {
      conditions.push(`t.created_at <= $${idx}`);
      params.push(opts.createdBefore);
      idx++;
    }
    if (opts.completedAfter) {
      conditions.push(`t.completed_at >= $${idx}`);
      params.push(opts.completedAfter);
      idx++;
    }
    if (opts.completedBefore) {
      conditions.push(`t.completed_at <= $${idx}`);
      params.push(opts.completedBefore);
      idx++;
    }
    if (opts.onlyCompleted) {
      conditions.push(`t.completed_at IS NOT NULL`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(opts.limit || 50, 200));
    const offset = Math.max(0, opts.offset || 0);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM tasks t
       LEFT JOIN boards   b ON t.board_id = b.id
       LEFT JOIN projects p ON b.project_id = p.id
       ${where}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const result = await pool.query(
      `${TASK_SELECT} ${where} ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const tasks = result.rows.map(rowToTask);
    return { total, returned: tasks.length, tasks };
  } catch (err) {
    console.error('Failed to search tasks:', err.message);
    return { total: 0, returned: 0, tasks: [] };
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
    const conditions = ['t.deleted_at IS NULL'];
    const params = [];
    let idx = 1;
    if (status) {
      conditions.push(`t.status = $${idx}`);
      params.push(status);
      idx++;
    }
    if (boardId) {
      conditions.push(`t.board_id = $${idx}`);
      params.push(boardId);
      idx++;
    }
    const result = await pool.query(
      `${TASK_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY t.position, t.created_at`,
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
      `${TASK_SELECT} WHERE t.source->>'jiraKey' = $1 AND t.deleted_at IS NULL LIMIT 1`,
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
    'text', 'title', 'status', 'repo_provider', 'repo_full_name', 'storage_provider', 'storage_path',
    'board_id', 'assignee',
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
    isManual: 'is_manual', repoProvider: 'repo_provider', repoFullName: 'repo_full_name',
    storageProvider: 'storage_provider', storagePath: 'storage_path',
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
    const updated = await pool.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING id`,
      values
    );
    if (updated.rows.length === 0) return null;
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to update task fields:', err.message);
    return null;
  }
}
