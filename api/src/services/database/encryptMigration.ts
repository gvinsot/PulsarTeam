/**
 * One-shot migration that encrypts legacy plaintext credentials at rest.
 *
 * Tables covered:
 *   - oauth_tokens.access_token / refresh_token  (TEXT)
 *   - llm_configs.data.apiKey                    (JSONB → string)
 *   - mcp_servers.data.apiKey                    (JSONB → string)
 *
 * Idempotent: rows already in `enc:v1:` format are skipped. Safe to run on
 * every boot — the first launch after deployment encrypts existing rows,
 * subsequent launches are no-ops.
 *
 * Skipped silently when ENCRYPTION_KEY is unset (dev environments may not
 * have it configured; the application then operates without encryption-at-rest
 * and a warning is emitted by validateProductionSecrets()).
 */

import { getPool } from './connection.js';
import { encryptString, isEncrypted } from '../../lib/crypto.js';
import { readSecret } from '../../secrets.js';

export async function migrateEncryptCredentials(): Promise<void> {
  const pool = getPool();
  if (!pool) return;

  if (!readSecret('ENCRYPTION_KEY')) {
    console.warn('[encrypt-migration] ENCRYPTION_KEY not set — skipping at-rest encryption migration');
    return;
  }

  let total = 0;

  // ── oauth_tokens ────────────────────────────────────────────────────────
  try {
    const res = await pool.query(
      'SELECT id, access_token, refresh_token FROM oauth_tokens'
    );
    for (const row of res.rows) {
      const updates: string[] = [];
      const params: any[] = [];
      let i = 1;
      if (row.access_token && !isEncrypted(row.access_token)) {
        updates.push(`access_token = $${i++}`);
        params.push(encryptString(row.access_token));
      }
      if (row.refresh_token && !isEncrypted(row.refresh_token)) {
        updates.push(`refresh_token = $${i++}`);
        params.push(encryptString(row.refresh_token));
      }
      if (updates.length === 0) continue;
      params.push(row.id);
      await pool.query(
        `UPDATE oauth_tokens SET ${updates.join(', ')} WHERE id = $${i}`,
        params
      );
      total++;
    }
  } catch (err) {
    console.error('[encrypt-migration] oauth_tokens failed:', (err as Error).message);
  }

  // ── llm_configs ─────────────────────────────────────────────────────────
  try {
    const res = await pool.query('SELECT id, data FROM llm_configs');
    for (const row of res.rows) {
      const data = row.data || {};
      if (typeof data.apiKey !== 'string' || data.apiKey === '' || isEncrypted(data.apiKey)) continue;
      const updated = { ...data, apiKey: encryptString(data.apiKey) };
      await pool.query('UPDATE llm_configs SET data = $1 WHERE id = $2', [
        JSON.stringify(updated),
        row.id,
      ]);
      total++;
    }
  } catch (err) {
    console.error('[encrypt-migration] llm_configs failed:', (err as Error).message);
  }

  // ── mcp_servers ─────────────────────────────────────────────────────────
  try {
    const res = await pool.query('SELECT id, data FROM mcp_servers');
    for (const row of res.rows) {
      const data = row.data || {};
      if (typeof data.apiKey !== 'string' || data.apiKey === '' || isEncrypted(data.apiKey)) continue;
      const updated = { ...data, apiKey: encryptString(data.apiKey) };
      await pool.query('UPDATE mcp_servers SET data = $1 WHERE id = $2', [
        JSON.stringify(updated),
        row.id,
      ]);
      total++;
    }
  } catch (err) {
    console.error('[encrypt-migration] mcp_servers failed:', (err as Error).message);
  }

  if (total > 0) {
    console.log(`🔐 Encrypted ${total} legacy credential row(s) at rest`);
  }
}
