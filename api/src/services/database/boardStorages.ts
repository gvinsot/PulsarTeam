import { getPool } from './connection.js';

export interface BoardStorage {
  id: string;
  board_id: string;
  provider: string;
  display_name: string;
  path: string | null;
  root_id: string | null;
  created_at: string;
}

export async function getStoragesForBoard(boardId: string): Promise<BoardStorage[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, board_id, provider, display_name, path, root_id, created_at
     FROM board_storages WHERE board_id = $1 ORDER BY created_at`,
    [boardId]
  );
  return result.rows;
}

export async function getStoragesForProject(projectId: string): Promise<BoardStorage[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT bs.id, bs.board_id, bs.provider, bs.display_name, bs.path, bs.root_id, bs.created_at
     FROM board_storages bs
     JOIN boards b ON bs.board_id = b.id
     WHERE b.project_id = $1
     ORDER BY bs.created_at`,
    [projectId]
  );
  return result.rows;
}

export async function createBoardStorage(
  boardId: string,
  provider: string,
  displayName: string,
  path: string | null,
  rootId: string | null
): Promise<BoardStorage> {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const result = await pool.query(
    `INSERT INTO board_storages (board_id, provider, display_name, path, root_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, board_id, provider, display_name, path, root_id, created_at`,
    [boardId, provider, displayName, path, rootId]
  );
  return result.rows[0];
}

export async function deleteBoardStorage(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query('DELETE FROM board_storages WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}
