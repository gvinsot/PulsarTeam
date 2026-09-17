import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type {
  OAuthClientInformationMixed,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import { getPool } from './database/connection.js';
import { encryptString, tryDecrypt } from '../lib/crypto.js';

export interface RemoteScope {
  type: 'agent' | 'board';
  id: string;
}
export interface RemoteCredentials {
  url: string;
  mode: 'oauth' | 'api_key';
  apiKey?: string;
  headerName?: string;
  prefix?: string;
  redirectUrl?: string;
  clientInformation?: OAuthClientInformationMixed;
  discovery?: OAuthDiscoveryState;
  tokens?: OAuthTokens;
  expiresAt?: number;
  verifier?: string;
}
export interface RemoteFlow {
  serverId: string;
  scope: RemoteScope;
  userId: string;
  credentials: RemoteCredentials;
}
export function remotePool() {
  const pool = getPool();
  if (!pool) throw new Error('Database required for MCP connections');
  return pool;
}
export const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');

export async function readRemoteCredentials(
  serverId: string,
  scope: RemoteScope,
  db = remotePool()
) {
  const result = await db.query(
    'SELECT secret FROM remote_mcp_connections WHERE server_id=$1 AND scope_type=$2 AND scope_id=$3',
    [serverId, scope.type, scope.id]
  );
  return result.rows[0]
    ? (JSON.parse(tryDecrypt(result.rows[0].secret)) as RemoteCredentials)
    : null;
}

export async function writeRemoteCredentials(
  serverId: string,
  scope: RemoteScope,
  data: RemoteCredentials
) {
  await remotePool().query(
    `INSERT INTO remote_mcp_connections(server_id, scope_type, scope_id, secret) VALUES ($1,$2,$3,$4)
     ON CONFLICT (server_id,scope_type,scope_id) DO UPDATE SET secret=$4, updated_at=NOW()`,
    [serverId, scope.type, scope.id, encryptString(JSON.stringify(data))]
  );
}

// Serialize refresh-token rotation and disconnect across replicas. Fail fast
// under contention rather than exhausting the pool with lock waiters.
export async function withRemoteLock<T>(
  serverId: string,
  scope: RemoteScope,
  fn: () => Promise<T>
): Promise<T> {
  const client: PoolClient = await remotePool().connect();
  const key = JSON.stringify(['remote-mcp', serverId, scope.type, scope.id]);
  let locked = false;
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
      [key]
    );
    locked = result.rows[0].locked;
    if (!locked) throw new Error('Cette connexion MCP est occupée. Réessayez dans un instant.');
    return await fn();
  } finally {
    let broken = false;
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [key]);
      } catch {
        broken = true;
      }
    }
    // Destroy a failed socket so its session lock cannot return to the pool.
    client.release(broken);
  }
}

export async function saveRemoteFlow(state: string, flow: RemoteFlow) {
  const db = remotePool();
  await db.query('DELETE FROM remote_mcp_oauth_flows WHERE expires_at < NOW()');
  await db.query(
    `INSERT INTO remote_mcp_oauth_flows(state_hash,server_id,scope_type,scope_id,secret,expires_at)
     VALUES ($1,$2,$3,$4,$5,NOW() + INTERVAL '10 minutes')`,
    [
      stateHash(state),
      flow.serverId,
      flow.scope.type,
      flow.scope.id,
      encryptString(JSON.stringify(flow)),
    ]
  );
}
export async function consumeRemoteFlow(state: string): Promise<RemoteFlow | null> {
  const result = await remotePool().query(
    'DELETE FROM remote_mcp_oauth_flows WHERE state_hash=$1 RETURNING secret, expires_at',
    [stateHash(state)]
  );
  const row = result.rows[0];
  return row && new Date(row.expires_at).getTime() > Date.now()
    ? JSON.parse(tryDecrypt(row.secret))
    : null;
}
export async function peekRemoteFlow(state: string): Promise<RemoteFlow | null> {
  const result = await remotePool().query(
    'SELECT secret FROM remote_mcp_oauth_flows WHERE state_hash=$1 AND expires_at > NOW()',
    [stateHash(state)]
  );
  return result.rows[0] ? JSON.parse(tryDecrypt(result.rows[0].secret)) : null;
}
export async function disconnectRemote(serverId: string, scope: RemoteScope) {
  return withRemoteLock(serverId, scope, async () => {
    const db = remotePool();
    await db.query(
      'DELETE FROM remote_mcp_oauth_flows WHERE server_id=$1 AND scope_type=$2 AND scope_id=$3',
      [serverId, scope.type, scope.id]
    );
    await db.query(
      'DELETE FROM remote_mcp_connections WHERE server_id=$1 AND scope_type=$2 AND scope_id=$3',
      [serverId, scope.type, scope.id]
    );
  });
}
