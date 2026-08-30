import pg from 'pg';
import type { Pool as PgPool } from 'pg';
import { setPool, setDatabaseConnected, POOL_OPTIONS } from './connection.js';
import { ensureBaseSchema, ensureSchemaIndexes } from './baseSchema.js';
import { runSchemaMigrations } from './migrations.js';
import { loadSettingsCache } from './settings.js';
import { refreshTokenSummaryCache } from './tokenUsage.js';
import { loadOAuthTokens } from './oauthTokens.js';
import { readSecretOptional } from '../../secrets.js';
import { errorMessage } from '../../lib/errors.js';

const { Pool } = pg;

export async function initDatabase(retries = 5, delayMs = 3000) {
  const connectionString = readSecretOptional('DATABASE_CONNECTION_STRING');

  if (!connectionString) {
    const msg =
      'DATABASE_CONNECTION_STRING is not set — agents will not be persisted and authentication will fail (no users table to query).';
    if (process.env.NODE_ENV === 'production') {
      console.error('❌ ' + msg);
    } else {
      console.warn('⚠️  ' + msg);
    }
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    let pool: PgPool | null = null;
    try {
      // POOL_OPTIONS first so the connection string still wins if it ever
      // carries an overlapping parameter. See connection.ts for why each value
      // is what it is — in particular connectionTimeoutMillis, whose default of
      // 0 meant an exhausted pool blocked a request forever.
      pool = new Pool({ ...POOL_OPTIONS, connectionString });

      // Without this listener, an error on an IDLE pooled connection (server
      // restart, an idle-session reaper, a dropped overlay-network socket) is
      // emitted as an unhandled 'error' event and takes the whole Node process
      // down — no request involved, nothing to catch it. pg has already evicted
      // the broken client from the pool by the time we get here, so logging is
      // the correct response: the next checkout simply opens a fresh one.
      pool.on('error', err => {
        console.error('❌ Postgres idle-client error (connection evicted):', errorMessage(err));
      });

      // Probe + schema bootstrap run on ONE dedicated connection, because the
      // bootstrap has to opt out of the pool's statement_timeout: a CREATE INDEX
      // or a backfilling ALTER on an already-large table legitimately runs
      // longer than the 30s cap that protects normal API traffic, and being cut
      // off there would abort the boot mid-migration. `SET` is session-scoped,
      // so that connection is DESTROYED rather than returned (release(true)) —
      // otherwise it would go back into the pool with no statement timeout at
      // all and quietly serve HTTP queries under the wrong limit.
      const bootstrap = await pool.connect();
      try {
        await bootstrap.query('SELECT NOW()');
        console.log('✅ Connected to PostgreSQL');

        await bootstrap.query('SET statement_timeout = 0');
        await ensureBaseSchema(bootstrap);
        await runSchemaMigrations(bootstrap);
        await ensureSchemaIndexes(bootstrap);
      } finally {
        bootstrap.release(true);
      }

      setPool(pool);
      setDatabaseConnected(true);

      await loadSettingsCache();
      await refreshTokenSummaryCache();
      await loadOAuthTokens();

      return true;
    } catch (err) {
      console.error(
        `❌ Database connection failed (attempt ${attempt}/${retries}):`,
        errorMessage(err)
      );
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
