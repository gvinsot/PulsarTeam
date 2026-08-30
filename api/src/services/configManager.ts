import { getPool, getAllBoards, getBoardById } from './database.js';
import { errorMessage } from '../lib/errors.js';
import type {
  BoardWorkflow,
  WorkflowConfig,
  WorkflowTransition,
} from './workflow/taskStateMachine.js';

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
  // LLM config id used to automatically pick the best agent role for a workflow
  // action whose role is set to "automatic" (role === '__auto__'). The model
  // reads the task + the available roles and returns the best-fit one. Empty =
  // automatic role selection is unavailable (such actions fail with a hint).
  roleRouterLlmConfigId: '',
  // External voice agent — Speech-to-Text service (HighSpeedToText style)
  sttServiceUrl: '',
  sttApiKey: '',
  // External voice agent — Text-to-Speech service (HighSpeedToText style)
  ttsServiceUrl: '',
  ttsApiKey: '',
  // Default TTS voice / mode for external voice agents
  ttsVoiceId: '',
};

/**
 * The known keys above, plus whatever else the settings table holds: the read
 * below copies every row in, without filtering against DEFAULTS.
 */
export type Settings = typeof DEFAULTS & Record<string, string>;

export async function getSettings(): Promise<Settings> {
  const pool = getPool();
  if (!pool) return { ...DEFAULTS };

  try {
    const result = await pool.query<{ key: string; value: string }>(
      'SELECT key, value FROM settings'
    );
    const settings: Settings = { ...DEFAULTS };
    for (const row of result.rows) {
      settings[row.key] = row.value;
    }
    return settings;
  } catch (err) {
    console.error('[ConfigManager] settings read failed, serving defaults:', errorMessage(err));
    return { ...DEFAULTS };
  }
}

export async function updateSettings(patch: Record<string, unknown>) {
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
  const intOrDefault = (val: string, def: number) => {
    const n = parseInt(val, 10);
    return Number.isNaN(n) ? def : n;
  };
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

/** Narrowing gate for the unvalidated JSONB read back from the board workflow column. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const DEFAULT_COLUMNS = [
  { id: 'todo', label: 'Todo', color: '#6b7280' },
  { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
  { id: 'done', label: 'Done', color: '#22c55e' },
];

const DEFAULT_TRANSITIONS: WorkflowTransition[] = [
  {
    from: 'in_progress',
    trigger: 'on_enter',
    conditions: [],
    actions: [
      {
        type: 'run_agent',
        mode: 'decide',
        role: '__auto__',
        instructions:
          'Execute the task fully, and when you are finished, update the task to next state.',
      },
    ],
  },
];

const DEFAULT_WORKFLOW = {
  columns: DEFAULT_COLUMNS,
  transitions: DEFAULT_TRANSITIONS,
  version: 1,
};

export async function getWorkflow(): Promise<WorkflowConfig> {
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
export function mapLegacyExecuteMode<T>(transitions: T): T;
export function mapLegacyExecuteMode(transitions: unknown): unknown {
  // The board `workflow` column is unvalidated JSONB, so nothing here may assume
  // a shape: every access goes through isRecord/Array.isArray, exactly as the
  // optional chaining it replaces did.
  if (!Array.isArray(transitions)) return transitions;
  const list: unknown[] = transitions;
  let changed = false;
  const mapped = list.map(t => {
    if (!isRecord(t) || !Array.isArray(t.actions)) return t;
    const currentActions: unknown[] = t.actions;
    let actionsChanged = false;
    const actions = currentActions.map(a => {
      if (isRecord(a) && a.type === 'run_agent' && a.mode === 'execute') {
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
export async function getWorkflowForBoard(
  boardId: string | null | undefined
): Promise<WorkflowConfig> {
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
    console.error('[ConfigManager] Failed to read workflow for board:', errorMessage(err));
  }
  return getWorkflow();
}

/**
 * Get all board workflows. Returns array of { boardId, workflow }.
 * Used by services that need to scan transitions across all boards (e.g. Jira sync).
 */
export async function getAllBoardWorkflows(): Promise<BoardWorkflow[]> {
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
    console.error('[ConfigManager] Failed to read all board workflows:', errorMessage(err));
    return [];
  }
}
