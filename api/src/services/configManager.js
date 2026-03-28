import fs from 'fs/promises';
import path from 'path';
import { getPool, getAllBoards, getBoardById } from './database.js';

const DEFAULTS = {
  ideasAgent: '',
  jiraEnabled: 'true',
  currency: '$',
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
  { id: 'pending', label: 'Pending', color: '#3b82f6' },
  { id: 'in_progress', label: 'In Progress', color: '#eab308' },
  { id: 'done', label: 'Done', color: '#22c55e' },
];

const DEFAULT_TRANSITIONS = [
  { from: 'idea', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'product-manager', mode: 'refine', instructions: 'Refine this idea into a clear, actionable task description. Add acceptance criteria and technical considerations.' }] },
  { from: 'backlog', trigger: 'on_enter', actions: [] },
  { from: 'pending', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'developer', mode: 'execute', instructions: '' }] },
  { from: 'in_progress', trigger: 'on_enter', actions: [] },
  { from: 'done', trigger: 'on_enter', actions: [] },
];

const DEFAULT_WORKFLOW = {
  columns: DEFAULT_COLUMNS,
  transitions: DEFAULT_TRANSITIONS,
  version: 1,
};

export async function getWorkflow(project) {
  // Primary: read from first board in the boards table (new multi-board system)
  try {
    const boards = await getAllBoards();
    if (boards.length > 0 && boards[0].workflow) {
      const wf = boards[0].workflow;
      return {
        columns: wf.columns || DEFAULT_COLUMNS,
        transitions: wf.transitions || DEFAULT_TRANSITIONS,
        version: wf.version || 1,
      };
    }
  } catch (err) {
    console.error('[ConfigManager] Failed to read workflow from boards:', err.message);
  }

  // Fallback: legacy workflows table (used until first board is created)
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

/**
 * Get workflow for a specific board.
 * Falls back to getWorkflow('_default') if boardId is null or board not found.
 */
export async function getWorkflowForBoard(boardId) {
  if (!boardId) return getWorkflow('_default');
  try {
    const board = await getBoardById(boardId);
    if (board?.workflow) {
      return {
        columns: board.workflow.columns || DEFAULT_COLUMNS,
        transitions: board.workflow.transitions || DEFAULT_TRANSITIONS,
        version: board.workflow.version || 1,
      };
    }
  } catch (err) {
    console.error('[ConfigManager] Failed to read workflow for board:', err.message);
  }
  return getWorkflow('_default');
}

/**
 * Get all board workflows. Returns array of { boardId, workflow }.
 * Used by services that need to scan transitions across all boards (e.g. Jira sync).
 */
export async function getAllBoardWorkflows() {
  try {
    const boards = await getAllBoards();
    return boards
      .filter(b => b.workflow)
      .map(b => ({
        boardId: b.id,
        workflow: {
          columns: b.workflow.columns || DEFAULT_COLUMNS,
          transitions: b.workflow.transitions || [],
          version: b.workflow.version || 1,
        },
      }));
  } catch (err) {
    console.error('[ConfigManager] Failed to read all board workflows:', err.message);
    return [];
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