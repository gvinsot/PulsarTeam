import { getPool } from './connection.js';
import { encryptString, decryptString } from '../../lib/crypto.js';
import {
  browserSessionSnapshot,
  type BrowserSessionSnapshot,
} from '../../schemas/authBrowserSessions.js';

function pool() {
  const value = getPool();
  if (!value) throw new Error('Database unavailable');
  return value;
}

export async function loadBrowserSessions(environment: string): Promise<BrowserSessionSnapshot[]> {
  const result = await pool().query<{ session_key: string; ciphertext: string }>(
    'SELECT session_key, ciphertext FROM auth_browser_sessions WHERE environment = $1',
    [environment]
  );
  return result.rows.map(row => {
    const snapshot = browserSessionSnapshot.parse(JSON.parse(decryptString(row.ciphertext)));
    // Bind the encrypted envelope to its row, too.
    if (snapshot.key !== row.session_key) throw new Error('Invalid browser session envelope');
    return snapshot;
  });
}

export async function saveBrowserSession(
  environment: string,
  snapshot: BrowserSessionSnapshot
): Promise<void> {
  await pool().query(
    `INSERT INTO auth_browser_sessions (environment, session_key, ciphertext)
     VALUES ($1, $2, $3) ON CONFLICT (environment, session_key)
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = NOW()`,
    [environment, snapshot.key, encryptString(JSON.stringify(snapshot))]
  );
}

export async function deleteBrowserSession(environment: string, key: string): Promise<void> {
  await pool().query(
    'DELETE FROM auth_browser_sessions WHERE environment = $1 AND session_key = $2',
    [environment, key]
  );
}
