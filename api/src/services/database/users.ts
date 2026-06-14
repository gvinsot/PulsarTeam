import { getPool } from './connection.js';

export async function getAllUsers() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT id, username, role, display_name, google_id, microsoft_id, github_id, avatar_url, last_seen, terms_accepted_at, tutorial_completed_at, created_at, updated_at FROM users ORDER BY created_at'
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

export async function createUser(username, hashedPassword, role = 'advanced', displayName = '') {
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

const PROVIDER_ID_COLUMNS = { google: 'google_id', microsoft: 'microsoft_id', github: 'github_id' } as const;
type IdProvider = keyof typeof PROVIDER_ID_COLUMNS;

export async function getUserByProviderId(provider: IdProvider, externalId) {
  const col = PROVIDER_ID_COLUMNS[provider];
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(`SELECT * FROM users WHERE ${col} = $1`, [externalId]);
    return result.rows[0] || null;
  } catch (err) {
    console.error(`Failed to get user by ${col}:`, err.message);
    return null;
  }
}

export async function createProviderUser(provider: IdProvider, externalId, username, displayName, avatarUrl, role = 'advanced') {
  const col = PROVIDER_ID_COLUMNS[provider];
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `INSERT INTO users (username, password, role, display_name, ${col}, avatar_url)
       VALUES ($1, NULL, $2, $3, $4, $5)
       RETURNING id, username, role, display_name, ${col}, avatar_url, created_at, updated_at`,
      [username, role, displayName || username, externalId, avatarUrl || null]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new Error('Username already exists');
    throw err;
  }
}

export async function linkProviderId(provider: IdProvider, userId, externalId, avatarUrl) {
  const col = PROVIDER_ID_COLUMNS[provider];
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      `UPDATE users SET ${col} = $2, avatar_url = COALESCE($3, avatar_url), updated_at = NOW()
       WHERE id = $1
       RETURNING id, username, role, display_name, ${col}, avatar_url`,
      [userId, externalId, avatarUrl]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error(`Failed to link ${col}:`, err.message);
    return null;
  }
}

export const getUserByGoogleId = (googleId) => getUserByProviderId('google', googleId);
export const createGoogleUser = (googleId, email, displayName, avatarUrl, role = 'advanced') =>
  createProviderUser('google', googleId, email, displayName, avatarUrl, role);
export const linkGoogleId = (userId, googleId, avatarUrl) => linkProviderId('google', userId, googleId, avatarUrl);

export const getUserByMicrosoftId = (microsoftId) => getUserByProviderId('microsoft', microsoftId);
export const createMicrosoftUser = (microsoftId, email, displayName, avatarUrl, role = 'advanced') =>
  createProviderUser('microsoft', microsoftId, email, displayName, avatarUrl, role);
export const linkMicrosoftId = (userId, microsoftId, avatarUrl) => linkProviderId('microsoft', userId, microsoftId, avatarUrl);

export const getUserByGitHubId = (githubId) => getUserByProviderId('github', githubId);
export const createGitHubUser = (githubId, email, displayName, avatarUrl, role = 'advanced') =>
  createProviderUser('github', githubId, email, displayName, avatarUrl, role);
export const linkGitHubId = (userId, githubId, avatarUrl) => linkProviderId('github', userId, githubId, avatarUrl);

export async function acceptTerms(userId: string) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `UPDATE users SET terms_accepted_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING id, terms_accepted_at`,
      [userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to accept terms:', err.message);
    throw err;
  }
}

export async function completeTutorial(userId: string) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `UPDATE users SET tutorial_completed_at = NOW(), updated_at = NOW()
       WHERE id = $1
       RETURNING id, tutorial_completed_at`,
      [userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to complete tutorial:', err.message);
    throw err;
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
    // Rethrow rather than return 0: callers use `countUsers() === 0` to grant
    // the first user the admin role, so a transient DB error must fail closed.
    console.error('Failed to count users:', err.message);
    throw err;
  }
}
