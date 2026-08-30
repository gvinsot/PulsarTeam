import { getPool } from './connection.js';
import { errorMessage } from '../../lib/errors.js';

// In-memory settings cache (populated at init, updated on setSetting).
//
// Values are `unknown` because that is what they are: the `settings.value`
// column is TEXT, and loadSettingsCache JSON.parses it with a fallback to the
// raw string. Nothing validates what an older release (or a hand-edited row)
// left there, so the shape is only knowable where a caller has a schema for
// its own key — narrow at the use site.
const _settingsCache: Record<string, unknown> = {};

export function getSetting(key: string): unknown {
  const pool = getPool();
  if (!pool) return null;
  // Synchronous-style: return a cached value. Use getSettingAsync for fresh reads.
  return _settingsCache[key] ?? null;
}

export async function getSettingAsync(key: string): Promise<unknown> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query<{ value: string }>(
      'SELECT value FROM settings WHERE key = $1',
      [key]
    );
    if (result.rows.length === 0) return null;
    try {
      return JSON.parse(result.rows[0].value);
    } catch {
      return result.rows[0].value;
    }
  } catch (err) {
    console.error('Failed to get setting:', errorMessage(err));
    return null;
  }
}

export async function setSetting(key: string, value: unknown) {
  const pool = getPool();
  if (!pool) return;
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  try {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, serialized]
    );
    _settingsCache[key] = typeof value === 'string' ? value : value;
  } catch (err) {
    console.error('Failed to save setting:', errorMessage(err));
  }
}

export async function loadSettingsCache() {
  const pool = getPool();
  if (!pool) return;
  try {
    const result = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    );
    for (const row of result.rows) {
      try {
        _settingsCache[row.key] = JSON.parse(row.value);
      } catch {
        _settingsCache[row.key] = row.value;
      }
    }
  } catch (err) {
    console.error('Failed to load settings cache:', errorMessage(err));
  }
}
