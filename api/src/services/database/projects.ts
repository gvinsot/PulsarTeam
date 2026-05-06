import { getPool } from './connection.js';

export interface Project {
  id: string;
  name: string;
  description: string;
  rules: string;
  owner_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function getAllProjects(): Promise<Project[]> {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    'SELECT id, name, description, rules, owner_id, created_at, updated_at FROM projects ORDER BY name'
  );
  return result.rows;
}

export async function getProjectById(id: string): Promise<Project | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    'SELECT id, name, description, rules, owner_id, created_at, updated_at FROM projects WHERE id = $1',
    [id]
  );
  return result.rows[0] || null;
}

export async function getProjectByName(name: string): Promise<Project | null> {
  const pool = getPool();
  if (!pool) return null;
  const result = await pool.query(
    'SELECT id, name, description, rules, owner_id, created_at, updated_at FROM projects WHERE name = $1',
    [name]
  );
  return result.rows[0] || null;
}

export async function createProject(
  name: string,
  description: string,
  rules: string,
  ownerId: string | null
): Promise<Project> {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const result = await pool.query(
    `INSERT INTO projects (name, description, rules, owner_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, name, description, rules, owner_id, created_at, updated_at`,
    [name, description, rules, ownerId]
  );
  return result.rows[0];
}

export async function updateProject(
  id: string,
  fields: Partial<Pick<Project, 'name' | 'description' | 'rules'>>
): Promise<Project | null> {
  const pool = getPool();
  if (!pool) throw new Error('Database not connected');
  const allowed = ['name', 'description', 'rules'];
  const setClauses: string[] = [];
  const values: any[] = [];
  let idx = 1;
  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  if (setClauses.length === 0) return getProjectById(id);
  setClauses.push('updated_at = NOW()');
  values.push(id);
  const result = await pool.query(
    `UPDATE projects SET ${setClauses.join(', ')} WHERE id = $${idx}
     RETURNING id, name, description, rules, owner_id, created_at, updated_at`,
    values
  );
  return result.rows[0] || null;
}

export async function deleteProject(id: string): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query('DELETE FROM projects WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function getBoardsForProject(projectId: string) {
  const pool = getPool();
  if (!pool) return [];
  const result = await pool.query(
    `SELECT id, user_id, name, workflow, filters, position, is_default, plugins, mcp_auth, project_id, created_at, updated_at
     FROM boards WHERE project_id = $1 ORDER BY position, created_at`,
    [projectId]
  );
  return result.rows;
}

export async function setBoardProject(boardId: string, projectId: string | null): Promise<boolean> {
  const pool = getPool();
  if (!pool) return false;
  const result = await pool.query(
    'UPDATE boards SET project_id = $1, updated_at = NOW() WHERE id = $2',
    [projectId, boardId]
  );
  return (result.rowCount ?? 0) > 0;
}
