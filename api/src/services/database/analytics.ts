import { getPool } from './connection.js';
import { errorMessage } from '../../lib/errors.js';

/**
 * Read-only aggregates behind the Analytics view (routes/analytics.ts):
 * board usage, the project's task mix and the errors tasks ran into.
 *
 * Every query reads the tasks table directly (not the agent manager's in-memory
 * map) so board-level tasks created without an agent are counted too. Deleted
 * rows and recurring-task templates are never counted: a template is a rule,
 * not work.
 */

/**
 * The narrowings every analytics query supports. They AND together.
 *
 * `boardIds` — the caller's accessible boards; `null` means "no restriction"
 * (admins). An empty array matches nothing, which is the correct answer for a
 * user who can see no board.
 * `projectId` — restricts to the boards attached to that project.
 */
export interface AnalyticsScope {
  boardIds?: string[] | null;
  projectId?: string | null;
}

/**
 * Build the trailing `AND ...` clauses for a query aliasing tasks as `t` and
 * boards as `b`. `nextIndex` is the first free `$n` placeholder; the returned
 * params must be appended after the query's own leading params.
 */
export function analyticsScopeFilter(scope: AnalyticsScope, nextIndex: number) {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (scope.boardIds) {
    params.push(scope.boardIds);
    clauses.push(` AND b.id = ANY($${nextIndex + params.length - 1}::uuid[])`);
  }
  if (scope.projectId) {
    params.push(scope.projectId);
    clauses.push(` AND b.project_id = $${nextIndex + params.length - 1}::uuid`);
  }
  return { clause: clauses.join(''), params };
}

const LIVE_TASK = `t.deleted_at IS NULL AND t.is_template IS NOT TRUE`;

const num = (v: unknown) => Number(v) || 0;

// ── Board usage ──────────────────────────────────────────────────────────────

export interface BoardUsageRow {
  board_id: string;
  board_name: string;
  project_id: string | null;
  project_name: string | null;
  owner_username: string | null;
  total_tasks: number;
  open_tasks: number;
  in_error: number;
  created_in_window: number;
  completed_in_window: number;
  agent_count: number;
  total_cost: number;
  total_tokens: number;
  last_activity: string | null;
}

/**
 * One row per board in scope: task volume, activity within the window, the
 * agents attached to it and the token spend those agents produced.
 *
 * Token spend follows the same attribution as the budget queries
 * (token_usage_log.agent_id → agents.board_id); agent_id is compared as TEXT so
 * a non-UUID value simply does not match instead of failing the cast.
 */
export async function getBoardUsageStats(
  days: number,
  scope: AnalyticsScope
): Promise<BoardUsageRow[]> {
  const pool = getPool();
  if (!pool) return [];
  const filter = analyticsScopeFilter(scope, 2);
  try {
    const result = await pool.query(
      `WITH task_stats AS (
         SELECT t.board_id,
                COUNT(*) AS total_tasks,
                COUNT(*) FILTER (WHERE t.status <> 'done') AS open_tasks,
                COUNT(*) FILTER (WHERE t.status = 'error') AS in_error,
                COUNT(*) FILTER (WHERE t.created_at >= NOW() - INTERVAL '1 day' * $1) AS created_in_window,
                COUNT(*) FILTER (WHERE t.completed_at >= NOW() - INTERVAL '1 day' * $1) AS completed_in_window,
                MAX(t.updated_at) AS last_activity
         FROM tasks t
         WHERE ${LIVE_TASK}
         GROUP BY t.board_id
       ),
       agent_stats AS (
         SELECT a.board_id, COUNT(*) AS agent_count
         FROM agents a
         WHERE a.board_id IS NOT NULL
         GROUP BY a.board_id
       ),
       usage_stats AS (
         SELECT a.board_id,
                COALESCE(SUM(u.cost), 0) AS total_cost,
                COALESCE(SUM(u.input_tokens + u.output_tokens), 0) AS total_tokens
         FROM token_usage_log u
         JOIN agents a ON a.id::text = u.agent_id
         WHERE a.board_id IS NOT NULL
           AND u.recorded_at >= NOW() - INTERVAL '1 day' * $1
         GROUP BY a.board_id
       )
       SELECT b.id AS board_id, b.name AS board_name,
              p.id AS project_id, p.name AS project_name,
              usr.username AS owner_username,
              COALESCE(ts.total_tasks, 0) AS total_tasks,
              COALESCE(ts.open_tasks, 0) AS open_tasks,
              COALESCE(ts.in_error, 0) AS in_error,
              COALESCE(ts.created_in_window, 0) AS created_in_window,
              COALESCE(ts.completed_in_window, 0) AS completed_in_window,
              COALESCE(ag.agent_count, 0) AS agent_count,
              COALESCE(us.total_cost, 0) AS total_cost,
              COALESCE(us.total_tokens, 0) AS total_tokens,
              ts.last_activity
       FROM boards b
       LEFT JOIN projects p ON p.id = b.project_id
       LEFT JOIN users usr ON usr.id = b.user_id
       LEFT JOIN task_stats ts ON ts.board_id = b.id
       LEFT JOIN agent_stats ag ON ag.board_id = b.id
       LEFT JOIN usage_stats us ON us.board_id = b.id
       WHERE TRUE${filter.clause}
       ORDER BY COALESCE(ts.created_in_window, 0) + COALESCE(ts.completed_in_window, 0) DESC,
                COALESCE(ts.total_tasks, 0) DESC, b.name`,
      [days, ...filter.params]
    );
    return result.rows.map(r => ({
      board_id: r.board_id,
      board_name: r.board_name,
      project_id: r.project_id,
      project_name: r.project_name,
      owner_username: r.owner_username,
      total_tasks: num(r.total_tasks),
      open_tasks: num(r.open_tasks),
      in_error: num(r.in_error),
      created_in_window: num(r.created_in_window),
      completed_in_window: num(r.completed_in_window),
      agent_count: num(r.agent_count),
      total_cost: num(r.total_cost),
      total_tokens: num(r.total_tokens),
      last_activity: r.last_activity ? new Date(r.last_activity).toISOString() : null,
    }));
  } catch (err) {
    console.error('Failed to get board usage stats:', errorMessage(err));
    return [];
  }
}

/** Tasks created vs completed per day over the window, zero-filled. */
export interface ActivityPoint {
  day: string;
  created: number;
  completed: number;
}

export async function getTaskActivityTimeline(
  days: number,
  scope: AnalyticsScope
): Promise<ActivityPoint[]> {
  const pool = getPool();
  if (!pool) return [];
  const filter = analyticsScopeFilter(scope, 2);
  try {
    const result = await pool.query(
      `WITH scoped AS (
         SELECT t.created_at, t.completed_at
         FROM tasks t JOIN boards b ON b.id = t.board_id
         WHERE ${LIVE_TASK}${filter.clause}
       ),
       series AS (
         SELECT generate_series(
                  date_trunc('day', NOW()) - INTERVAL '1 day' * ($1 - 1),
                  date_trunc('day', NOW()),
                  INTERVAL '1 day') AS day
       )
       SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
              (SELECT COUNT(*) FROM scoped WHERE date_trunc('day', created_at) = s.day) AS created,
              (SELECT COUNT(*) FROM scoped WHERE date_trunc('day', completed_at) = s.day) AS completed
       FROM series s
       ORDER BY s.day`,
      [days, ...filter.params]
    );
    return result.rows.map(r => ({
      day: r.day,
      created: num(r.created),
      completed: num(r.completed),
    }));
  } catch (err) {
    console.error('Failed to get task activity timeline:', errorMessage(err));
    return [];
  }
}

// ── Project task mix ─────────────────────────────────────────────────────────

export interface CountBucket {
  key: string;
  count: number;
}

export interface TaskMixStats {
  total: number;
  /** Tasks created within the window, by task type ('untyped' when unset). */
  byType: CountBucket[];
  /** Tasks completed within the window, by task type. */
  completedByType: CountBucket[];
  /** Current column of every live task (not windowed). */
  byStatus: CountBucket[];
  /** Every live task that is not done yet, by task type (not windowed). */
  openByType: CountBucket[];
  /** Every live task, by task type (not windowed). */
  allByType: CountBucket[];
  /** Tasks created within the window, by priority ('none' when unset). */
  byPriority: CountBucket[];
}

async function countBy(sql: string, params: unknown[]): Promise<CountBucket[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(sql, params);
  return result.rows.map(r => ({ key: String(r.key), count: num(r.count) }));
}

export async function getTaskMixStats(days: number, scope: AnalyticsScope): Promise<TaskMixStats> {
  const empty: TaskMixStats = {
    total: 0,
    byType: [],
    completedByType: [],
    byStatus: [],
    openByType: [],
    allByType: [],
    byPriority: [],
  };
  if (!getPool()) return empty;
  const filter = analyticsScopeFilter(scope, 2);
  const from = `FROM tasks t JOIN boards b ON b.id = t.board_id WHERE ${LIVE_TASK}`;
  const params = [days, ...filter.params];
  const windowed = (column: string) =>
    ` AND t.${column} >= NOW() - INTERVAL '1 day' * $1${filter.clause}`;
  // Not windowed: the current board state. $1 is still bound (and unused) so
  // the scope placeholders keep the same numbering as the windowed queries.
  const current = ` AND $1::int IS NOT NULL${filter.clause}`;
  const typeKey = `COALESCE(NULLIF(t.task_type, ''), 'untyped')`;
  try {
    const [byType, completedByType, byStatus, openByType, allByType, byPriority] =
      await Promise.all([
        countBy(
          `SELECT COALESCE(NULLIF(t.task_type, ''), 'untyped') AS key, COUNT(*) AS count
         ${from}${windowed('created_at')} GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        countBy(
          `SELECT COALESCE(NULLIF(t.task_type, ''), 'untyped') AS key, COUNT(*) AS count
         ${from}${windowed('completed_at')} GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        countBy(
          `SELECT t.status AS key, COUNT(*) AS count
         ${from}${current} GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        countBy(
          `SELECT ${typeKey} AS key, COUNT(*) AS count
         ${from} AND t.status <> 'done'${current} GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        countBy(
          `SELECT ${typeKey} AS key, COUNT(*) AS count
         ${from}${current} GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
        countBy(
          `SELECT COALESCE(NULLIF(t.priority, ''), 'none') AS key, COUNT(*) AS count
         ${from}${windowed('created_at')} GROUP BY 1 ORDER BY 2 DESC`,
          params
        ),
      ]);
    const total = byType.reduce((s, b) => s + b.count, 0);
    return { total, byType, completedByType, byStatus, openByType, allByType, byPriority };
  } catch (err) {
    console.error('Failed to get task mix stats:', errorMessage(err));
    return empty;
  }
}

// ── Errors ───────────────────────────────────────────────────────────────────

export interface ErrorTaskRow {
  id: string;
  title: string;
  board_id: string | null;
  board_name: string | null;
  error: string | null;
  error_from_status: string | null;
  task_type: string | null;
  updated_at: string | null;
}

export interface ErrorStats {
  /** Transitions INTO the error column within the window (from task history). */
  totalErrorEvents: number;
  /** Distinct tasks that hit the error column within the window. */
  tasksWithErrors: number;
  /** Tasks sitting in the error column right now. */
  currentErrorCount: number;
  /** Error events per day, zero-filled. */
  timeline: { day: string; count: number }[];
  /** Error events grouped by the column the task was in when it failed. */
  byStage: CountBucket[];
  /** Error events grouped by board. */
  byBoard: CountBucket[];
  /** Error events grouped by task type. */
  byType: CountBucket[];
  /** Current error messages, normalised and grouped (most frequent first). */
  topMessages: CountBucket[];
  /** The most recently updated tasks currently in error. */
  current: ErrorTaskRow[];
}

/**
 * Normalise an error message so that instances of the same failure group
 * together: ids, hex hashes, numbers and quoted values are masked, whitespace
 * collapsed, and the result truncated.
 */
export function normalizeErrorMessage(message: string | null | undefined): string {
  if (!message) return '(no message)';
  return (
    message
      .split('\n')[0]
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      .replace(/\b[0-9a-f]{12,}\b/gi, '<hash>')
      .replace(/(["'`]).*?\1/g, '<value>')
      .replace(/\d+(\.\d+)?/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || '(no message)'
  );
}

export async function getErrorStats(days: number, scope: AnalyticsScope): Promise<ErrorStats> {
  const empty: ErrorStats = {
    totalErrorEvents: 0,
    tasksWithErrors: 0,
    currentErrorCount: 0,
    timeline: [],
    byStage: [],
    byBoard: [],
    byType: [],
    topMessages: [],
    current: [],
  };
  const pool = getPool();
  if (!pool) return empty;
  const filter = analyticsScopeFilter(scope, 2);
  const params = [days, ...filter.params];
  // Every history entry that moved a task INTO the error column. `at` is an
  // ISO string written by the agent manager; a malformed one is skipped rather
  // than failing the whole cast.
  const events = `
    SELECT t.id AS task_id, b.name AS board_name,
           COALESCE(NULLIF(t.task_type, ''), 'untyped') AS task_type,
           COALESCE(NULLIF(h->>'from', ''), 'unknown') AS stage,
           -- CASE, not a WHERE guard: once the outer window predicate is pushed
           -- down, Postgres may evaluate the cast before any sibling condition.
           CASE WHEN h->>'at' ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (h->>'at')::timestamptz END AS at
    FROM tasks t
    JOIN boards b ON b.id = t.board_id
    CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(t.history) = 'array' THEN t.history ELSE '[]'::jsonb END
    ) AS h
    WHERE ${LIVE_TASK}${filter.clause}
      AND h->>'status' = 'error'`;
  const windowedEvents = `SELECT * FROM (${events}) e WHERE e.at >= NOW() - INTERVAL '1 day' * $1`;
  try {
    const [totals, timeline, byStage, byBoard, byType, currentRows] = await Promise.all([
      pool.query(
        `SELECT COUNT(*) AS events, COUNT(DISTINCT task_id) AS tasks FROM (${windowedEvents}) w`,
        params
      ),
      pool.query(
        `WITH w AS (${windowedEvents}),
         series AS (
           SELECT generate_series(
                    date_trunc('day', NOW()) - INTERVAL '1 day' * ($1 - 1),
                    date_trunc('day', NOW()),
                    INTERVAL '1 day') AS day
         )
         SELECT to_char(s.day, 'YYYY-MM-DD') AS day,
                (SELECT COUNT(*) FROM w WHERE date_trunc('day', w.at) = s.day) AS count
         FROM series s ORDER BY s.day`,
        params
      ),
      countBy(
        `SELECT stage AS key, COUNT(*) AS count FROM (${windowedEvents}) w GROUP BY 1 ORDER BY 2 DESC`,
        params
      ),
      countBy(
        `SELECT board_name AS key, COUNT(*) AS count FROM (${windowedEvents}) w GROUP BY 1 ORDER BY 2 DESC LIMIT 15`,
        params
      ),
      countBy(
        `SELECT task_type AS key, COUNT(*) AS count FROM (${windowedEvents}) w GROUP BY 1 ORDER BY 2 DESC`,
        params
      ),
      pool.query(
        `SELECT t.id, COALESCE(NULLIF(t.title, ''), LEFT(t.text, 120)) AS title,
                b.id AS board_id, b.name AS board_name,
                t.error, t.error_from_status, t.task_type, t.updated_at
         FROM tasks t JOIN boards b ON b.id = t.board_id
         WHERE ${LIVE_TASK} AND t.status = 'error' AND $1::int IS NOT NULL${filter.clause}
         ORDER BY t.updated_at DESC NULLS LAST`,
        params
      ),
    ]);

    const current: ErrorTaskRow[] = currentRows.rows.map(r => ({
      id: r.id,
      title: r.title || '(untitled)',
      board_id: r.board_id,
      board_name: r.board_name,
      error: r.error,
      error_from_status: r.error_from_status,
      task_type: r.task_type,
      updated_at: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
    const messageCounts = new Map<string, number>();
    for (const row of current) {
      const key = normalizeErrorMessage(row.error);
      messageCounts.set(key, (messageCounts.get(key) || 0) + 1);
    }
    const topMessages = [...messageCounts.entries()]
      .map(([key, count]) => ({ key, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15);

    return {
      totalErrorEvents: num(totals.rows[0]?.events),
      tasksWithErrors: num(totals.rows[0]?.tasks),
      currentErrorCount: current.length,
      timeline: timeline.rows.map(r => ({ day: r.day, count: num(r.count) })),
      byStage,
      byBoard,
      byType,
      topMessages,
      current: current.slice(0, 50),
    };
  } catch (err) {
    console.error('Failed to get error stats:', errorMessage(err));
    return empty;
  }
}

// ── Budget limits ────────────────────────────────────────────────────────────

/**
 * Token spend per project over the last `days` days (rolling window), for the
 * per-project budget limits. Usage from agents on a board without a project is
 * not attributed to any project and therefore not returned.
 */
export async function getCostByProject(
  days: number,
  userId: string | null = null
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const pool = getPool();
  if (!pool) return out;
  try {
    const params: unknown[] = [days];
    let userClause = '';
    if (userId) {
      params.push(userId);
      userClause = ` AND u.user_id = $2`;
    }
    const result = await pool.query(
      `SELECT b.project_id, COALESCE(SUM(u.cost), 0) AS total_cost
       FROM token_usage_log u
       JOIN agents a ON a.id::text = u.agent_id
       JOIN boards b ON b.id = a.board_id
       WHERE b.project_id IS NOT NULL
         AND u.recorded_at >= NOW() - INTERVAL '1 day' * $1${userClause}
       GROUP BY b.project_id`,
      params
    );
    for (const row of result.rows) out.set(row.project_id, num(row.total_cost));
  } catch (err) {
    console.error('Failed to get cost by project:', errorMessage(err));
  }
  return out;
}
