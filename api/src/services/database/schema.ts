import pg from 'pg';
import { setPool, setDatabaseConnected } from './connection.js';
import { ensureDefaultBoard } from './boards.js';
import { loadSettingsCache } from './settings.js';
import { refreshTokenSummaryCache } from './tokenUsage.js';
import { loadOAuthTokens } from './oauthTokens.js';

const { Pool } = pg;

export async function initDatabase(retries = 5, delayMs = 3000) {
  const connectionString = process.env.DATABASE_URL;

  if (!connectionString) {
    console.log('⚠️  DATABASE_URL not set, agents will not be persisted');
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const pool = new Pool({ connectionString });

      // Test connection
      await pool.query('SELECT NOW()');
      console.log('✅ Connected to PostgreSQL');

      // ── Agents table ──────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
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
      // Migrate existing UUID column to TEXT if needed
      await pool.query(`ALTER TABLE skills ALTER COLUMN id TYPE TEXT`).catch(() => {});
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
          cost REAL DEFAULT 0,
          recorded_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage_log(agent_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage_log(recorded_at)').catch(() => {});
      // Add user_id column for per-user budget tracking (nullable for backwards compat)
      await pool.query(`ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL`).catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage_log(user_id)').catch(() => {});
      // Add context_tokens column for tracking context window utilization
      await pool.query(`ALTER TABLE token_usage_log ADD COLUMN IF NOT EXISTS context_tokens INTEGER DEFAULT 0`).catch(() => {});
      console.log('✅ Token usage table ready');

      // ── Project Contexts table ────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS project_contexts (
          name TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ Project contexts table ready');

      // ── Settings table ────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ Settings table ready');

      // ── Users table ───────────────────────────────────────────────────────
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'basic',
          display_name TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Google OAuth columns
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT UNIQUE').catch(() => {});
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT').catch(() => {});
      // Connection tracking
      await pool.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ').catch(() => {});
      // Allow null password for OAuth-only users
      await pool.query('ALTER TABLE users ALTER COLUMN password DROP NOT NULL').catch(() => {});
      console.log('✅ Users table ready');

      // Add owner_id column to agents table (legacy — kept for migration)
      await pool.query(`
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL
      `).catch(() => {});

      // Add board_id column to agents table — agents are now scoped to boards
      await pool.query(`
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS board_id UUID REFERENCES boards(id) ON DELETE SET NULL
      `).catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_agents_board ON agents(board_id)').catch(() => {});

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
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tasks (
          id UUID PRIMARY KEY,
          agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          text TEXT NOT NULL DEFAULT '',
          title TEXT,
          status TEXT NOT NULL DEFAULT 'backlog',
          project TEXT,
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
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id)').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)').catch(() => {});
      // Soft delete columns
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_by UUID').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)').catch(() => {});
      // Execution tracking columns
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_status TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_action_idx INTEGER').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running BOOLEAN DEFAULT FALSE').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_agent_id UUID').catch(() => {});
      // Error recovery: remember which column the task was in before entering error status
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS error_from_status TEXT').catch(() => {});
      // Action running mode (e.g. execute, refine, title) for restart recovery
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_mode TEXT').catch(() => {});
      // Manual task flag (skips automatic agent processing)
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS is_manual BOOLEAN DEFAULT FALSE').catch(() => {});
      // Position column for manual ordering within columns
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS position BIGINT NOT NULL DEFAULT 0').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_position ON tasks(board_id, status, position)').catch(() => {});
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
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id)').catch(() => {});
      // Migration: make user_id nullable & add is_default column for existing installs
      await pool.query('ALTER TABLE boards ALTER COLUMN user_id DROP NOT NULL').catch(() => {});
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE').catch(() => {});
      // Ensure a single default board exists
      await ensureDefaultBoard(pool);
      console.log('✅ Boards table ready');

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
      await pool.query(`
        CREATE TABLE IF NOT EXISTS board_audit_logs (
          id SERIAL PRIMARY KEY,
          board_id UUID REFERENCES boards(id) ON DELETE CASCADE,
          action TEXT NOT NULL,
          actor_id UUID REFERENCES users(id) ON DELETE SET NULL,
          actor_username TEXT,
          target_user_id UUID,
          target_username TEXT,
          details JSONB,
          created_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_board_audit_board ON board_audit_logs(board_id)').catch(() => {});
      // Allow null board_id for audit logs not tied to a specific board
      await pool.query('ALTER TABLE board_audit_logs ALTER COLUMN board_id DROP NOT NULL').catch(() => {});
      await pool.query('ALTER TABLE board_audit_logs DROP CONSTRAINT IF EXISTS board_audit_logs_board_id_fkey').catch(() => {});
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

      // ── Board plugins columns ─────────────────────────────────────────────
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS plugins JSONB NOT NULL DEFAULT \'[]\'').catch(() => {});
      await pool.query('ALTER TABLE boards ADD COLUMN IF NOT EXISTS mcp_auth JSONB NOT NULL DEFAULT \'{}\'').catch(() => {});
      console.log('✅ Board plugins columns ready');

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
