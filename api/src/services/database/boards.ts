import { getPool } from './connection.js';

// ── Default board ────────────────────────────────────────────────────────────

const DEFAULT_BOARD_WORKFLOW = {
  columns: [
    { id: 'todo', label: 'Todo', color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done', label: 'Done', color: '#22c55e' },
  ],
  transitions: [
    {
      from: 'in_progress',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { type: 'run_agent', mode: 'decide', role: '', instructions: 'Execute the task' },
        { type: 'change_status', target: '__next__' },
      ],
    },
  ],
  version: 1,
};

export async function ensureDefaultBoard(p) {
  try {
    const existing = await p.query('SELECT id FROM boards WHERE is_default = TRUE LIMIT 1');
    if (existing.rows.length > 0) return;

    // Migrate from legacy workflows table if it exists
    let workflow = DEFAULT_BOARD_WORKFLOW;
    try {
      const legacy = await p.query("SELECT columns, transitions, version FROM workflows WHERE project = '_default'");
      if (legacy.rows.length > 0) {
        const row = legacy.rows[0];
        workflow = {
          columns: row.columns || DEFAULT_BOARD_WORKFLOW.columns,
          transitions: row.transitions || DEFAULT_BOARD_WORKFLOW.transitions,
          version: row.version || 1,
        };
      }
    } catch { /* workflows table may not exist */ }

    await p.query(
      `INSERT INTO boards (name, workflow, filters, position, is_default)
       VALUES ('Default', $1::jsonb, '{}'::jsonb, 0, TRUE)`,
      [JSON.stringify(workflow)]
    );
    console.log('✅ Default board created');
  } catch (err) {
    console.error('Failed to ensure default board:', err.message);
  }
}

export async function getDefaultBoard() {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT id, user_id, name, workflow, filters, position, is_default, created_at, updated_at FROM boards WHERE is_default = TRUE LIMIT 1'
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get default board:', err.message);
    return null;
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
       ORDER BY b.is_default DESC, u.username, b.position, b.created_at`
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
    // Get user's own boards + shared boards + default board
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

    const result = await pool.query(
      `INSERT INTO boards (user_id, name, workflow, filters, position)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id, user_id, name, workflow, filters, position, is_default, plugins, mcp_auth, project_id, created_at, updated_at`,
      [userId, name, JSON.stringify(workflow), JSON.stringify(filters), position]
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
      values.push(value);
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
