import { getPool } from './connection.js';
import { normalizeBoardName } from '../boardDefaults.js';

// ── Legacy default board cleanup ────────────────────────────────────────────

async function relationExists(p, relationName) {
  const result = await p.query('SELECT to_regclass($1) AS relation', [relationName]);
  return Boolean(result.rows[0]?.relation);
}

export async function removeLegacyDefaultBoards(p) {
  try {
    const existing = await p.query(
      `SELECT id FROM boards
       WHERE is_default = TRUE OR lower(btrim(name)) = 'default'`
    );
    const ids = existing.rows.map((row) => row.id);
    if (ids.length === 0) return;

    if (await relationExists(p, 'tasks')) {
      await p.query(
        `UPDATE tasks
         SET board_id = NULL, updated_at = NOW()
         WHERE board_id = ANY($1::uuid[])`,
        [ids]
      );
    }

    if (await relationExists(p, 'agents')) {
      await p.query(
        `UPDATE agents
         SET board_id = NULL,
             data = data - 'boardId',
             updated_at = NOW()
         WHERE board_id = ANY($1::uuid[])
            OR data->>'boardId' = ANY($2::text[])`,
        [ids, ids]
      );
    }

    if (await relationExists(p, 'oauth_tokens')) {
      await p.query(
        `DELETE FROM oauth_tokens
         WHERE scope_type = 'board' AND scope_id = ANY($1::text[])`,
        [ids]
      );
    }

    if (await relationExists(p, 'runner_configs')) {
      await p.query(
        `DELETE FROM runner_configs
         WHERE scope_type = 'board' AND scope_id = ANY($1::text[])`,
        [ids]
      );
    }

    const deleted = await p.query('DELETE FROM boards WHERE id = ANY($1::uuid[])', [ids]);
    if ((deleted.rowCount ?? 0) > 0) {
      console.log(`✅ Removed ${deleted.rowCount} legacy Default board(s)`);
    }
  } catch (err) {
    console.error('Failed to remove legacy Default boards:', err.message);
    throw err;
  }
}

// ── Boards CRUD ──────────────────────────────────────────────────────────────

export async function getAllBoards() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.plugins, b.mcp_auth, b.project_id, b.created_at, b.updated_at,
              u.username, u.display_name
       FROM boards b LEFT JOIN users u ON b.user_id = u.id
       ORDER BY u.username NULLS LAST, b.position, b.created_at`
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get all boards:', err.message);
    return [];
  }
}

export async function getBoardsByUser(userId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    // Get user's own boards + shared boards. There is intentionally no global
    // default board: every user starts with their own "My board".
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.plugins, b.mcp_auth, b.project_id, b.created_at, b.updated_at,
              NULL AS share_permission, NULL AS owner_username
       FROM boards b
       WHERE b.user_id = $1
       UNION ALL
       SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.plugins, b.mcp_auth, b.project_id, b.created_at, b.updated_at,
              bs.permission AS share_permission, u.username AS owner_username
       FROM board_shares bs
       JOIN boards b ON bs.board_id = b.id
       LEFT JOIN users u ON b.user_id = u.id
       WHERE bs.user_id = $1 AND b.user_id != $1
       ORDER BY position, created_at`,
      [userId]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get boards:', err.message);
    return [];
  }
}

export async function getBoardById(id) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT id, user_id, name, workflow, filters, position, is_default, plugins, mcp_auth, project_id, created_at, updated_at FROM boards WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get board:', err.message);
    return null;
  }
}

export async function createBoard(userId, name, workflow = {}, filters = {}) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM boards WHERE user_id = $1',
      [userId]
    );
    const position = posResult.rows[0].next_pos;

    const boardName = normalizeBoardName(name);
    const result = await pool.query(
      `INSERT INTO boards (user_id, name, workflow, filters, position)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id, user_id, name, workflow, filters, position, is_default, plugins, mcp_auth, project_id, created_at, updated_at`,
      [userId, boardName, JSON.stringify(workflow), JSON.stringify(filters), position]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Failed to create board:', err.message);
    throw err;
  }
}

export async function updateBoard(id, fields) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const allowed = ['name', 'workflow', 'filters', 'position', 'plugins', 'mcp_auth'];
  const jsonbFields = ['workflow', 'filters', 'plugins', 'mcp_auth'];
  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    if (jsonbFields.includes(key)) {
      setClauses.push(`${key} = $${idx}::jsonb`);
      values.push(JSON.stringify(value));
    } else {
      setClauses.push(`${key} = $${idx}`);
      values.push(key === 'name' ? normalizeBoardName(value) : value);
    }
    idx++;
  }
  if (setClauses.length === 0) return getBoardById(id);

  setClauses.push('updated_at = NOW()');
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE boards SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, user_id, name, workflow, filters, position, is_default, plugins, mcp_auth, project_id, created_at, updated_at`,
      values
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to update board:', err.message);
    throw err;
  }
}

export async function deleteBoard(id) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM boards WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to delete board:', err.message);
    return false;
  }
}
