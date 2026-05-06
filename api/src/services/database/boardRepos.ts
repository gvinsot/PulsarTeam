import { getPool } from './connection.js';

export interface BoardRepo {
  id: string;
  board_id: string;
  provider: string;
  full_name: string;
  html_url: string | null;
  default_branch: string | null;
  created_at: string;
}

export async function getReposForBoard(boardId: string): Promise<BoardRepo[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, board_id, provider, full_name, html_url, default_branch, created_at
     FROM board_repos WHERE board_id = $1 ORDER BY created_at`,
    [boardId]
  );
  return result.rows;
}

export async function getReposForProject(projectId: string): Promise<BoardRepo[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT br.id, br.board_id, br.provider, br.full_name, br.html_url, br.default_branch, br.created_at
     FROM board_repos br
     JOIN boards b ON br.board_id = b.id
     WHERE b.project_id = $1
     ORDER BY br.created_at`,
    [projectId]
  );
  return result.rows;
}

export async function createBoardRepo(
  boardId: string,
  provider: string,
  fullName: string,
  htmlUrl: string | null,
  defaultBranch: string | null
): Promise<BoardRepo> {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const result = await pool.query(
    `INSERT INTO board_repos (board_id, provider, full_name, html_url, default_branch)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (board_id, provider, full_name) DO UPDATE SET
       html_url = EXCLUDED.html_url,
       default_branch = EXCLUDED.default_branch
     RETURNING id, board_id, provider, full_name, html_url, default_branch, created_at`,
    [boardId, provider, fullName, htmlUrl, defaultBranch]
  );
  return result.rows[0];
}

export async function deleteBoardRepo(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query('DELETE FROM board_repos WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
