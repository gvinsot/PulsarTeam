import { getPool } from './connection.js';
import { encryptFields, decryptFields } from '../../lib/crypto.js';

const SECRET_FIELDS = ['apiKey'] as const;

export async function getAllLlmConfigs() {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT data FROM llm_configs ORDER BY created_at');
    return result.rows.map(row => decryptFields(row.data, SECRET_FIELDS));
  } catch (err) {
    console.error('Failed to load LLM configs:', err.message);
    return [];
  }
}

export async function getLlmConfig(id) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT data FROM llm_configs WHERE id = $1', [id]);
    const data = result.rows[0]?.data;
    return data ? decryptFields(data, SECRET_FIELDS) : null;
  } catch (err) {
    console.error('Failed to get LLM config:', err.message);
    return null;
  }
}

export async function saveLlmConfig(config) {
  const pool = getPool();
  if (!pool) return;
  try {
    const encrypted = encryptFields(config, SECRET_FIELDS);
    await pool.query(
      `INSERT INTO llm_configs (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [config.id, JSON.stringify(encrypted)]
    );
  } catch (err) {
    console.error('Failed to save LLM config:', err.message);
  }
}

export async function deleteLlmConfig(id) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('DELETE FROM llm_configs WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete LLM config:', err.message);
  }
}
