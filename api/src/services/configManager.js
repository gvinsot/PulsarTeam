import fs from 'fs/promises';
import path from 'path';
import { getPool } from './database.js';

const DEFAULTS = {
  ideasAgent: '',
};

// ── Data directory configuration ────────────────────────────────────────────
const DATA_DIR = path.join(process.cwd(), '.data');

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

export async function getSettings() {
  const pool = getPool();
  if (!pool) return { ...DEFAULTS };

  try {
    const result = await pool.query('SELECT key, value FROM settings');
    const settings = { ...DEFAULTS };
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  } catch {
    return { ...DEFAULTS };
  }
}

export async function updateSettings(patch) {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const allowed = Object.keys(DEFAULTS);
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));

  for (const [key, value] of entries) {
    await pool.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, String(value)]
    );
  }

  return getSettings();
}

// ── Workflow configuration (database-backed) ──────────────────────────────────

const DEFAULT_COLUMNS = [
  { id: 'idea', label: 'Ideas', color: '#a855f7' },
  { id: 'backlog', label: 'Backlog', color: '#6b7280' },
  { id: 'pending', label: 'Todo', color: '#3b82f6' },
  { id: 'in_progress', label: 'In Progress', color: '#eab308' },
  { id: 'done', label: 'Done', color: '#22c55e' },
];

const DEFAULT_TRANSITIONS = [
  { from: 'idea', to: 'backlog', triggerType: 'agent', agent: 'product-manager', autoRefine: true, mode: 'refine', instructions: 'Refine this idea into a clear, actionable task description. Add acceptance criteria and technical considerations.' },
  { from: 'backlog', to: 'pending', triggerType: 'none', agent: null, autoRefine: false, mode: 'refine', instructions: '' },
  { from: 'pending', to: 'done', triggerType: 'agent', agent: 'developer', autoRefine: true, mode: 'execute', instructions: '' },
  { from: 'in_progress', to: 'backlog', triggerType: 'none', agent: null, autoRefine: false, mode: 'refine', instructions: '' },
  { from: 'done', to: 'backlog', triggerType: 'none', agent: null, autoRefine: false, mode: 'refine', instructions: '' },
];

const DEFAULT_WORKFLOW = {
  columns: DEFAULT_COLUMNS,
  transitions: DEFAULT_TRANSITIONS,
  version: 1,
};

export async function getWorkflow(project) {
  const pool = getPool();
  if (!pool) return { ...DEFAULT_WORKFLOW };

  try {
    const result = await pool.query('SELECT columns, transitions, version FROM workflows WHERE project = $1', [project]);
    if (result.rows.length === 0) return { ...DEFAULT_WORKFLOW };
    const row = result.rows[0];
    return {
      columns: row.columns || DEFAULT_COLUMNS,
      transitions: row.transitions || DEFAULT_TRANSITIONS,
      version: row.version || 1,
    };
  } catch {
    return { ...DEFAULT_WORKFLOW };
  }
}

export async function getAllWorkflows() {
  const pool = getPool();
  if (!pool) return {};

  try {
    const result = await pool.query('SELECT project, columns, transitions, version FROM workflows ORDER BY project');
    const map = {};
    for (const row of result.rows) {
      map[row.project] = { columns: row.columns, transitions: row.transitions, version: row.version };
    }
    return map;
  } catch {
    return {};
  }
}

export async function updateWorkflow(project, workflow) {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const columns = JSON.stringify(workflow.columns || DEFAULT_COLUMNS);
  const transitions = JSON.stringify(workflow.transitions || DEFAULT_TRANSITIONS);
  const version = (workflow.version || 0) + 1;

  await pool.query(
    `INSERT INTO workflows (project, columns, transitions, version, updated_at)
     VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW())
     ON CONFLICT (project) DO UPDATE SET
       columns = $2::jsonb,
       transitions = $3::jsonb,
       version = $4,
       updated_at = NOW()`,
    [project, columns, transitions, version]
  );

  return { columns: workflow.columns, transitions: workflow.transitions, version };
}