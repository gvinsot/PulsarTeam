import { getPool } from './connection.js';
import { encryptFields, decryptFields } from '../../lib/crypto.js';

const SECRET_FIELDS = ['apiKey'] as const;

export async function getAllMcpServers() {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query('SELECT data FROM mcp_servers ORDER BY created_at');
    return result.rows.map(row => decryptFields(row.data, SECRET_FIELDS));
  } catch (err) {
    console.error('Failed to load MCP servers:', err.message);
    return [];
  }
}

export async function saveMcpServer(server) {
  const pool = getPool();
  if (!pool) return;

  try {
    const encrypted = encryptFields(server, SECRET_FIELDS);
    await pool.query(
      `INSERT INTO mcp_servers (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [server.id, JSON.stringify(encrypted)]
    );
  } catch (err) {
    console.error('Failed to save MCP server:', err.message);
  }
}

export async function deleteMcpServerFromDb(id) {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM mcp_servers WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete MCP server:', err.message);
  }
}
