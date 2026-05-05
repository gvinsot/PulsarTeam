import { getPool } from './connection.js';

export async function getAllUsers() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT id, username, role, display_name, google_id, avatar_url, last_seen, created_at, updated_at FROM users ORDER BY created_at'
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to load users:', err.message);
    return [];
  }
}

export async function getUserById(id) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user:', err.message);
    return null;
  }
}

export async function getUserByUsername(username) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user by username:', err.message);
    return null;
  }
}

export async function createUser(username, hashedPassword, role = 'basic', displayName = '') {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `INSERT INTO users (username, password, role, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, display_name, created_at, updated_at`,
      [username, hashedPassword, role, displayName || username]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new Error('Username already exists');
    throw err;
  }
}

export async function updateUser(id, fields) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  if (setClauses.length === 0) return getUserById(id);

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, username, role, display_name, created_at, updated_at`,
      values
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.code === '23505') throw new Error('Username already exists');
    throw err;
  }
}

export async function deleteUser(id) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to delete user:', err.message);
    return false;
  }
}

export async function getUserByGoogleId(googleId) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user by google_id:', err.message);
    return null;
  }
}

export async function createGoogleUser(googleId, email, displayName, avatarUrl, role = 'basic') {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `INSERT INTO users (username, password, role, display_name, google_id, avatar_url)
       VALUES ($1, NULL, $2, $3, $4, $5)
       RETURNING id, username, role, display_name, google_id, avatar_url, created_at, updated_at`,
      [email, role, displayName || email, googleId, avatarUrl || null]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new Error('Username already exists');
    throw err;
  }
}

export async function linkGoogleId(userId, googleId, avatarUrl) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `UPDATE users SET google_id = $2, avatar_url = COALESCE($3, avatar_url), updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, role, display_name, google_id, avatar_url`,
      [userId, googleId, avatarUrl]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to link google_id:', err.message);
    return null;
  }
}

export async function updateLastSeen(userId: string) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
  } catch (err) {
    console.error('Failed to update last_seen:', err.message);
  }
}

export async function countUsers() {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM users');
    return parseInt(result.rows[0].count, 10);
  } catch (err) {
    return 0;
  }
}
