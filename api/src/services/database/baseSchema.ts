type Queryable = {
  query: (sql: string, params?: any[]) => Promise<any>;
};

async function runStatements(db: Queryable, statements: string[]) {
  for (const statement of statements) {
    await db.query(statement);
  }
}

const TABLES = [
  `
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
  `,
  `
    CREATE TABLE IF NOT EXISTS projects (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      rules TEXT NOT NULL DEFAULT '',
      owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS boards (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT 'My board',
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
  `,
  `
    CREATE TABLE IF NOT EXISTS agents (
      id UUID PRIMARY KEY,
      data JSONB NOT NULL,
      owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
      board_id UUID REFERENCES boards(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS agent_skills (
      id TEXT PRIMARY KEY,
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
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
  `,
  `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS llm_configs (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
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
  `,
  `
    CREATE TABLE IF NOT EXISTS task_audit_logs (
      id SERIAL PRIMARY KEY,
      task_id UUID,
      action TEXT NOT NULL,
      user_id UUID,
      username TEXT,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS board_shares (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      board_id UUID NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      permission TEXT NOT NULL DEFAULT 'read',
      shared_by UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(board_id, user_id)
    )
  `,
  `
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
  `,
  `
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
  `,
  `
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
  `,
];

const INDEXES = [
  'CREATE INDEX IF NOT EXISTS idx_boards_user ON boards(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_boards_project ON boards(project_id)',
  'CREATE INDEX IF NOT EXISTS idx_agents_board ON agents(board_id)',
  `
    CREATE INDEX IF NOT EXISTS idx_agent_skills_fts
    ON agent_skills USING GIN (
      to_tsvector('english',
        COALESCE(data->>'name', '') || ' ' ||
        COALESCE(data->>'description', '') || ' ' ||
        COALESCE(data->>'category', '') || ' ' ||
        COALESCE(data->>'instructions', '')
      )
    )
  `,
  'CREATE INDEX IF NOT EXISTS idx_token_usage_agent ON token_usage_log(agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage_log(recorded_at)',
  'CREATE INDEX IF NOT EXISTS idx_token_usage_user ON token_usage_log(user_id)',
  'CREATE UNIQUE INDEX IF NOT EXISTS uniq_token_usage_idempotency ON token_usage_log(idempotency_key) WHERE idempotency_key IS NOT NULL',
  'CREATE INDEX IF NOT EXISTS idx_tasks_agent ON tasks(agent_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_position ON tasks(board_id, status, position)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_repo ON tasks(repo_full_name)',
  'CREATE INDEX IF NOT EXISTS idx_tasks_storage ON tasks(storage_path)',
  "CREATE INDEX IF NOT EXISTS idx_tasks_workflow_recheck ON tasks(environment, status) WHERE deleted_at IS NULL AND board_id IS NOT NULL",
  'CREATE INDEX IF NOT EXISTS idx_task_audit_task ON task_audit_logs(task_id)',
  'CREATE INDEX IF NOT EXISTS idx_task_audit_date ON task_audit_logs(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_board_shares_board ON board_shares(board_id)',
  'CREATE INDEX IF NOT EXISTS idx_board_shares_user ON board_shares(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_board_audit_board ON board_audit_logs(board_id)',
  'CREATE INDEX IF NOT EXISTS idx_oauth_tokens_scope ON oauth_tokens(scope_type, scope_id)',
  'CREATE INDEX IF NOT EXISTS idx_oauth_tokens_provider ON oauth_tokens(provider, scope_type, scope_id)',
  'CREATE INDEX IF NOT EXISTS idx_runner_configs_scope ON runner_configs(runner, scope_type, scope_id)',
];

export async function ensureBaseSchema(pool: Queryable) {
  await runStatements(pool, TABLES);
  console.log('✅ Base database schema ready');
}

export async function ensureSchemaIndexes(pool: Queryable) {
  await runStatements(pool, INDEXES);
  console.log('✅ Database indexes ready');
}

export const baseSchemaForTest = { tables: TABLES, indexes: INDEXES };
