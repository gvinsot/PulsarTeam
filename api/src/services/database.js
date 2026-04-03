import pg from 'pg';

const { Pool } = pg;

let pool = null;
let _dbConnected = false;

export function isDatabaseConnected() { return _dbConnected; }

export async function initDatabase(retries = 5, delayMs = 3000) {
  const connectionString = process.env.DATABASE_URL;
  
  if (!connectionString) {
    console.log('⚠️  DATABASE_URL not set, agents will not be persisted');
    return false;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      pool = new Pool({ connectionString });
      
      // Test connection
      await pool.query('SELECT NOW()');
      console.log('✅ Connected to PostgreSQL');

      // Create agents table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS agents (
          id UUID PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      console.log('✅ Agents table ready');

      // Create skills table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS skills (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      // Migrate existing UUID column to TEXT if needed
      await pool.query(`
        ALTER TABLE skills ALTER COLUMN id TYPE TEXT
      `).catch(() => {});

      console.log('✅ Skills table ready');

      // Create mcp_servers table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      console.log('✅ MCP servers table ready');

      // Token usage log for budget tracking
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

      // Create project_contexts table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS project_contexts (
          name TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      console.log('✅ Project contexts table ready');

      // Create settings table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL DEFAULT '',
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      console.log('✅ Settings table ready');

      // (workflows table removed — workflow data now lives in boards.workflow)

      // Create users table if not exists
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
      console.log('✅ Users table ready');

      // Add owner_id column to agents table (nullable for backwards compat)
      await pool.query(`
        ALTER TABLE agents ADD COLUMN IF NOT EXISTS owner_id UUID REFERENCES users(id) ON DELETE SET NULL
      `).catch(() => {});

      // Create llm_configs table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS llm_configs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          data JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      console.log('✅ LLM configs table ready');

      // Create tasks table if not exists
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
      // Soft delete: add deleted_at and deleted_by columns
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deleted_by UUID').catch(() => {});
      await pool.query('CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)').catch(() => {});
      // Execution tracking columns (persisted instead of in-memory flags)
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS execution_status TEXT').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS completed_action_idx INTEGER').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running BOOLEAN DEFAULT FALSE').catch(() => {});
      await pool.query('ALTER TABLE tasks ADD COLUMN IF NOT EXISTS action_running_agent_id UUID').catch(() => {});
      console.log('✅ Tasks table ready');

      // Create task_audit_logs table for tracking delete/restore actions
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

      // Create boards table if not exists
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

      // Create board_shares table for sharing boards between users
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

      // Create board_audit_logs table for permission change tracking
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

      _dbConnected = true;

      // Populate caches
      await loadSettingsCache();
      await refreshTokenSummaryCache();

      return true;
    } catch (err) {
      console.error(`❌ Database connection failed (attempt ${attempt}/${retries}):`, err.message);
      pool = null;
      if (attempt < retries) {
        console.log(`⏳ Retrying in ${delayMs / 1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }

  console.error('❌ All database connection attempts failed, running without persistence');
  return false;
}

export async function getAllAgents() {
  if (!pool) return [];
  
  try {
    // Clean any leftover todoList from agent JSONB (tasks now live in the tasks table)
    await pool.query(`UPDATE agents SET data = data - 'todoList' WHERE data ? 'todoList'`).catch(() => {});

    const result = await pool.query('SELECT data, owner_id FROM agents ORDER BY created_at');
    return result.rows.map(row => {
      const { todoList, ...agent } = row.data;
      // Ensure ownerId from the DB column is always present in the agent object
      if (row.owner_id && !agent.ownerId) {
        agent.ownerId = row.owner_id;
      }
      return agent;
    });
  } catch (err) {
    console.error('Failed to load agents:', err.message);
    return [];
  }
}

export async function saveAgent(agent) {
  if (!pool) return;

  try {
    // Exclude todoList from JSONB — tasks are now stored in the dedicated tasks table
    const { todoList, ...agentData } = agent;
    await pool.query(
      `INSERT INTO agents (id, data, owner_id, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, owner_id = $3, updated_at = NOW()`,
      [agent.id, JSON.stringify(agentData), agent.ownerId || null]
    );
  } catch (err) {
    console.error('Failed to save agent:', err.message);
  }
}

export async function deleteAgentFromDb(id) {
  if (!pool) return;
  
  try {
    await pool.query('DELETE FROM agents WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete agent:', err.message);
  }
}

// ── Skills CRUD ──────────────────────────────────────────────────────────────

export async function getAllSkills() {
  if (!pool) return [];

  try {
    const result = await pool.query('SELECT data FROM skills ORDER BY created_at');
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to load skills:', err.message);
    return [];
  }
}

export async function saveSkill(skill) {
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO skills (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [skill.id, JSON.stringify(skill)]
    );
  } catch (err) {
    console.error('Failed to save skill:', err.message);
  }
}

export async function deleteSkillFromDb(id) {
  if (!pool) return;

  try {
    await pool.query('DELETE FROM skills WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete skill:', err.message);
  }
}

// ── MCP Servers CRUD ────────────────────────────────────────────────────────

export async function getAllMcpServers() {
  if (!pool) return [];

  try {
    const result = await pool.query('SELECT data FROM mcp_servers ORDER BY created_at');
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to load MCP servers:', err.message);
    return [];
  }
}

export async function saveMcpServer(server) {
  if (!pool) return;

  try {
    await pool.query(
      `INSERT INTO mcp_servers (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [server.id, JSON.stringify(server)]
    );
  } catch (err) {
    console.error('Failed to save MCP server:', err.message);
  }
}

export async function deleteMcpServerFromDb(id) {
  if (!pool) return;

  try {
    await pool.query('DELETE FROM mcp_servers WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete MCP server:', err.message);
  }
}

// ── Project Contexts CRUD ────────────────────────────────────────────────────

export async function getAllProjectContexts() {
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT data FROM project_contexts ORDER BY name');
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to load project contexts:', err.message);
    return [];
  }
}

export async function saveProjectContext(ctx) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO project_contexts (name, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (name) DO UPDATE SET data = $2, updated_at = NOW()`,
      [ctx.name, JSON.stringify(ctx)]
    );
  } catch (err) {
    console.error('Failed to save project context:', err.message);
  }
}

export async function deleteProjectContextFromDb(name) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM project_contexts WHERE name = $1', [name]);
  } catch (err) {
    console.error('Failed to delete project context:', err.message);
  }
}

// ── Settings CRUD ──────────────────────────────────────────────────────────

export function getSetting(key) {
  if (!pool) return null;
  // Synchronous-style: return a cached value. Use getSettingAsync for fresh reads.
  return _settingsCache[key] ?? null;
}

export async function getSettingAsync(key) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
    if (result.rows.length === 0) return null;
    try { return JSON.parse(result.rows[0].value); } catch { return result.rows[0].value; }
  } catch (err) {
    console.error('Failed to get setting:', err.message);
    return null;
  }
}

export async function setSetting(key, value) {
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

// In-memory settings cache (populated at init, updated on setSetting)
const _settingsCache = {};

export async function loadSettingsCache() {
  if (!pool) return;
  try {
    const result = await pool.query('SELECT key, value FROM settings');
    for (const row of result.rows) {
      try { _settingsCache[row.key] = JSON.parse(row.value); } catch { _settingsCache[row.key] = row.value; }
    }
  } catch (err) {
    console.error('Failed to load settings cache:', err.message);
  }
}

// ── Token Usage (Budget) ──────────────────────────────────────────────────

export async function recordTokenUsage(agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId = null, contextTokens = 0) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id, context_tokens)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId, contextTokens || 0]
    );
  } catch (err) {
    console.error('Failed to record token usage:', err.message);
  }
}

export function getTokenUsageSummary(days = 1) {
  if (!pool) return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  return _tokenSummaryCache[days] || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
}

/** Async per-user (or global when userId is null) token usage summary */
export async function getTokenUsageSummaryAsync(days = 1, userId = null) {
  if (!pool) return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  if (!userId) return _tokenSummaryCache[days] || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(cost), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output,
              COALESCE(SUM(context_tokens), 0) as total_context
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1 AND user_id = $2`,
      [days, userId]
    );
    return result.rows[0] || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  } catch (err) {
    console.error('Failed to get token summary for user:', err.message);
    return { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
  }
}

export async function getTokenUsageByAgent(days = 30, userId = null) {
  if (!pool) return [];
  try {
    const userFilter = userId ? ' AND user_id = $2' : '';
    const params = userId ? [days, userId] : [days];
    const result = await pool.query(
      `SELECT provider, model,
              COUNT(DISTINCT agent_id) as agent_count,
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
              SUM(context_tokens) as total_context, SUM(cost) as total_cost,
              COUNT(*) as request_count
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${userFilter}
       GROUP BY provider, model
       ORDER BY total_cost DESC`,
      params
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get token usage by agent:', err.message);
    return [];
  }
}

export async function getTokenUsageTimeline(days = 7, groupBy = 'day', userId = null) {
  if (!pool) return [];
  const trunc = groupBy === 'hour' ? 'hour' : 'day';
  try {
    const userFilter = userId ? ' AND user_id = $3' : '';
    const params = userId ? [trunc, days, userId] : [trunc, days];
    const result = await pool.query(
      `SELECT date_trunc($1, recorded_at) as period, agent_name,
              SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
              SUM(context_tokens) as context_tokens, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $2${userFilter}
       GROUP BY period, agent_name ORDER BY period`,
      params
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get token usage timeline:', err.message);
    return [];
  }
}

export async function getDailyTokenUsage(days = 30, userId = null) {
  if (!pool) return [];
  try {
    const userFilter = userId ? ' AND user_id = $2' : '';
    const params = userId ? [days, userId] : [days];
    const result = await pool.query(
      `SELECT date_trunc('day', recorded_at) as day,
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output,
              SUM(context_tokens) as total_context, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1${userFilter}
       GROUP BY day ORDER BY day`,
      params
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get daily token usage:', err.message);
    return [];
  }
}

// Token summary cache (refreshed periodically)
const _tokenSummaryCache = {};

export async function refreshTokenSummaryCache() {
  if (!pool) return;
  for (const days of [1, 7, 30]) {
    try {
      const result = await pool.query(
        `SELECT COALESCE(SUM(cost), 0) as total_cost,
                COALESCE(SUM(input_tokens), 0) as total_input,
                COALESCE(SUM(output_tokens), 0) as total_output,
                COALESCE(SUM(context_tokens), 0) as total_context
         FROM token_usage_log
         WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1`,
        [days]
      );
      _tokenSummaryCache[days] = result.rows[0] || { total_cost: 0, total_input: 0, total_output: 0, total_context: 0 };
    } catch (err) {
      console.error('Failed to refresh token summary cache:', err.message);
    }
  }
}

// ── Users CRUD ──────────────────────────────────────────────────────────────

export async function getAllUsers() {
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT id, username, role, display_name, created_at, updated_at FROM users ORDER BY created_at'
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to load users:', err.message);
    return [];
  }
}

export async function getUserById(id) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user:', err.message);
    return null;
  }
}

export async function getUserByUsername(username) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get user by username:', err.message);
    return null;
  }
}

export async function createUser(username, hashedPassword, role = 'basic', displayName = '') {
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `INSERT INTO users (username, password, role, display_name)
       VALUES ($1, $2, $3, $4)
       RETURNING id, username, role, display_name, created_at, updated_at`,
      [username, hashedPassword, role, displayName || username]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === '23505') throw new Error('Username already exists');
    throw err;
  }
}

export async function updateUser(id, fields) {
  if (!pool) throw new Error('Database not connected');
  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    setClauses.push(`${key} = $${idx}`);
    values.push(value);
    idx++;
  }
  if (setClauses.length === 0) return getUserById(id);

  setClauses.push(`updated_at = NOW()`);
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE users SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, username, role, display_name, created_at, updated_at`,
      values
    );
    return result.rows[0] || null;
  } catch (err) {
    if (err.code === '23505') throw new Error('Username already exists');
    throw err;
  }
}

export async function deleteUser(id) {
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM users WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to delete user:', err.message);
    return false;
  }
}

export async function countUsers() {
  if (!pool) return 0;
  try {
    const result = await pool.query('SELECT COUNT(*) as count FROM users');
    return parseInt(result.rows[0].count, 10);
  } catch (err) {
    return 0;
  }
}

// ── Agent owner_id helpers ──────────────────────────────────────────────────

export async function setAgentOwner(agentId, ownerId) {
  if (!pool) return;
  try {
    await pool.query('UPDATE agents SET owner_id = $2 WHERE id = $1', [agentId, ownerId]);
  } catch (err) {
    console.error('Failed to set agent owner:', err.message);
  }
}

export async function getAgentsByOwner(ownerId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT data FROM agents WHERE owner_id = $1 ORDER BY created_at',
      [ownerId]
    );
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to get agents by owner:', err.message);
    return [];
  }
}

// ── LLM Configs CRUD ──────────────────────────────────────────────────────

export async function getAllLlmConfigs() {
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT data FROM llm_configs ORDER BY created_at');
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to load LLM configs:', err.message);
    return [];
  }
}

export async function getLlmConfig(id) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT data FROM llm_configs WHERE id = $1', [id]);
    return result.rows[0]?.data || null;
  } catch (err) {
    console.error('Failed to get LLM config:', err.message);
    return null;
  }
}

export async function saveLlmConfig(config) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO llm_configs (id, data, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [config.id, JSON.stringify(config)]
    );
  } catch (err) {
    console.error('Failed to save LLM config:', err.message);
  }
}

export async function deleteLlmConfig(id) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM llm_configs WHERE id = $1', [id]);
  } catch (err) {
    console.error('Failed to delete LLM config:', err.message);
  }
}

// ── Default board ────────────────────────────────────────────────────────────

const DEFAULT_BOARD_WORKFLOW = {
  columns: [
    { id: 'idea', label: 'Ideas', color: '#a855f7' },
    { id: 'backlog', label: 'Backlog', color: '#6b7280' },
    { id: 'pending', label: 'Pending', color: '#3b82f6' },
    { id: 'in_progress', label: 'In Progress', color: '#eab308' },
    { id: 'done', label: 'Done', color: '#22c55e' },
  ],
  transitions: [
    { from: 'idea', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'product-manager', mode: 'refine', instructions: 'Refine this idea into a clear, actionable task description. Add acceptance criteria and technical considerations.' }] },
    { from: 'backlog', trigger: 'on_enter', actions: [] },
    { from: 'pending', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'developer', mode: 'execute', instructions: '' }] },
    { from: 'in_progress', trigger: 'on_enter', actions: [] },
    { from: 'done', trigger: 'on_enter', actions: [] },
  ],
  version: 1,
};

async function ensureDefaultBoard(p) {
  try {
    const existing = await p.query('SELECT id FROM boards WHERE is_default = TRUE LIMIT 1');
    if (existing.rows.length > 0) return;

    // Migrate from legacy workflows table if it exists
    let workflow = DEFAULT_BOARD_WORKFLOW;
    try {
      const legacy = await p.query("SELECT columns, transitions, version FROM workflows WHERE project = '_default'");
      if (legacy.rows.length > 0) {
        const row = legacy.rows[0];
        workflow = {
          columns: row.columns || DEFAULT_BOARD_WORKFLOW.columns,
          transitions: row.transitions || DEFAULT_BOARD_WORKFLOW.transitions,
          version: row.version || 1,
        };
      }
    } catch { /* workflows table may not exist */ }

    await p.query(
      `INSERT INTO boards (name, workflow, filters, position, is_default)
       VALUES ('Default', $1::jsonb, '{}'::jsonb, 0, TRUE)`,
      [JSON.stringify(workflow)]
    );
    console.log('✅ Default board created');
  } catch (err) {
    console.error('Failed to ensure default board:', err.message);
  }
}

export async function getDefaultBoard() {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT id, user_id, name, workflow, filters, position, is_default, created_at, updated_at FROM boards WHERE is_default = TRUE LIMIT 1'
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get default board:', err.message);
    return null;
  }
}

// ── Boards CRUD ──────────────────────────────────────────────────────────────

export async function getAllBoards() {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.created_at, b.updated_at,
              u.username, u.display_name
       FROM boards b LEFT JOIN users u ON b.user_id = u.id
       ORDER BY b.is_default DESC, u.username, b.position, b.created_at`
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get all boards:', err.message);
    return [];
  }
}

export async function getBoardsByUser(userId) {
  if (!pool) return [];
  try {
    // Get user's own boards + shared boards + default board
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.created_at, b.updated_at,
              NULL AS share_permission, NULL AS owner_username
       FROM boards b
       WHERE b.user_id = $1
       UNION ALL
       SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.created_at, b.updated_at,
              bs.permission AS share_permission, u.username AS owner_username
       FROM board_shares bs
       JOIN boards b ON bs.board_id = b.id
       LEFT JOIN users u ON b.user_id = u.id
       WHERE bs.user_id = $1 AND b.user_id != $1
       ORDER BY position, created_at`,
      [userId]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get boards:', err.message);
    return [];
  }
}

export async function getBoardById(id) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT id, user_id, name, workflow, filters, position, is_default, created_at, updated_at FROM boards WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get board:', err.message);
    return null;
  }
}

export async function createBoard(userId, name, workflow = {}, filters = {}) {
  if (!pool) throw new Error('Database not connected');
  try {
    const posResult = await pool.query(
      'SELECT COALESCE(MAX(position), -1) + 1 AS next_pos FROM boards WHERE user_id = $1',
      [userId]
    );
    const position = posResult.rows[0].next_pos;

    const result = await pool.query(
      `INSERT INTO boards (user_id, name, workflow, filters, position)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
       RETURNING id, user_id, name, workflow, filters, position, is_default, created_at, updated_at`,
      [userId, name, JSON.stringify(workflow), JSON.stringify(filters), position]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Failed to create board:', err.message);
    throw err;
  }
}

export async function updateBoard(id, fields) {
  if (!pool) throw new Error('Database not connected');
  const allowed = ['name', 'workflow', 'filters', 'position'];
  const setClauses = [];
  const values = [];
  let idx = 1;

  for (const [key, value] of Object.entries(fields)) {
    if (!allowed.includes(key)) continue;
    if (key === 'workflow' || key === 'filters') {
      setClauses.push(`${key} = $${idx}::jsonb`);
      values.push(JSON.stringify(value));
    } else {
      setClauses.push(`${key} = $${idx}`);
      values.push(value);
    }
    idx++;
  }
  if (setClauses.length === 0) return getBoardById(id);

  setClauses.push('updated_at = NOW()');
  values.push(id);

  try {
    const result = await pool.query(
      `UPDATE boards SET ${setClauses.join(', ')} WHERE id = $${idx}
       RETURNING id, user_id, name, workflow, filters, position, is_default, created_at, updated_at`,
      values
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to update board:', err.message);
    throw err;
  }
}

export async function deleteBoard(id) {
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM boards WHERE id = $1', [id]);
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to delete board:', err.message);
    return false;
  }
}

// ── Board Sharing ────────────────────────────────────────────────────────────

export async function getBoardShares(boardId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT bs.id, bs.board_id, bs.user_id, bs.permission, bs.shared_by, bs.created_at,
              u.username, u.display_name,
              sb.username AS shared_by_username
       FROM board_shares bs
       JOIN users u ON bs.user_id = u.id
       LEFT JOIN users sb ON bs.shared_by = sb.id
       WHERE bs.board_id = $1
       ORDER BY bs.created_at`,
      [boardId]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get board shares:', err.message);
    return [];
  }
}

export async function getBoardShare(boardId, userId) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'SELECT id, board_id, user_id, permission, shared_by, created_at FROM board_shares WHERE board_id = $1 AND user_id = $2',
      [boardId, userId]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to get board share:', err.message);
    return null;
  }
}

export async function createBoardShare(boardId, userId, permission, sharedBy) {
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `INSERT INTO board_shares (board_id, user_id, permission, shared_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (board_id, user_id) DO UPDATE SET permission = $3
       RETURNING id, board_id, user_id, permission, shared_by, created_at`,
      [boardId, userId, permission, sharedBy]
    );
    return result.rows[0];
  } catch (err) {
    console.error('Failed to create board share:', err.message);
    throw err;
  }
}

export async function updateBoardShare(boardId, userId, permission) {
  if (!pool) throw new Error('Database not connected');
  try {
    const result = await pool.query(
      `UPDATE board_shares SET permission = $3 WHERE board_id = $1 AND user_id = $2
       RETURNING id, board_id, user_id, permission, shared_by, created_at`,
      [boardId, userId, permission]
    );
    return result.rows[0] || null;
  } catch (err) {
    console.error('Failed to update board share:', err.message);
    throw err;
  }
}

export async function deleteBoardShare(boardId, userId) {
  if (!pool) return false;
  try {
    const result = await pool.query(
      'DELETE FROM board_shares WHERE board_id = $1 AND user_id = $2',
      [boardId, userId]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to delete board share:', err.message);
    return false;
  }
}

export async function getSharedBoardsForUser(userId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.is_default, b.created_at, b.updated_at,
              bs.permission AS share_permission,
              u.username AS owner_username, u.display_name AS owner_display_name
       FROM board_shares bs
       JOIN boards b ON bs.board_id = b.id
       LEFT JOIN users u ON b.user_id = u.id
       WHERE bs.user_id = $1
       ORDER BY b.position, b.created_at`,
      [userId]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get shared boards:', err.message);
    return [];
  }
}

export async function logBoardAudit(boardId, action, actorId, actorUsername, targetUserId, targetUsername, details = null) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO board_audit_logs (board_id, action, actor_id, actor_username, target_user_id, target_username, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [boardId, action, actorId, actorUsername, targetUserId, targetUsername, details ? JSON.stringify(details) : null]
    );
  } catch (err) {
    console.error('Failed to log board audit:', err.message);
  }
}

export async function getBoardAuditLogs(boardId, limit = 50) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT * FROM board_audit_logs WHERE board_id = $1 ORDER BY created_at DESC LIMIT $2',
      [boardId, limit]
    );
    return result.rows;
  } catch (err) {
    console.error('Failed to get board audit logs:', err.message);
    return [];
  }
}

// ── Tasks CRUD ──────────────────────────────────────────────────────────────

export async function getTasksByAgent(agentId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE agent_id = $1 AND deleted_at IS NULL ORDER BY created_at',
      [agentId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to load tasks for agent:', err.message);
    return [];
  }
}

export async function getAllTasks() {
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY created_at');
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to load all tasks:', err.message);
    return [];
  }
}

export async function getTaskById(taskId) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NULL', [taskId]);
    if (result.rows.length === 0) return null;
    return rowToTask(result.rows[0]);
  } catch (err) {
    console.error('Failed to get task:', err.message);
    return null;
  }
}

export async function saveTaskToDb(task) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO tasks (id, agent_id, text, title, status, project, board_id, assignee,
                          task_type, priority, due_date, source, recurrence, commits, history,
                          error, created_at, updated_at, completed_at, started_at,
                          execution_status, completed_action_idx, action_running, action_running_agent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,NOW(),$18,$19,$20,$21,$22,$23)
       ON CONFLICT (id) DO UPDATE SET
         text = $3, title = $4, status = $5, project = $6, board_id = $7, assignee = $8,
         task_type = $9, priority = $10, due_date = $11, source = $12, recurrence = $13,
         commits = $14, history = $15, error = $16, updated_at = NOW(),
         completed_at = $18, started_at = $19,
         execution_status = $20, completed_action_idx = $21, action_running = $22, action_running_agent_id = $23`,
      [
        task.id,
        task.agentId,
        task.text || '',
        task.title || null,
        task.status || 'backlog',
        task.project || null,
        task.boardId || null,
        task.assignee || null,
        task.taskType || null,
        task.priority || null,
        task.dueDate || null,
        task.source ? JSON.stringify(task.source) : null,
        task.recurrence ? JSON.stringify(task.recurrence) : null,
        JSON.stringify(task.commits || []),
        JSON.stringify(task.history || []),
        task.error || null,
        task.createdAt || new Date().toISOString(),
        task.completedAt || null,
        task.startedAt || null,
        task.executionStatus || null,
        task.completedActionIdx != null ? task.completedActionIdx : null,
        task.actionRunning || false,
        task.actionRunningAgentId || null,
      ]
    );
  } catch (err) {
    console.error('Failed to save task:', err.message);
  }
}

export async function deleteTaskFromDb(taskId, deletedBy = null) {
  if (!pool) return false;
  try {
    const result = await pool.query(
      'UPDATE tasks SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [taskId, deletedBy]
    );
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to soft-delete task:', err.message);
    return false;
  }
}

export async function hardDeleteTaskFromDb(taskId) {
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    return result.rowCount > 0;
  } catch (err) {
    console.error('Failed to hard-delete task:', err.message);
    return false;
  }
}

export async function restoreTaskFromDb(taskId) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      'UPDATE tasks SET deleted_at = NULL, updated_at = NOW() WHERE id = $1 AND deleted_at IS NOT NULL RETURNING *',
      [taskId]
    );
    if (result.rows.length === 0) return null;
    return rowToTask(result.rows[0]);
  } catch (err) {
    console.error('Failed to restore task:', err.message);
    return null;
  }
}

export async function getDeletedTasks() {
  if (!pool) return [];
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC');
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get deleted tasks:', err.message);
    return [];
  }
}

export async function getDeletedTaskById(taskId) {
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT * FROM tasks WHERE id = $1 AND deleted_at IS NOT NULL', [taskId]);
    if (result.rows.length === 0) return null;
    return rowToTask(result.rows[0]);
  } catch (err) {
    console.error('Failed to get deleted task:', err.message);
    return null;
  }
}

export async function deleteTasksByAgent(agentId) {
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE tasks SET deleted_at = NOW(), updated_at = NOW() WHERE agent_id = $1 AND deleted_at IS NULL',
      [agentId]
    );
  } catch (err) {
    console.error('Failed to soft-delete tasks for agent:', err.message);
  }
}

/**
 * Find tasks that need agent resume: active status, started, not currently watched,
 * with their assignee agent idle and enabled.
 */
export async function getTasksForResume() {
  if (!pool) return [];
  try {
    const result = await pool.query(`
      SELECT t.*, a.data as agent_data
      FROM tasks t
      JOIN agents a ON COALESCE(t.assignee, t.agent_id) = a.id
      WHERE t.deleted_at IS NULL
        AND t.started_at IS NOT NULL
        AND t.status NOT IN ('done', 'backlog', 'error')
        AND (t.execution_status IS NULL OR t.execution_status != 'watching')
        AND t.action_running = FALSE
      ORDER BY t.started_at ASC
    `);
    return result.rows.map(row => ({
      ...rowToTask(row),
      _agentStatus: row.agent_data?.status || 'idle',
      _agentEnabled: row.agent_data?.enabled !== false,
    }));
  } catch (err) {
    console.error('Failed to get tasks for resume:', err.message);
    return [];
  }
}

/**
 * Clear execution flags for all tasks involving a given agent (as assignee or owner).
 */
export async function clearTaskExecutionFlags(agentId) {
  if (!pool) return;
  try {
    await pool.query(`
      UPDATE tasks SET
        execution_status = NULL,
        started_at = NULL,
        completed_action_idx = NULL,
        action_running = FALSE,
        action_running_agent_id = NULL,
        updated_at = NOW()
      WHERE deleted_at IS NULL
        AND (assignee = $1 OR agent_id = $1)
        AND (started_at IS NOT NULL OR execution_status IS NOT NULL OR action_running = TRUE)
    `, [agentId]);
  } catch (err) {
    console.error('Failed to clear task execution flags:', err.message);
  }
}

/**
 * Update only the execution_status of a task (lightweight update for watching/stopped transitions).
 */
export async function updateTaskExecutionStatus(taskId, executionStatus) {
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE tasks SET execution_status = $2, updated_at = NOW() WHERE id = $1',
      [taskId, executionStatus || null]
    );
  } catch (err) {
    console.error('Failed to update task execution status:', err.message);
  }
}

/**
 * Clear action_running flags for tasks assigned to a specific agent.
 */
export async function clearActionRunningForAgent(agentId) {
  if (!pool) return;
  try {
    await pool.query(`
      UPDATE tasks SET
        action_running = FALSE,
        action_running_agent_id = NULL,
        updated_at = NOW()
      WHERE action_running_agent_id = $1 AND action_running = TRUE
    `, [agentId]);
  } catch (err) {
    console.error('Failed to clear action_running for agent:', err.message);
  }
}

/** Convert a DB row to the in-memory task object format */
export function rowToTask(row) {
  return {
    id: row.id,
    agentId: row.agent_id,
    text: row.text || '',
    title: row.title || undefined,
    status: row.status || 'backlog',
    project: row.project || null,
    boardId: row.board_id || null,
    assignee: row.assignee || null,
    taskType: row.task_type || undefined,
    priority: row.priority || undefined,
    dueDate: row.due_date || undefined,
    source: row.source || null,
    recurrence: row.recurrence || null,
    commits: row.commits || [],
    history: row.history || [],
    error: row.error || undefined,
    createdAt: row.created_at?.toISOString?.() || row.created_at,
    updatedAt: row.updated_at?.toISOString?.() || row.updated_at,
    completedAt: row.completed_at?.toISOString?.() || row.completed_at || undefined,
    startedAt: row.started_at?.toISOString?.() || row.started_at || undefined,
    deletedAt: row.deleted_at?.toISOString?.() || row.deleted_at || undefined,
    deletedBy: row.deleted_by || undefined,
    executionStatus: row.execution_status || undefined,
    completedActionIdx: row.completed_action_idx != null ? row.completed_action_idx : undefined,
    actionRunning: row.action_running || false,
    actionRunningAgentId: row.action_running_agent_id || undefined,
  };
}


// ── Additional task queries (replacing in-memory todoList lookups) ───────────

/**
 * Get active tasks (not done/backlog/error) for a given agent (as owner).
 */
export async function getActiveTasksByAgent(agentId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE agent_id = $1 AND status NOT IN ('done','backlog','error') AND deleted_at IS NULL ORDER BY created_at`,
      [agentId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get active tasks for agent:', err.message);
    return [];
  }
}

/**
 * Get all tasks for a board.
 */
export async function getTasksByBoard(boardId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      'SELECT * FROM tasks WHERE board_id = $1 AND deleted_at IS NULL ORDER BY created_at',
      [boardId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get tasks for board:', err.message);
    return [];
  }
}

/**
 * Get all tasks assigned to an agent (either as assignee or as owner when no assignee).
 */
export async function getTasksByAssignee(agentId) {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1)) AND deleted_at IS NULL ORDER BY created_at`,
      [agentId]
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get tasks by assignee:', err.message);
    return [];
  }
}

/**
 * Find the first active task (with startedAt) for a given executor agent.
 * Checks both assignee and owner. Returns null if none found.
 */
export async function getActiveTaskForExecutor(agentId) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND started_at IS NOT NULL
         AND deleted_at IS NULL
       ORDER BY started_at ASC LIMIT 1`,
      [agentId]
    );
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to get active task for executor:', err.message);
    return null;
  }
}

/**
 * Check if an agent has any active task (optionally excluding one task).
 * Returns true/false. Replaces the in-memory agentHasActiveTask cross-agent scan.
 */
export async function hasActiveTask(agentId, excludeTaskId = null) {
  if (!pool) return false;
  try {
    const params = [agentId];
    let excludeClause = '';
    if (excludeTaskId) {
      excludeClause = ' AND id != $2';
      params.push(excludeTaskId);
    }
    const result = await pool.query(
      `SELECT 1 FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND deleted_at IS NULL${excludeClause}
       LIMIT 1`,
      params
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error('Failed to check active task:', err.message);
    return false;
  }
}

/**
 * Count active tasks for an agent (for load-balancing).
 */
export async function countActiveTasksForAgent(agentId, excludeTaskId = null) {
  if (!pool) return 0;
  try {
    const params = [agentId];
    let excludeClause = '';
    if (excludeTaskId) {
      excludeClause = ' AND id != $2';
      params.push(excludeTaskId);
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int as count FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND deleted_at IS NULL${excludeClause}`,
      params
    );
    return result.rows[0]?.count || 0;
  } catch (err) {
    console.error('Failed to count active tasks:', err.message);
    return 0;
  }
}

/**
 * Get recurring tasks that are done and ready for reset.
 */
export async function getRecurringDoneTasks() {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT * FROM tasks
       WHERE recurrence IS NOT NULL
         AND status = 'done'
         AND completed_at IS NOT NULL
         AND deleted_at IS NULL`
    );
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error('Failed to get recurring done tasks:', err.message);
    return [];
  }
}

/**
 * Find a task by Jira key (stored in source JSONB).
 */
export async function getTaskByJiraKey(jiraKey) {
  if (!pool) return null;
  try {
    const result = await pool.query(
      `SELECT * FROM tasks WHERE source->>'jiraKey' = $1 AND deleted_at IS NULL LIMIT 1`,
      [jiraKey]
    );
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to get task by Jira key:', err.message);
    return null;
  }
}

/**
 * Update specific fields of a task. Returns the updated task.
 */
export async function updateTaskFields(taskId, fields) {
  if (!pool) return null;
  const allowed = [
    'text', 'title', 'status', 'project', 'board_id', 'assignee',
    'task_type', 'priority', 'due_date', 'source', 'recurrence',
    'commits', 'history', 'error', 'completed_at', 'started_at',
    'execution_status', 'completed_action_idx', 'action_running', 'action_running_agent_id',
  ];
  // Map camelCase to snake_case
  const camelToSnake = {
    boardId: 'board_id', taskType: 'task_type', dueDate: 'due_date',
    completedAt: 'completed_at', startedAt: 'started_at',
    executionStatus: 'execution_status', completedActionIdx: 'completed_action_idx',
    actionRunning: 'action_running', actionRunningAgentId: 'action_running_agent_id',
  };
  const sets = [];
  const values = [taskId];
  let paramIdx = 2;
  for (const [key, value] of Object.entries(fields)) {
    const col = camelToSnake[key] || key;
    if (!allowed.includes(col)) continue;
    // JSON-serialize objects
    const val = (typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date))
      ? JSON.stringify(value) : (Array.isArray(value) ? JSON.stringify(value) : value);
    sets.push(`${col} = $${paramIdx}`);
    values.push(val);
    paramIdx++;
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = NOW()');
  try {
    const result = await pool.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      values
    );
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to update task fields:', err.message);
    return null;
  }
}

export function getPool() {
  return pool;
}
