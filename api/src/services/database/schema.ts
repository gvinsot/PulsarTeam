import pg from 'pg';
import { setPool, setDatabaseConnected } from './connection.js';
import { ensureDefaultBoard } from './boards.js';
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
    try {
      const pool = new Pool({ connectionString });

      // Test connection
      await pool.query('SELECT NOW()');
      console.log('✅ Connected to PostgreSQL');

      // ── Users table ───────────────────────────────────────────────────────
      // password is nullable: OAuth-only users (Google/Microsoft/GitHub) have
      // no local password.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT UNIQUE NOT NULL,
          password TEXT,
          role TEXT NOT NULL DEFAULT 'advanced',
          display_name TEXT,
          google_id TEXT UNIQUE,
          microsoft_id TEXT UNIQUE,
          github_id TEXT UNIQUE,
          avatar_url TEXT,
          last_seen TIMESTAMPTZ,
          terms_accepted_at TIMESTAMPTZ,
          tutorial_completed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrations for existing installs: CREATE TABLE IF NOT EXISTS is a no-op
      // on a DB that already has the table, so columns added after the table's
      // first creation must be back-filled here with idempotent ALTERs.
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS microsoft_id TEXT UNIQUE').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS github_id TEXT UNIQUE').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS tutorial_completed_at TIMESTAMPTZ').catch(() => {});
      // OAuth-only users have no local password.
      await pool.query('ALTER TABLE users ALTER COLUMN password DROP NOT NULL').catch(() => {});
      console.log('✅ Users table ready');

      // ── Projects table (DB-managed projects, M:1 boards → projects) ───────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS projects (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT UNIQUE NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          rules TEXT NOT NULL DEFAULT '',
          owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ Projects table ready');

      // ── Boards table ──────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boards (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT 'My Board',
          workflow JSONB NOT NULL DEFAULT '{}',
          filters JSONB NOT NULL DEFAULT '{}',
          position INTEGER NOT NULL DEFAULT 0,
          is_default BOOLEAN NOT NULL DEFAULT FALSE,
          plugins JSONB NOT NULL DEFAULT '[]',
          mcp_auth JSONB NOT NULL DEFAULT '{}',
          project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrations for existing installs (idempotent). Must run before the
      // indexes below — idx_boards_project and uniq_boards_default reference
      // columns that only exist on a fresh DB's CREATE TABLE otherwise.
      await pool.query('ALTER TABLE boards ALTER COLUMN user_id DROP NOT NULL').catch(() => {});
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS plugins JSONB NOT NULL DEFAULT \'[]\'').catch(() => {});
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS mcp_auth JSONB NOT NULL DEFAULT \'{}\'').catch(() => {});
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS project_id UUID REFERENCES projects(id) ON DELETE SET NULL').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_id)').catch(() => {});
      // Demote any duplicate default boards (oldest wins) before adding the
      // unique guard — CREATE UNIQUE INDEX would fail on a DB that already has
      // duplicates. No .catch: if either statement fails the retry loop must
      // see it, otherwise concurrently booting replicas can each insert their
      // own default board.
      await pool.query(`
        UPDATE boards SET is_default = FALSE
        WHERE is_default AND id NOT IN (SELECT id FROM boards WHERE is_default ORDER BY created_at LIMIT 1)
      `);
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_boards_default ON boards (is_default) WHERE is_default');
      // Ensure a single default board exists
      await ensureDefaultBoard(pool);
      console.log('✅ Boards table ready');

      // ── Agents table ──────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY,
          data JSONB NOT NULL,
          owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
          board_id UUID REFERENCES boards(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrations for existing installs (idempotent). board_id is added here —
      // after the boards table exists — because the FK fails with 42P01 on a
      // fresh database otherwise.
      await pool.query('ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL').catch(() => {});
      await pool.query(`
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS board_id UUID REFERENCES boards(id) ON DELETE SET NULL
      `).catch((e: any) => console.error('[initDatabase] ADD COLUMN agents.board_id failed:', e.message));
      await pool.query('CREATE INDEX IF NOT EXISTS idx_agents_board ON agents(board_id)').catch(() => {});
      console.log('✅ Agents table ready');

      // ── Skills table ──────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrate existing UUID id column to TEXT if needed (idempotent on TEXT).
      await pool.query('ALTER TABLE skills ALTER COLUMN id TYPE TEXT').catch(() => {});
      console.log('✅ Skills table ready');

      // ── MCP Servers table ─────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ MCP servers table ready');

      // ── Agent Skills table ────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agent_skills (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Full-text search index on name, description, instructions
      await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_agent_skills_fts
        ON agent_skills USING GIN (
          to_tsvector('english',
            COALESCE(data->>'name', '') || ' ' ||
            COALESCE(data->>'description', '') || ' ' ||
            COALESCE(data->>'category', '') || ' ' ||
            COALESCE(data->>'instructions', '')
          )
        )
      `).catch(() => {});
      console.log('✅ Agent skills table ready');

      // ── Token Usage table ─────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS token_usage_log (
          id SERIAL PRIMARY KEY,
          agent_id TEXT NOT NULL,
          agent_name TEXT,
          provider TEXT,
          model TEXT,
          input_tokens INTEGER DEFAULT 0,
          output_tokens INTEGER DEFAULT 0,
          context_tokens INTEGER DEFAULT 0,
          cost REAL DEFAULT 0,
          idempotency_key TEXT,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrations for existing installs (idempotent). Must run before the
      // user/idempotency indexes below, which reference these columns.
      await pool.query('ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS context_tokens INTEGER DEFAULT 0').catch(() => {});
      await pool.query('ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS idempotency_key TEXT')
        .catch((e: any) => console.error('[initDatabase] ADD COLUMN token_usage_log.idempotency_key failed:', e.message));
      await pool.query('ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL')
        .catch((e: any) => console.error('[initDatabase] ADD COLUMN token_usage_log.user_id failed:', e.message));
      await pool.query('CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage_log(agent_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage_log(recorded_at)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage_log(user_id)').catch(() => {});
      // Idempotency key for runner-reported usage so retried reports never
      // double-count. Partial unique index allows NULL keys for usage that is
      // not runner-reported (recordTokenUsage inserts without a key).
      await pool.query('CREATE UNIQUE INDEX IF NOT EXISTS uniq_token_usage_idempotency ON token_usage_log(idempotency_key) WHERE idempotency_key IS NOT NULL')
        .catch((e: any) => console.error('[initDatabase] CREATE UNIQUE INDEX uniq_token_usage_idempotency failed:', e.message));
      console.log('✅ Token usage table ready');

      // ── Settings table ────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ Settings table ready');

      // ── LLM Configs table ─────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS llm_configs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ LLM configs table ready');

      // ── Tasks table ───────────────────────────────────────────────────────
      // `project` is derived from board.project_id at read-time. Repo is stored
      // directly on the task as (repo_provider, repo_full_name) — the picker
      // reads from the board's GitHub plugin OAuth, no intermediate table.
      // Storage targeting uses the same model: the picker comes from the
      // board's OneDrive/Google Drive plugin OAuth, the value lives directly
      // on the task.
      // agent_id is nullable: a task may exist on a board without being owned
      // by any agent (e.g. created via MCP without an agent_name); the assignee
      // column tracks who actually picks the work up.
      // environment captures the subdomain of the host that created the task
      // ("prod" for apex/www, otherwise the leading subdomain like "qa",
      // "staging", …). Lets a single DB serve multiple deployments and lets
      // the UI badge non-prod tasks.
      // pending_on_enter is the deferred on_enter retry flag — durable so
      // interrupted chains resume after restart.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id UUID PRIMARY KEY,
          agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
          text TEXT NOT NULL DEFAULT '',
          title TEXT,
          status TEXT NOT NULL DEFAULT 'backlog',
          board_id UUID,
          assignee UUID,
          task_type TEXT,
          priority TEXT,
          due_date TIMESTAMPTZ,
          source JSONB,
          recurrence JSONB,
          commits JSONB DEFAULT '[]',
          history JSONB DEFAULT '[]',
          error TEXT,
          error_from_status TEXT,
          execution_status TEXT,
          completed_action_idx INTEGER,
          action_running BOOLEAN DEFAULT FALSE,
          action_running_agent_id UUID,
          action_running_mode TEXT,
          pending_on_enter TEXT,
          is_manual BOOLEAN DEFAULT FALSE,
          position BIGINT NOT NULL DEFAULT 0,
          environment TEXT NOT NULL DEFAULT 'prod',
          repo_provider TEXT,
          repo_full_name TEXT,
          secondary_repos JSONB DEFAULT '[]',
          storage_provider TEXT,
          storage_path TEXT,
          deleted_at TIMESTAMPTZ,
          deleted_by UUID,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ
        )
      `);
      // Migrations for existing installs (idempotent). CREATE TABLE IF NOT
      // EXISTS does NOT add columns to a pre-existing tasks table, so every
      // column introduced after the table's first creation must be back-filled
      // here — and before the indexes below, several of which reference these
      // columns (position, repo_full_name, storage_path, deleted_at).
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_by UUID').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_status TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_action_idx INTEGER').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running BOOLEAN DEFAULT FALSE').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_agent_id UUID').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error_from_status TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_mode TEXT').catch(() => {});
      // pending_on_enter is the deferred on_enter retry flag — durable so
      // interrupted workflow chains resume after restart.
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS pending_on_enter TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position BIGINT NOT NULL DEFAULT 0').catch(() => {});
      // No silent swallow here — if this migration ever fails the badge stays missing.
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS environment TEXT')
        .catch((e: any) => console.error('[initDatabase] ADD COLUMN tasks.environment failed:', e.message));
      await pool.query('ALTER TABLE tasks ALTER COLUMN agent_id DROP NOT NULL')
        .catch((e: any) => console.error('[initDatabase] DROP NOT NULL tasks.agent_id failed:', e.message));
      // Legacy columns removed when repo/storage targeting moved onto the task.
      await pool.query('ALTER TABLE tasks DROP COLUMN IF EXISTS project').catch(() => {});
      await pool.query('ALTER TABLE tasks DROP COLUMN IF EXISTS repo_id').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repo_provider TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS repo_full_name TEXT').catch(() => {});
      // Secondary repos (primary + N) — cloned alongside repo_full_name at run time.
      await pool.query("ALTER TABLE tasks ADD COLUMN IF NOT EXISTS secondary_repos JSONB DEFAULT '[]'").catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS storage_provider TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS storage_path TEXT').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_position ON tasks(board_id, status, position)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_full_name)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_storage ON tasks(storage_path)').catch(() => {});
      console.log('✅ Tasks table ready');

      // ── Task Audit Logs table ─────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS task_audit_logs (
          id SERIAL PRIMARY KEY,
          task_id UUID,
          action TEXT NOT NULL,
          user_id UUID,
          username TEXT,
          details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_task_audit_task ON task_audit_logs(task_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_task_audit_date ON task_audit_logs(created_at)').catch(() => {});
      console.log('✅ Task audit logs table ready');

      // ── Board Shares table ────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS board_shares (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          permission TEXT NOT NULL DEFAULT 'read',
          shared_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(board_id, user_id)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_board_shares_board ON board_shares(board_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_board_shares_user ON board_shares(user_id)').catch(() => {});
      console.log('✅ Board shares table ready');

      // ── Board Audit Logs table ────────────────────────────────────────────
      // board_id intentionally has no FK: the 'delete' audit row is written
      // after the board row is deleted, and audit logs must outlive the board.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS board_audit_logs (
          id SERIAL PRIMARY KEY,
          board_id UUID,
          action TEXT NOT NULL,
          actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
          actor_username TEXT,
          target_user_id UUID,
          target_username TEXT,
          details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrations for existing installs (idempotent): the 'delete' audit row is
      // written after the board is gone, so board_id must be nullable and FK-free.
      await pool.query('ALTER TABLE board_audit_logs ALTER COLUMN board_id DROP NOT NULL').catch(() => {});
      await pool.query('ALTER TABLE board_audit_logs DROP CONSTRAINT IF EXISTS board_audit_logs_board_id_fkey').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_board_audit_board ON board_audit_logs(board_id)').catch(() => {});
      console.log('✅ Board audit logs table ready');

      // ── OAuth Tokens table (unified store for all OAuth plugins) ──────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS oauth_tokens (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMPTZ,
          meta JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(provider, scope_type, scope_id)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_scope ON oauth_tokens(scope_type, scope_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider, scope_type, scope_id)').catch(() => {});
      console.log('✅ OAuth tokens table ready');

      // ── Runner configs table ─────────────────────────────────────────────
      // Per-agent CLI runner config files (e.g. hermes ~/.hermes/{config.yaml,
      // .env}) that the user sets up inside the terminal. Stateless runners lose
      // these on restart, so we persist them here and restore on the next spawn.
      // `data.files` is a JSON string of {filename: content}, encrypted at rest
      // because the blob can carry provider API keys.
      await pool.query(`
        CREATE TABLE IF NOT EXISTS runner_configs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          runner TEXT NOT NULL,
          scope_type TEXT NOT NULL,
          scope_id TEXT NOT NULL,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          UNIQUE(runner, scope_type, scope_id)
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_runner_configs_scope ON runner_configs(runner, scope_type, scope_id)').catch(() => {});
      console.log('✅ Runner configs table ready');

      // ── Finalize ──────────────────────────────────────────────────────────
      setPool(pool);
      setDatabaseConnected(true);

      // Populate caches
      await loadSettingsCache();
      await refreshTokenSummaryCache();
      await loadOAuthTokens();

      return true;
    } catch (err) {
      console.error(`❌ Database connection failed (attempt ${attempt}/${retries}):`, err.message);
      setPool(null);
      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error('❌ All database connection attempts failed, running without persistence');
  return false;
}
