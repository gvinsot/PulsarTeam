import { getPool } from './connection.js';

// Keep this predicate aligned with the partial index in the migration.
const UNSEEN_TASK = `human_viewed_at IS NULL
  AND source->>'type' IN ('mcp', 'api')
  AND deleted_at IS NULL AND is_template IS NOT TRUE`;

/** Shared across board members; listing tasks never acknowledges them. */
export async function getUnseenTaskCounts(boardIds: string[]): Promise<Record<string, number>> {
  if (!boardIds.length) return {};
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const result = await pool.query<{ board_id: string; count: number }>(
    `SELECT board_id, COUNT(*)::int AS count FROM tasks
     WHERE board_id = ANY($1::uuid[]) AND ${UNSEEN_TASK} GROUP BY board_id`,
    [boardIds]
  );
  return Object.fromEntries(result.rows.map(row => [row.board_id, row.count]));
}

/** Atomic and idempotent. Ordinary task saves never overwrite this column. */
export async function markTaskHumanViewed(boardId: string, taskId: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const result = await pool.query(
    `UPDATE tasks SET human_viewed_at = NOW()
     WHERE id = $1 AND board_id = $2 AND ${UNSEEN_TASK} RETURNING id`,
    [taskId, boardId]
  );
  return result.rows.length > 0;
}

/**
 * Bulk counterpart of markTaskHumanViewed: acknowledges every task the board
 * still counts as unseen, in one atomic statement. Returns the ids actually
 * flipped (empty when the badge was already clear), so the caller publishes an
 * update for those tasks only.
 */
export async function markAllBoardTasksHumanViewed(boardId: string): Promise<string[]> {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const result = await pool.query<{ id: string }>(
    `UPDATE tasks SET human_viewed_at = NOW()
     WHERE board_id = $1 AND ${UNSEEN_TASK} RETURNING id`,
    [boardId]
  );
  return result.rows.map(row => row.id);
}
