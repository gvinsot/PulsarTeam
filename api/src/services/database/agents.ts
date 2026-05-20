import { getPool } from './connection.js';

export async function getAllAgents() {
  const pool = getPool();
  if (!pool) return [];

  try {
    // Clean any leftover todoList from agent JSONB (tasks now live in the tasks table)
    await pool.query(`UPDATE agents SET data = data - 'todoList' WHERE data ? 'todoList'`).catch(() => {});

    const result = await pool.query('SELECT data, owner_id, board_id FROM agents ORDER BY created_at');
    return result.rows.map(row => {
      const { todoList, ...agent } = row.data;
      // Ensure boardId from the DB column is always present in the agent object
      if (row.board_id && !agent.boardId) {
        agent.boardId = row.board_id;
      }
      // Migration: if agent has owner_id but no board_id, preserve ownerId for reference
      if (row.owner_id && !agent.ownerId) {
        agent.ownerId = row.owner_id;
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
      'SELECT data, owner_id, board_id FROM agents WHERE id = $1',
      [id]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const { todoList, ...agent } = row.data;
    if (row.board_id && !agent.boardId) agent.boardId = row.board_id;
    if (row.owner_id && !agent.ownerId) agent.ownerId = row.owner_id;
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
    // Exclude todoList from JSONB — tasks are now stored in the dedicated tasks table
    const { todoList, ...agentData } = agent;
    await pool.query(
      `INSERT INTO agents (id, data, owner_id, board_id, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, owner_id = $3, board_id = $4, updated_at = NOW()`,
      [agent.id, JSON.stringify(agentData), agent.ownerId || null, agent.boardId || null]
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

// ── Agent owner_id helpers (legacy — kept for backward compat) ─────────────

export async function setAgentOwner(agentId, ownerId) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('UPDATE agents SET owner_id = $2 WHERE id = $1', [agentId, ownerId]);
  } catch (err) {
    console.error('Failed to set agent owner:', err.message);
  }
}

export async function getAgentsByOwner(ownerId) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT data FROM agents WHERE owner_id = $1 ORDER BY created_at',
      [ownerId]
    );
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to get agents by owner:', err.message);
    return [];
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
