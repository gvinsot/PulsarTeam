import { getPool } from './connection.js';

export async function getBoardShares(boardId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT bs.id, bs.board_id, bs.user_id, bs.permission, bs.shared_by, bs.created_at,
              u.username, u.display_name,
              sb.username AS shared_by_username
       FROM board_shares bs
       JOIN users u ON bs.user_id = u.id
       LEFT JOIN users sb ON bs.shared_by = sb.id
       WHERE bs.board_id = $1
       ORDER BY bs.created_at`,
      [boardId]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get board shares:', err.message);
    return [];
  }
}

export async function getBoardShare(boardId, userId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT id, board_id, user_id, permission, shared_by, created_at FROM board_shares WHERE board_id = $1 AND user_id = $2',
      [boardId, userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get board share:', err.message);
    return null;
  }
}

export async function createBoardShare(boardId, userId, permission, sharedBy) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `INSERT INTO board_shares (board_id, user_id, permission, shared_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO UPDATE SET permission = $3
       RETURNING id, board_id, user_id, permission, shared_by, created_at`,
      [boardId, userId, permission, sharedBy]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Failed to create board share:', err.message);
    throw err;
  }
}

export async function updateBoardShare(boardId, userId, permission) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `UPDATE board_shares SET permission = $3 WHERE board_id = $1 AND user_id = $2
       RETURNING id, board_id, user_id, permission, shared_by, created_at`,
      [boardId, userId, permission]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to update board share:', err.message);
    throw err;
  }
}

export async function deleteBoardShare(boardId, userId) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query(
      'DELETE FROM board_shares WHERE board_id = $1 AND user_id = $2',
      [boardId, userId]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to delete board share:', err.message);
    return false;
  }
}

export async function getSharedBoardsForUser(userId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.created_at, b.updated_at,
              bs.permission AS share_permission,
              u.username AS owner_username, u.display_name AS owner_display_name
       FROM board_shares bs
       JOIN boards b ON bs.board_id = b.id
       LEFT JOIN users u ON b.user_id = u.id
       WHERE bs.user_id = $1
       ORDER BY b.position, b.created_at`,
      [userId]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get shared boards:', err.message);
    return [];
  }
}

export async function logBoardAudit(
  boardId,
  action,
  actorId,
  actorUsername,
  targetUserId,
  targetUsername,
  details = null
) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO board_audit_logs (board_id, action, actor_id, actor_username, target_user_id, target_username, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        boardId,
        action,
        actorId,
        actorUsername,
        targetUserId,
        targetUsername,
        details ? JSON.stringify(details) : null,
      ]
    );
  } catch (err) {
    console.error('Failed to log board audit:', err.message);
  }
}

export async function getBoardAuditLogs(boardId, limit = 50) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT * FROM board_audit_logs WHERE board_id = $1 ORDER BY created_at DESC LIMIT $2',
      [boardId, limit]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get board audit logs:', err.message);
    return [];
  }
}
