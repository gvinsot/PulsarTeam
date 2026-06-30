import { createHash } from 'crypto';
import { removeLegacyDefaultBoards } from './boards.js';

type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

export type Migration = {
  id: string;
  name: string;
  fingerprint: string;
  transaction?: boolean;
  up: (db: Queryable) => Promise<void>;
};

const MIGRATION_LOCK_KEY = 'pulsarteam:schema_migrations';

async function runStatements(db: Queryable, statements: string[]) {
  for (const statement of statements) {
    await db.query(statement);
  }
}

function sqlMigration(id: string, name: string, statements: string[]): Migration {
  return {
    id,
    name,
    fingerprint: statements.join('\n'),
    up: (db) => runStatements(db, statements),
  };
}

function checksum(migration: Migration): string {
  return createHash('sha256').update(migration.fingerprint).digest('hex');
}

async function ensureMigrationTable(db: Queryable) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

const MIGRATIONS: Migration[] = [
  sqlMigration('202601010001_users_oauth_columns', 'users OAuth columns and nullable password', [
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_id TEXT UNIQUE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id TEXT UNIQUE',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ',
    'ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_completed_at TIMESTAMPTZ',
    'ALTER TABLE users ALTER COLUMN password DROP NOT NULL',
  ]),

  sqlMigration('202601010002_boards_scope_columns', 'boards ownership and integration columns', [
    'ALTER TABLE boards ALTER COLUMN user_id DROP NOT NULL',
    'ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE',
    "ALTER TABLE boards ADD COLUMN IF NOT EXISTS plugins JSONB NOT NULL DEFAULT '[]'",
    "ALTER TABLE boards ADD COLUMN IF NOT EXISTS mcp_auth JSONB NOT NULL DEFAULT '{}'",
    'ALTER TABLE boards ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL',
    "ALTER TABLE boards ALTER COLUMN name SET DEFAULT 'My board'",
  ]),

  sqlMigration('202601010003_agents_owner_board_columns', 'agents owner and board columns', [
    'ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL',
    'ALTER TABLE agents ADD COLUMN IF NOT EXISTS board_id UUID REFERENCES boards(id) ON DELETE SET NULL',
  ]),

  sqlMigration('202601010004_skills_text_ids', 'skills ids are text', [
    'ALTER TABLE skills ALTER COLUMN id TYPE TEXT',
  ]),

  sqlMigration('202601010005_token_usage_columns', 'token usage summary columns', [
    'ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS context_tokens INTEGER DEFAULT 0',
    'ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT',
    'ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL',
  ]),

  sqlMigration('202601010006_tasks_runtime_columns', 'task runtime and targeting columns', [
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_by UUID',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_status TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_action_idx INTEGER',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running BOOLEAN DEFAULT FALSE',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_agent_id UUID',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error_from_status TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_mode TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS assignee UUID',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_on_enter TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position BIGINT NOT NULL DEFAULT 0',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS environment TEXT',
    "UPDATE tasks SET environment = 'prod' WHERE environment IS NULL",
    "ALTER TABLE tasks ALTER COLUMN environment SET DEFAULT 'prod'",
    'ALTER TABLE tasks ALTER COLUMN environment SET NOT NULL',
    'ALTER TABLE tasks ALTER COLUMN agent_id DROP NOT NULL',
    'ALTER TABLE tasks DROP COLUMN IF EXISTS project',
    'ALTER TABLE tasks DROP COLUMN IF EXISTS repo_id',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repo_provider TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repo_full_name TEXT',
    "ALTER TABLE tasks ADD COLUMN IF NOT EXISTS secondary_repos JSONB DEFAULT '[]'",
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS storage_provider TEXT',
    'ALTER TABLE tasks ADD COLUMN IF NOT EXISTS storage_path TEXT',
  ]),

  sqlMigration('202601010007_board_audit_no_fk', 'board audit logs survive board deletion', [
    'ALTER TABLE board_audit_logs ALTER COLUMN board_id DROP NOT NULL',
    'ALTER TABLE board_audit_logs DROP CONSTRAINT IF EXISTS board_audit_logs_board_id_fkey',
  ]),

  {
    id: '202607010001_remove_legacy_default_boards',
    name: 'remove legacy Default boards',
    fingerprint: 'DROP INDEX uniq_boards_default; remove boards where is_default=true or name=Default; detach dependent rows',
    up: async (db) => {
      await db.query('DROP INDEX IF EXISTS uniq_boards_default');
      await removeLegacyDefaultBoards(db);
    },
  },
];

export async function runMigrations(pool: any, migrations: Migration[] = MIGRATIONS) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [MIGRATION_LOCK_KEY]);
    await ensureMigrationTable(client);

    const appliedResult = await client.query('SELECT id, checksum FROM schema_migrations');
    const applied = new Map(appliedResult.rows.map((row: any) => [row.id, row.checksum]));

    for (const migration of migrations) {
      const expectedChecksum = checksum(migration);
      const appliedChecksum = applied.get(migration.id);
      if (appliedChecksum) {
        if (appliedChecksum !== expectedChecksum) {
          throw new Error(`Migration ${migration.id} checksum changed after it was applied`);
        }
        continue;
      }

      console.log(`⏫ Applying migration ${migration.id} — ${migration.name}`);
      if (migration.transaction === false) {
        await migration.up(client);
        await client.query(
          'INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)',
          [migration.id, migration.name, expectedChecksum]
        );
      } else {
        await client.query('BEGIN');
        try {
          await migration.up(client);
          await client.query(
            'INSERT INTO schema_migrations (id, name, checksum) VALUES ($1, $2, $3)',
            [migration.id, migration.name, expectedChecksum]
          );
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          throw err;
        }
      }
    }

    console.log('✅ Database migrations ready');
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

export const schemaMigrationsForTest = MIGRATIONS;

export async function runSchemaMigrations(pool: any) {
  return runMigrations(pool, MIGRATIONS);
}
