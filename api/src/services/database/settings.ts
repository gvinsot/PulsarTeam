import { getPool } from './connection.js';

// In-memory settings cache (populated at init, updated on setSetting)
const _settingsCache = {};

export function getSetting(key) {
  const pool = getPool();
  if (!pool) return null;
  // Synchronous-style: return a cached value. Use getSettingAsync for fresh reads.
  return _settingsCache[key] ?? null;
}

export async function getSettingAsync(key) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    try {
      return JSON.parse(result.rows[0].value);
    } catch {
      return result.rows[0].value;
    }
  } catch (err) {
    console.error('Failed to get setting:', err.message);
    return null;
  }
}

export async function setSetting(key, value) {
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
    console.error('Failed to save setting:', err.message);
  }
}

export async function loadSettingsCache() {
  const pool = getPool();
  if (!pool) return;
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    for (const row of result.rows) {
      try {
        _settingsCache[row.key] = JSON.parse(row.value);
      } catch {
        _settingsCache[row.key] = row.value;
      }
    }
  } catch (err) {
    console.error('Failed to load settings cache:', err.message);
  }
}
