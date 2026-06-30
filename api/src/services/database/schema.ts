import pg from 'pg';
import { setPool, setDatabaseConnected } from './connection.js';
import { ensureBaseSchema, ensureSchemaIndexes } from './baseSchema.js';
import { runSchemaMigrations } from './migrations.js';
import { loadSettingsCache } from './settings.js';
import { refreshTokenSummaryCache } from './tokenUsage.js';
import { loadOAuthTokens } from './oauthTokens.js';
import { readSecretOptional } from '../../secrets.js';

const { Pool } = pg;

export async function initDatabase(retries = 5, delayMs = 3000) {
  const connectionString = readSecretOptional('DATABASE_CONNECTION_STRING');

  if (!connectionString) {
    const msg = 'DATABASE_CONNECTION_STRING is not set — agents will not be persisted and authentication will fail (no users table to query).';
    if (process.env.NODE_ENV === 'production') {
      console.error('❌ ' + msg);
    } else {
      console.warn('⚠️  ' + msg);
    }
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    let pool: any = null;
    try {
      pool = new Pool({ connectionString });

      await pool.query('SELECT NOW()');
      console.log('✅ Connected to PostgreSQL');

      await ensureBaseSchema(pool);
      await runSchemaMigrations(pool);
      await ensureSchemaIndexes(pool);

      setPool(pool);
      setDatabaseConnected(true);

      await loadSettingsCache();
      await refreshTokenSummaryCache();
      await loadOAuthTokens();

      return true;
    } catch (err) {
      console.error(`❌ Database connection failed (attempt ${attempt}/${retries}):`, err.message);
      setPool(null);
      setDatabaseConnected(false);
      if (pool) {
        await pool.end().catch(() => {});
      }
      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error('❌ All database connection attempts failed, running without persistence');
  return false;
}
