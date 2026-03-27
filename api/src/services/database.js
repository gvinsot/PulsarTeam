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

      // Create workflows table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS workflows (
          project TEXT PRIMARY KEY,
          columns JSONB NOT NULL DEFAULT '[]',
          transitions JSONB NOT NULL DEFAULT '[]',
          version INTEGER NOT NULL DEFAULT 1,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      console.log('✅ Workflows table ready');

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

      // Create boards table if not exists
      await pool.query(`
        CREATE TABLE IF NOT EXISTS boards (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          name TEXT NOT NULL DEFAULT 'My Board',
          workflow JSONB NOT NULL DEFAULT '{}',
          filters JSONB NOT NULL DEFAULT '{}',
          position INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);
      await pool.query('CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id)').catch(() => {});
      console.log('✅ Boards table ready');

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
    const result = await pool.query('SELECT data FROM agents ORDER BY created_at');
    return result.rows.map(row => row.data);
  } catch (err) {
    console.error('Failed to load agents:', err.message);
    return [];
  }
}

export async function saveAgent(agent) {
  if (!pool) return;
  
  try {
    await pool.query(
      `INSERT INTO agents (id, data, updated_at) 
       VALUES ($1, $2, NOW()) 
       ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [agent.id, JSON.stringify(agent)]
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

export async function recordTokenUsage(agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId = null) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO token_usage_log (agent_id, agent_name, provider, model, input_tokens, output_tokens, cost, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [agentId, agentName, provider, model, inputTokens, outputTokens, cost, userId]
    );
  } catch (err) {
    console.error('Failed to record token usage:', err.message);
  }
}

export function getTokenUsageSummary(days = 1) {
  if (!pool) return { total_cost: 0, total_input: 0, total_output: 0 };
  // Return a promise — callers in budget.js use it synchronously in try/catch, so we keep sync shape via cache
  // For now, return empty and let callers use async version
  return _tokenSummaryCache[days] || { total_cost: 0, total_input: 0, total_output: 0 };
}

/** Async per-user (or global when userId is null) token usage summary */
export async function getTokenUsageSummaryAsync(days = 1, userId = null) {
  if (!pool) return { total_cost: 0, total_input: 0, total_output: 0 };
  // If no user filter, return from cache for speed
  if (!userId) return _tokenSummaryCache[days] || { total_cost: 0, total_input: 0, total_output: 0 };
  try {
    const result = await pool.query(
      `SELECT COALESCE(SUM(cost), 0) as total_cost,
              COALESCE(SUM(input_tokens), 0) as total_input,
              COALESCE(SUM(output_tokens), 0) as total_output
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1 AND user_id = $2`,
      [days, userId]
    );
    return result.rows[0] || { total_cost: 0, total_input: 0, total_output: 0 };
  } catch (err) {
    console.error('Failed to get token summary for user:', err.message);
    return { total_cost: 0, total_input: 0, total_output: 0 };
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
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(cost) as total_cost,
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
      `SELECT date_trunc($1, recorded_at) as period,
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(cost) as total_cost
       FROM token_usage_log
       WHERE recorded_at >= NOW() - INTERVAL '1 day' * $2${userFilter}
       GROUP BY period ORDER BY period`,
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
              SUM(input_tokens) as total_input, SUM(output_tokens) as total_output, SUM(cost) as total_cost
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
                COALESCE(SUM(output_tokens), 0) as total_output
         FROM token_usage_log
         WHERE recorded_at >= NOW() - INTERVAL '1 day' * $1`,
        [days]
      );
      _tokenSummaryCache[days] = result.rows[0] || { total_cost: 0, total_input: 0, total_output: 0 };
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

// ── Boards CRUD ──────────────────────────────────────────────────────────────

export async function getAllBoards() {
  if (!pool) return [];
  try {
    const result = await pool.query(
      `SELECT b.id, b.user_id, b.name, b.workflow, b.filters, b.position, b.created_at, b.updated_at,
              u.username, u.display_name
       FROM boards b LEFT JOIN users u ON b.user_id = u.id
       ORDER BY u.username, b.position, b.created_at`
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
    const result = await pool.query(
      'SELECT id, user_id, name, workflow, filters, position, created_at, updated_at FROM boards WHERE user_id = $1 ORDER BY position, created_at',
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
      'SELECT id, user_id, name, workflow, filters, position, created_at, updated_at FROM boards WHERE id = $1',
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
       RETURNING id, user_id, name, workflow, filters, position, created_at, updated_at`,
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
       RETURNING id, user_id, name, workflow, filters, position, created_at, updated_at`,
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

export function getPool() {
  return pool;
}
