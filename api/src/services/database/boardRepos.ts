import { getPool } from './connection.js';

/**
 * Repos used on PulsarTeam are not stored explicitly — they're derived from
 * the `repo_full_name` actually assigned to tasks. The picker list (when
 * creating a task) comes from the board's GitHub plugin OAuth token.
 *
 * These helpers expose the *derived* view: distinct repos seen across tasks.
 */

export interface DerivedRepo {
  provider: string;
  fullName: string;
  htmlUrl: string;
}

function rowToRepo(row: any): DerivedRepo {
  const provider = row.repo_provider || 'github';
  const fullName = row.repo_full_name as string;
  return {
    provider,
    fullName,
    htmlUrl: provider === 'github' ? `https://github.com/${fullName}` : '',
  };
}

/** Distinct repos in use by non-deleted tasks across accessible boards of one project. */
export async function getReposForProject(projectId: string, userId: string | null, role: string): Promise<DerivedRepo[]> {
  const pool = getPool();
  if (!pool) return [];
  if (role !== 'admin' && !userId) return [];
  const accessFilter = role === 'admin'
    ? ''
    : ` AND (
          b.is_default = TRUE
          OR b.user_id = $2
          OR EXISTS (
            SELECT 1 FROM board_shares bs
            WHERE bs.board_id = b.id AND bs.user_id = $2
          )
        )`;
  const params = role === 'admin' ? [projectId] : [projectId, userId];
  const result = await pool.query(
    `SELECT DISTINCT t.repo_provider, t.repo_full_name
     FROM tasks t
     JOIN boards b ON t.board_id = b.id
     WHERE b.project_id = $1
       AND t.repo_full_name IS NOT NULL
       AND t.deleted_at IS NULL${accessFilter}
     ORDER BY t.repo_full_name`,
    params
  );
  return result.rows.map(rowToRepo);
}

/** Distinct repos in use by non-deleted tasks of one board. */
export async function getReposForBoard(boardId: string): Promise<DerivedRepo[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT DISTINCT t.repo_provider, t.repo_full_name
     FROM tasks t
     WHERE t.board_id = $1
       AND t.repo_full_name IS NOT NULL
       AND t.deleted_at IS NULL
     ORDER BY t.repo_full_name`,
    [boardId]
  );
  return result.rows.map(rowToRepo);
}

/**
 * Distinct repos used across the boards a user has access to (admin = all).
 * Powers global pickers (Add Agent, Broadcast).
 */
export async function getAccessibleBoardRepos(userId: string | null, role: string): Promise<DerivedRepo[]> {
  const pool = getPool();
  if (!pool) return [];
  if (role === 'admin' || !userId) {
    const result = await pool.query(
      `SELECT DISTINCT t.repo_provider, t.repo_full_name
       FROM tasks t
       WHERE t.repo_full_name IS NOT NULL AND t.deleted_at IS NULL
       ORDER BY t.repo_full_name`
    );
    return result.rows.map(rowToRepo);
  }
  const result = await pool.query(
    `SELECT DISTINCT t.repo_provider, t.repo_full_name
     FROM tasks t
     JOIN boards b ON t.board_id = b.id
     WHERE t.repo_full_name IS NOT NULL AND t.deleted_at IS NULL
       AND (b.is_default = TRUE
         OR b.user_id = $1
         OR EXISTS (SELECT 1 FROM board_shares bs WHERE bs.board_id = b.id AND bs.user_id = $1))
     ORDER BY t.repo_full_name`,
    [userId]
  );
  return result.rows.map(rowToRepo);
}
