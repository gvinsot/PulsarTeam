import { getPool } from './connection.js';
import { createJsonDocStore } from './jsonDocStore.js';

const store = createJsonDocStore('agent_skills', {
  orderBy: 'updated_at DESC',
  label: 'agent skill',
  labelPlural: 'agent skills',
});

export const getAllAgentSkills = store.getAll;
export const getAgentSkillById = store.getById;
export const saveAgentSkill = store.save;
export const deleteAgentSkillFromDb = store.remove;

export async function searchAgentSkills(query) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT data, ts_rank(
          to_tsvector('english',
            COALESCE(data->>'name', '') || ' ' ||
            COALESCE(data->>'description', '') || ' ' ||
            COALESCE(data->>'category', '') || ' ' ||
            COALESCE(data->>'instructions', '')
          ),
          plainto_tsquery('english', $1)
        ) AS rank
       FROM agent_skills
       WHERE to_tsvector('english',
          COALESCE(data->>'name', '') || ' ' ||
          COALESCE(data->>'description', '') || ' ' ||
          COALESCE(data->>'category', '') || ' ' ||
          COALESCE(data->>'instructions', '')
        ) @@ plainto_tsquery('english', $1)
          OR data->>'name' ILIKE '%' || $1 || '%'
          OR data->>'description' ILIKE '%' || $1 || '%'
          OR data->>'category' ILIKE '%' || $1 || '%'
       ORDER BY rank DESC, updated_at DESC
       LIMIT 20`,
      [query]
    );
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to search agent skills:', err.message);
    return [];
  }
}
