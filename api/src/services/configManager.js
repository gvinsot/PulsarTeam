import { getPool } from './database.js';

const DEFAULTS = {
  ideasAgent: '',
};

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

// ── Workflow configuration ──────────────────────────────────────────────────
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');

const DEFAULT_COLUMNS = [
  { id: 'idea', label: 'Ideas', color: '#a855f7' },
  { id: 'backlog', label: 'Backlog', color: '#6b7280' },
  { id: 'pending', label: 'Todo', color: '#3b82f6' },
  { id: 'in_progress', label: 'In Progress', color: '#eab308' },
  { id: 'done', label: 'Done', color: '#22c55e' },
];

const DEFAULT_TRANSITIONS = [
  { from: 'idea', to: 'backlog', agent: 'product-manager', autoRefine: true },
  { from: 'backlog', to: 'pending', agent: null, autoRefine: false },
  { from: 'pending', to: 'in_progress', agent: null, autoRefine: false },
  { from: 'in_progress', to: 'done', agent: null, autoRefine: false },
  { from: 'in_progress', to: 'backlog', agent: null, autoRefine: false },
  { from: 'done', to: 'backlog', agent: null, autoRefine: false },
];

const DEFAULT_WORKFLOW = {
  columns: DEFAULT_COLUMNS,
  transitions: DEFAULT_TRANSITIONS,
  version: 1,
};

export async function getWorkflow(project) {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(WORKFLOWS_FILE, 'utf8');
    const all = JSON.parse(raw);
    return all[project] || { ...DEFAULT_WORKFLOW };
  } catch {
    return { ...DEFAULT_WORKFLOW };
  }
}

export async function getAllWorkflows() {
  await ensureDataDir();
  try {
    const raw = await fs.readFile(WORKFLOWS_FILE, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export async function updateWorkflow(project, workflow) {
  await ensureDataDir();
  let all = {};
  try {
    const raw = await fs.readFile(WORKFLOWS_FILE, 'utf8');
    all = JSON.parse(raw);
  } catch { /* fresh file */ }
  all[project] = { ...workflow, updatedAt: new Date().toISOString() };
  await fs.writeFile(WORKFLOWS_FILE, JSON.stringify(all, null, 2));
  return all[project];
}
