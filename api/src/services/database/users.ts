import { getPool } from './connection.js';
import { errorCode, errorMessage } from '../../lib/errors.js';

/** pg SQLSTATE for a unique-constraint violation. */
const PG_UNIQUE_VIOLATION = '23505';

/**
 * A full `SELECT *` row of the `users` table, mirroring the DDL in
 * baseSchema.ts plus the idempotent ALTERs in migrations.ts. Every nullable
 * column is typed nullable; TIMESTAMPTZ comes back from pg as a `Date`.
 *
 * Only the readers that select the whole row are typed with it. The write
 * paths each RETURN a different explicit column list, so one shared type would
 * be a lie there — see the note above updateUser.
 */
export interface UserRow {
  id: string;
  username: string;
  /** NULL for OAuth-only accounts — migrations.ts drops the NOT NULL. */
  password: string | null;
  role: string;
  display_name: string | null;
  google_id: string | null;
  microsoft_id: string | null;
  github_id: string | null;
  avatar_url: string | null;
  last_seen: Date | null;
  terms_accepted_at: Date | null;
  tutorial_completed_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
}

export async function getAllUsers() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query<Omit<UserRow, 'password'>>(
      'SELECT id, username, role, display_name, google_id, microsoft_id, github_id, avatar_url, last_seen, terms_accepted_at, tutorial_completed_at, created_at, updated_at FROM users ORDER BY created_at'
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to load users:', errorMessage(err));
    return [];
  }
}

export async function getUserById(id: string) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user:', errorMessage(err));
    return null;
  }
}

export async function getUserByUsername(username: string) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query<UserRow>('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user by username:', errorMessage(err));
    return null;
  }
}

export async function createUser(
  username: string,
  hashedPassword: string,
  role = 'advanced',
  displayName = ''
) {
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
    if (errorCode(err) === PG_UNIQUE_VIOLATION) throw new Error('Username already exists');
    throw err;
  }
}

/**
 * Patch an arbitrary set of columns. `fields` is keyed by COLUMN name (not the
 * camelCase API name) because every key is interpolated straight into the SET
 * clause, so the caller is what constrains it — see routes/users.ts, which
 * builds the object from a validated body.
 */
export async function updateUser(id: string, fields: Record<string, unknown>) {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const setClauses: string[] = [];
  const values: unknown[] = [];
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
    if (errorCode(err) === PG_UNIQUE_VIOLATION) throw new Error('Username already exists');
    throw err;
  }
}

export async function deleteUser(id: string) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    console.error('Failed to delete user:', errorMessage(err));
    return false;
  }
}

const PROVIDER_ID_COLUMNS = {
  google: 'google_id',
  microsoft: 'microsoft_id',
  github: 'github_id',
} as const;
type IdProvider = keyof typeof PROVIDER_ID_COLUMNS;

export async function getUserByProviderId(provider: IdProvider, externalId: string) {
  const col = PROVIDER_ID_COLUMNS[provider];
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query<UserRow>(`SELECT * FROM users WHERE ${col} = $1`, [externalId]);
    return result.rows[0] || null;
  } catch (err) {
    console.error(`Failed to get user by ${col}:`, errorMessage(err));
    return null;
  }
}

export async function createProviderUser(
  provider: IdProvider,
  externalId: string,
  username: string,
  displayName: string,
  avatarUrl: string | null,
  role = 'advanced'
) {
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
    if (errorCode(err) === PG_UNIQUE_VIOLATION) throw new Error('Username already exists');
    throw err;
  }
}

export async function linkProviderId(
  provider: IdProvider,
  userId: string,
  externalId: string,
  avatarUrl: string | null
) {
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
    console.error(`Failed to link ${col}:`, errorMessage(err));
    return null;
  }
}

// The per-provider aliases below mirror the LoginProviderSpec DB hooks in
// routes/authLogin.ts one for one: getByProviderId(id), linkProviderId(userId,
// id, avatarUrl | null) and createUser(id, loginUsername, displayName,
// avatarUrl | null, role). `avatarUrl` is nullable because every provider
// profile mapper falls back to `null` when the picture is absent.
export const getUserByGoogleId = (googleId: string) => getUserByProviderId('google', googleId);
export const createGoogleUser = (
  googleId: string,
  email: string,
  displayName: string,
  avatarUrl: string | null,
  role = 'advanced'
) => createProviderUser('google', googleId, email, displayName, avatarUrl, role);
export const linkGoogleId = (userId: string, googleId: string, avatarUrl: string | null) =>
  linkProviderId('google', userId, googleId, avatarUrl);

export const getUserByMicrosoftId = (microsoftId: string) =>
  getUserByProviderId('microsoft', microsoftId);
export const createMicrosoftUser = (
  microsoftId: string,
  email: string,
  displayName: string,
  avatarUrl: string | null,
  role = 'advanced'
) => createProviderUser('microsoft', microsoftId, email, displayName, avatarUrl, role);
export const linkMicrosoftId = (userId: string, microsoftId: string, avatarUrl: string | null) =>
  linkProviderId('microsoft', userId, microsoftId, avatarUrl);

export const getUserByGitHubId = (githubId: string) => getUserByProviderId('github', githubId);
export const createGitHubUser = (
  githubId: string,
  email: string,
  displayName: string,
  avatarUrl: string | null,
  role = 'advanced'
) => createProviderUser('github', githubId, email, displayName, avatarUrl, role);
export const linkGitHubId = (userId: string, githubId: string, avatarUrl: string | null) =>
  linkProviderId('github', userId, githubId, avatarUrl);

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
    console.error('Failed to accept terms:', errorMessage(err));
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
    console.error('Failed to complete tutorial:', errorMessage(err));
    throw err;
  }
}

export async function updateLastSeen(userId: string) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('UPDATE users SET last_seen = NOW() WHERE id = $1', [userId]);
  } catch (err) {
    console.error('Failed to update last_seen:', errorMessage(err));
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
    console.error('Failed to count users:', errorMessage(err));
    throw err;
  }
}
