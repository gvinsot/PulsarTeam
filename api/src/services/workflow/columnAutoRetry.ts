/**
 * Column auto-retry — pure logic, no I/O.
 *
 * A board column can carry an `autoRetry` config:
 *
 *   {
 *     intervalMinutes?:        re-run the column's flow (its on_enter / condition
 *                              transitions, from the start) every N minutes while
 *                              the task stays in the column and is idle;
 *     maxRetries?:             cap on those periodic re-runs (absent/0 = no cap);
 *     escalateAfterMinutes?:   once the task has been in the column that long,
 *     escalationInstructions?: re-run the flow ONCE with this extra instruction
 *                              appended to every run_agent action. The instruction
 *                              then stays appended for every later re-run in that
 *                              column (the task is "escalated" until it leaves).
 *   }
 *
 * Timing is measured from the moment the task ENTERED the column
 * (tasks.column_entered_at) and from the last automatic re-run
 * (tasks.column_timer.lastRetryAt). Both are reset by a database trigger on every
 * status change, so no code path that moves a task has to remember it.
 *
 * Re-runs are only planned for an idle task: the engine never calls this for a
 * task with a live run claim, a stopped / watching / manual / unapproved task,
 * and it skips a periodic retry while the chain already waits for an agent
 * (pending_on_enter) — a re-run would add nothing there.
 */

import type { WorkflowAction, WorkflowColumn, WorkflowConfig } from './taskStateMachine.js';
import { ActionType } from './taskStateMachine.js';

/** Bounds shared with the zod schema (schemas/boards.ts). */
export const AUTO_RETRY_LIMITS = Object.freeze({
  MAX_INTERVAL_MINUTES: 7 * 24 * 60,
  MAX_ESCALATE_AFTER_MINUTES: 30 * 24 * 60,
  MAX_RETRIES: 1000,
  MAX_INSTRUCTIONS_LENGTH: 4000,
});

/** A column's auto-retry config, normalized: inactive parts are null. */
export interface AutoRetryConfig {
  intervalMinutes: number | null;
  maxRetries: number | null;
  escalateAfterMinutes: number | null;
  escalationInstructions: string | null;
}

/** Durable per-column timer state (tasks.column_timer), reset on every move. */
export interface ColumnTimer {
  retries?: number;
  lastRetryAt?: string;
  escalatedAt?: string;
  [key: string]: unknown;
}

export type AutoRetryKind = 'retry' | 'escalate';

const positiveInt = (value: unknown, max: number): number | null => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n >= 1 ? Math.min(n, max) : null;
};

/** Read a column's `autoRetry` key; null when nothing in it is active. */
export function normalizeAutoRetry(raw: unknown): AutoRetryConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const intervalMinutes = positiveInt(r.intervalMinutes, AUTO_RETRY_LIMITS.MAX_INTERVAL_MINUTES);
  const maxRetries = positiveInt(r.maxRetries, AUTO_RETRY_LIMITS.MAX_RETRIES);
  const instructions =
    typeof r.escalationInstructions === 'string' ? r.escalationInstructions.trim() : '';
  const escalateAfter = positiveInt(
    r.escalateAfterMinutes,
    AUTO_RETRY_LIMITS.MAX_ESCALATE_AFTER_MINUTES
  );
  const escalation = escalateAfter !== null && instructions.length > 0;
  if (intervalMinutes === null && !escalation) return null;
  return {
    intervalMinutes,
    maxRetries: intervalMinutes === null ? null : maxRetries,
    escalateAfterMinutes: escalation ? escalateAfter : null,
    escalationInstructions: escalation
      ? instructions.slice(0, AUTO_RETRY_LIMITS.MAX_INSTRUCTIONS_LENGTH)
      : null,
  };
}

/** The auto-retry config of the column `status`, if any. */
export function autoRetryForColumn(
  workflow: WorkflowConfig | null | undefined,
  status: string
): AutoRetryConfig | null {
  const column: WorkflowColumn | undefined = workflow?.columns?.find(c => c.id === status);
  return column ? normalizeAutoRetry(column.autoRetry) : null;
}

/** Read a column_timer value defensively (it is JSONB). */
export function readColumnTimer(raw: unknown): ColumnTimer {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as ColumnTimer;
}

const parseTime = (iso: unknown): number | null => {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

export interface AutoRetryTaskState {
  /** When the task entered its current column (ISO). */
  columnEnteredAt?: string | null;
  /** Fallback for rows written before column_entered_at existed. */
  updatedAt?: string | null;
  columnTimer?: unknown;
  /** True while the column's chain already waits for an agent. */
  pendingOnEnter?: boolean;
}

/**
 * What, if anything, is due now. Escalation wins over a periodic retry (it is a
 * re-run too, with the extra instruction).
 */
export function planAutoRetry(
  config: AutoRetryConfig | null,
  state: AutoRetryTaskState,
  nowMs: number = Date.now()
): AutoRetryKind | null {
  if (!config) return null;
  const enteredAt = parseTime(state.columnEnteredAt) ?? parseTime(state.updatedAt);
  if (enteredAt === null) return null;
  const timer = readColumnTimer(state.columnTimer);

  if (
    config.escalateAfterMinutes !== null &&
    !timer.escalatedAt &&
    nowMs - enteredAt >= config.escalateAfterMinutes * 60_000
  ) {
    return 'escalate';
  }

  if (config.intervalMinutes === null || state.pendingOnEnter) return null;
  const retries = typeof timer.retries === 'number' ? timer.retries : 0;
  if (config.maxRetries !== null && retries >= config.maxRetries) return null;
  const since = Math.max(enteredAt, parseTime(timer.lastRetryAt) ?? 0);
  return nowMs - since >= config.intervalMinutes * 60_000 ? 'retry' : null;
}

/** The timer state after a re-run of `kind` fired at `nowMs`. */
export function nextColumnTimer(
  raw: unknown,
  kind: AutoRetryKind,
  nowMs: number = Date.now()
): ColumnTimer {
  const timer = readColumnTimer(raw);
  const at = new Date(nowMs).toISOString();
  const next: ColumnTimer = { ...timer, lastRetryAt: at };
  if (kind === 'escalate') next.escalatedAt = at;
  else next.retries = (typeof timer.retries === 'number' ? timer.retries : 0) + 1;
  return next;
}

/**
 * The escalation instruction that applies to a run of the column `status` —
 * only once the task was escalated in that column.
 */
export function escalationInstructionsFor(
  workflow: WorkflowConfig | null | undefined,
  status: string,
  columnTimer: unknown
): string | null {
  if (!readColumnTimer(columnTimer).escalatedAt) return null;
  return autoRetryForColumn(workflow, status)?.escalationInstructions ?? null;
}

/** Append the escalation instruction to every run_agent action of a chain. */
export function withEscalationInstructions(
  actions: WorkflowAction[],
  instructions: string | null
): WorkflowAction[] {
  if (!instructions) return actions;
  return actions.map(action =>
    action.type === ActionType.RUN_AGENT
      ? {
          ...action,
          instructions: [
            action.instructions || '',
            `IMPORTANT — this task has been waiting in this column for too long. Additional instruction:\n${instructions}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        }
      : action
  );
}
