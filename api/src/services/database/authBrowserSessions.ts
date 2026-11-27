import { getPool } from './connection.js';
import { encryptString, decryptString } from '../../lib/crypto.js';
import {
  browserCredentials,
  browserSessionSnapshot,
  type BrowserCredentials,
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

/**
 * Disconnect and expiry end the delegation: the stored sign-in credentials go
 * first, so a failure in between never leaves credentials without a session.
 */
export async function deleteBrowserSession(environment: string, key: string): Promise<void> {
  await deleteBrowserCredentials(environment, key);
  await pool().query(
    'DELETE FROM auth_browser_sessions WHERE environment = $1 AND session_key = $2',
    [environment, key]
  );
}

export async function saveBrowserCredentials(
  environment: string,
  key: string,
  credentials: BrowserCredentials
): Promise<void> {
  // Bind the encrypted envelope to its row, like session snapshots.
  await pool().query(
    `INSERT INTO auth_browser_credentials (environment, session_key, ciphertext)
     VALUES ($1, $2, $3) ON CONFLICT (environment, session_key)
     DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = NOW()`,
    [environment, key, encryptString(JSON.stringify({ key, credentials }))]
  );
}

export async function loadBrowserCredentials(
  environment: string,
  key: string
): Promise<BrowserCredentials | null> {
  const result = await pool().query<{ ciphertext: string }>(
    'SELECT ciphertext FROM auth_browser_credentials WHERE environment = $1 AND session_key = $2',
    [environment, key]
  );
  const row = result.rows[0];
  if (!row) return null;
  const envelope = JSON.parse(decryptString(row.ciphertext)) as {
    key?: unknown;
    credentials?: unknown;
  };
  if (envelope.key !== key) throw new Error('Invalid browser credentials envelope');
  return browserCredentials.parse(envelope.credentials);
}

export async function deleteBrowserCredentials(environment: string, key: string): Promise<void> {
  await pool().query(
    'DELETE FROM auth_browser_credentials WHERE environment = $1 AND session_key = $2',
    [environment, key]
  );
}

/** Which of these session keys have stored credentials (no decryption). */
export async function browserCredentialKeys(
  environment: string,
  keys: string[]
): Promise<Set<string>> {
  if (!keys.length) return new Set();
  const result = await pool().query<{ session_key: string }>(
    'SELECT session_key FROM auth_browser_credentials WHERE environment = $1 AND session_key = ANY($2)',
    [environment, keys]
  );
  return new Set(result.rows.map(row => row.session_key));
}
