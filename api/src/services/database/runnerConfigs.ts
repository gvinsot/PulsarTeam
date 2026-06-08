import { getPool } from './connection.js';
import { encryptFields, decryptFields } from '../../lib/crypto.js';

// The whole files blob is a secret (a runner's .env can carry provider API
// keys), so we store it as a single encrypted JSON string under `files`.
const SECRET_FIELDS = ['files'] as const;

export interface RunnerConfigFiles {
  [relativePath: string]: string;
}

/** Read the persisted config files for a runner+scope, or null if none. */
export async function getRunnerConfig(
  runner: string,
  scopeType: string,
  scopeId: string,
): Promise<{ files: RunnerConfigFiles } | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT data FROM runner_configs WHERE runner = $1 AND scope_type = $2 AND scope_id = $3',
      [runner, scopeType, scopeId],
    );
    const data = result.rows[0]?.data;
    if (!data) return null;
    const dec = decryptFields(data, SECRET_FIELDS);
    let files: RunnerConfigFiles = {};
    try {
      files = typeof dec.files === 'string' ? JSON.parse(dec.files) : (dec.files || {});
    } catch {
      files = {};
    }
    return { files };
  } catch (err: any) {
    console.error('Failed to get runner config:', err.message);
    return null;
  }
}

/** Upsert the config files for a runner+scope. */
export async function saveRunnerConfig(
  runner: string,
  scopeType: string,
  scopeId: string,
  files: RunnerConfigFiles,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    const blob = encryptFields({ files: JSON.stringify(files || {}) }, SECRET_FIELDS);
    await pool.query(
      `INSERT INTO runner_configs (runner, scope_type, scope_id, data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (runner, scope_type, scope_id) DO UPDATE SET data = $4, updated_at = NOW()`,
      [runner, scopeType, scopeId, JSON.stringify(blob)],
    );
  } catch (err: any) {
    console.error('Failed to save runner config:', err.message);
  }
}

export async function deleteRunnerConfig(
  runner: string,
  scopeType: string,
  scopeId: string,
): Promise<void> {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      'DELETE FROM runner_configs WHERE runner = $1 AND scope_type = $2 AND scope_id = $3',
      [runner, scopeType, scopeId],
    );
  } catch (err: any) {
    console.error('Failed to delete runner config:', err.message);
  }
}
