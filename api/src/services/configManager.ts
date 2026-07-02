import { getPool, getAllBoards, getBoardById } from './database.js';

const DEFAULTS = {
  ideasAgent: '',
  jiraEnabled: 'true',
  currency: '$',
  taskReminderIntervalMinutes: '10',
  taskReminderMaxCount: '12',
  taskReminderCooldownMinutes: '2',
  // LLM config id used to simplify the repo call-graph analysis. Empty = no LLM step.
  codeGraphLlmConfigId: '',
  // LLM config id consulted by the Claude paid-plan interactive runner when an
  // unknown Y/N or list prompt appears in the TUI. Empty = use safe defaults
  // ("y" for Y/N, "1" for list).
  claudeFallbackLlmConfigId: '',
  // External voice agent — Speech-to-Text service (HighSpeedToText style)
  sttServiceUrl: '',
  sttApiKey: '',
  // External voice agent — Text-to-Speech service (HighSpeedToText style)
  ttsServiceUrl: '',
  ttsApiKey: '',
  // Default TTS voice / mode for external voice agents
  ttsVoiceId: '',
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
  } catch (err) {
    console.error('[ConfigManager] settings read failed, serving defaults:', err?.message);
    return { ...DEFAULTS };
  }
}

export async function updateSettings(patch) {
  const pool = getPool();
  if (!pool) throw new Error('Database not available');

  const allowed = Object.keys(DEFAULTS);
  const entries = Object.entries(patch).filter(([k]) => allowed.includes(k));

  if (entries.length > 0) {
    // Apply the whole patch in one transaction on a dedicated client so a
    // mid-loop failure can't leave the settings half-applied.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const [key, value] of entries) {
        await client.query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
          [key, String(value)]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return getSettings();
}

// ── Reminder configuration ───────────────────────────────────────────────────
// Priority: env var > DB setting > default
export async function getReminderConfig() {
  const settings = await getSettings();
  const intOrDefault = (val, def) => { const n = parseInt(val, 10); return Number.isNaN(n) ? def : n; };
  const envInterval = process.env.TASK_REMINDER_INTERVAL_MINUTES;
  const intervalMinutes = envInterval
    ? intOrDefault(envInterval, 10)
    : intOrDefault(settings.taskReminderIntervalMinutes, 10);
  const maxReminders = intOrDefault(settings.taskReminderMaxCount, 12);
  const cooldownMinutes = intOrDefault(settings.taskReminderCooldownMinutes, 2);

  return {
    intervalMs: Math.max(1, intervalMinutes) * 60 * 1000,
    intervalMinutes: Math.max(1, intervalMinutes),
    maxReminders: Math.max(1, maxReminders),
    cooldownMs: Math.max(0, cooldownMinutes) * 60 * 1000,
    cooldownMinutes: Math.max(0, cooldownMinutes),
  };
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
  { from: 'pending', trigger: 'on_enter', actions: [{ type: 'run_agent', role: 'developer', mode: 'decide', instructions: 'Execute this task end to end. Explore the project to orient yourself, make the necessary changes, then commit and push. When done, move this task to its final column with a short summary of what you did.' }] },
  { from: 'in_progress', trigger: 'on_enter', actions: [] },
  { from: 'done', trigger: 'on_enter', actions: [] },
];

const DEFAULT_WORKFLOW = {
  columns: DEFAULT_COLUMNS,
  transitions: DEFAULT_TRANSITIONS,
  version: 1,
};

export async function getWorkflow() {
  return { ...DEFAULT_WORKFLOW };
}

/**
 * Backward compat: the 'execute' run_agent mode was removed in favor of a single
 * 'decide' mode (execution instructions now live in the decide prompt). Existing
 * boards may still have transitions authored with mode:'execute' — map them to
 * 'decide' at load so those actions keep running instead of hitting the
 * unknown-mode skip in the engine. A legacy execute with empty instructions
 * becomes a no-op decide (decide requires instructions), so such boards need a
 * prompt added — but nothing silently misbehaves.
 */
export function mapLegacyExecuteMode(transitions) {
  if (!Array.isArray(transitions)) return transitions;
  let changed = false;
  const mapped = transitions.map(t => {
    if (!Array.isArray(t?.actions)) return t;
    let actionsChanged = false;
    const actions = t.actions.map(a => {
      if (a?.type === 'run_agent' && a?.mode === 'execute') {
        actionsChanged = true;
        return { ...a, mode: 'decide' };
      }
      return a;
    });
    if (!actionsChanged) return t;
    changed = true;
    return { ...t, actions };
  });
  return changed ? mapped : transitions;
}

/**
 * Get workflow for a specific board.
 * Falls back to the built-in workflow if boardId is null or board not found.
 */
export async function getWorkflowForBoard(boardId) {
  if (!boardId) return getWorkflow();
  try {
    const board = await getBoardById(boardId);
    if (board?.workflow) {
      return {
        columns: board.workflow.columns || DEFAULT_COLUMNS,
        transitions: mapLegacyExecuteMode(board.workflow.transitions || DEFAULT_TRANSITIONS),
        version: board.workflow.version || 1,
        userId: board.user_id || null,
      };
    }
  } catch (err) {
    console.error('[ConfigManager] Failed to read workflow for board:', err.message);
  }
  return getWorkflow();
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
          transitions: mapLegacyExecuteMode(b.workflow.transitions || []),
          version: b.workflow.version || 1,
        },
      }));
  } catch (err) {
    console.error('[ConfigManager] Failed to read all board workflows:', err.message);
    return [];
  }
}
