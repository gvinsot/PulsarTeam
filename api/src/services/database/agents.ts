import { getPool } from './connection.js';

export async function getAllAgents() {
  const pool = getPool();
  if (!pool) return [];

  try {
    const result = await pool.query('SELECT data, board_id FROM agents ORDER BY created_at');
    return result.rows.map(row => {
      const agent = row.data;
      // Ensure boardId from the DB column is always present in the agent object
      if (row.board_id && !agent.boardId) {
        agent.boardId = row.board_id;
      }
      return agent;
    });
  } catch (err) {
    console.error('Failed to load agents:', err.message);
    return [];
  }
}

export async function getAgentById(id) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT data, board_id FROM agents WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const agent = row.data;
    if (row.board_id && !agent.boardId) agent.boardId = row.board_id;
    return agent;
  } catch (err) {
    console.error('Failed to load agent:', err.message);
    return null;
  }
}

export async function saveAgent(agent) {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO agents (id, data, owner_id, board_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, owner_id = $3, board_id = $4, updated_at = NOW()`,
      [agent.id, JSON.stringify(agent), agent.ownerId || null, agent.boardId || null]
    );
  } catch (err) {
    console.error('Failed to save agent:', err.message);
  }
}

export async function deleteAgentFromDb(id) {
  const pool = getPool();
  if (!pool) return;

  try {
    await pool.query('DELETE FROM agents WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete agent:', err.message);
  }
}

// ── Agent owner_id helpers ──────────────────────────────────────────────────

export async function setAgentOwner(agentId, ownerId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('UPDATE agents SET owner_id = $2 WHERE id = $1', [agentId, ownerId]);
  } catch (err) {
    console.error('Failed to set agent owner:', err.message);
  }
}

// ── Agent board_id helpers ─────────────────────────────────────────────────

export async function setAgentBoard(agentId, boardId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('UPDATE agents SET board_id = $2 WHERE id = $1', [agentId, boardId]);
  } catch (err) {
    console.error('Failed to set agent board:', err.message);
  }
}

export async function getAgentsByBoard(boardId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT data FROM agents WHERE board_id = $1 ORDER BY created_at',
      [boardId]
    );
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to get agents by board:', err.message);
    return [];
  }
}
