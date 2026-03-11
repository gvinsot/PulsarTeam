import pg from 'pg';

const { Pool } = pg;

let pool = null;

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

export function getPool() {
  return pool;
}
