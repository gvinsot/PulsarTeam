// ─── Recurring rules: the stored config and how it is read ──────────────────
//
// A recurring task is TWO things: a rule (a `tasks` row with `is_template`,
// carrying this config in `recurrence`) and the runs it spawns (ordinary tasks
// with `template_id` + `occurrence_seq`). The rule never appears on a board and
// is never executed; each due date produces a fresh run with an empty history.
//
// The alternative — resetting one row in place — is what this replaces: its
// history, commits and audit trail grew without bound, and a reset landing on a
// run still in flight yanked it back under the agent working it.
//
// Every writer of `recurrence` goes through `buildRecurrenceConfig` so the
// stored shape is identical whether it came from the create modal, a PUT on the
// rule, or the scheduler advancing the clock.

import type { Task, TaskRecurrence } from './database/tasks.js';

/**
 * A task a recurrence change can be applied to.
 *
 * Wider than `TaskWriteInput` on the five fields the PUT body may clear with an
 * explicit `null` (title, text, taskType, priority, dueDate), so both a row read
 * from the DB and a route's half-edited copy can be passed without a cast. The
 * recurrence code only ever reads these through `||`, so a null is harmless.
 */
export type RecurrenceTask = Partial<
  Omit<Task, 'title' | 'text' | 'taskType' | 'priority' | 'dueDate'>
> & {
  id: string;
  title?: string | null;
  text?: string | null;
  taskType?: string | null;
  priority?: string | null;
  dueDate?: Date | string | null;
};

/** How long a run may be kept, and how many. Both optional. */
const MAX_RETENTION_DAYS = 3650; // ~10 years
const MAX_KEEP_LAST = 1000;

/** What a client may send. Every field optional — a PUT patches the rule. */
export interface RecurrenceInput {
  enabled?: boolean;
  period?: string;
  intervalMinutes?: number;
  originalStatus?: string;
  historyRetentionDays?: number | string | null;
  keepLastOccurrences?: number | string | null;
  onOverlap?: string;
  [key: string]: unknown;
}

/**
 * Coerce an arbitrary input into a positive integer, or null when the caller
 * wants no limit (the default). Caps the value so a direct API call cannot
 * store something absurd.
 */
function positiveIntOrNull(value: unknown, max: number): number | null {
  if (value === null || value === undefined || value === '' || value === 0 || value === false)
    return null;
  const n = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(max, Math.floor(n));
}

/**
 * Days a FINISHED run is kept before the retention sweep deletes it.
 *
 * The field name is the one the old in-place reset used (`historyRetentionDays`,
 * then "prune entries older than N days from this task's history array"), kept
 * so existing rules carry over untouched. What it prunes changed: whole runs,
 * not entries inside one ever-growing row.
 */
export function normalizeRetention(value: unknown): number | null {
  return positiveIntOrNull(value, MAX_RETENTION_DAYS);
}

/** How many finished runs to keep, newest first. null = unlimited. */
export function normalizeKeepLast(value: unknown): number | null {
  return positiveIntOrNull(value, MAX_KEEP_LAST);
}

/**
 * What happens when a run is due while the previous one is still unfinished.
 *
 * `skip` (the default) drops the cycle and waits for the next one, so runs
 * cannot pile up behind a workflow that is not moving — and, unlike the old
 * reset, never disturbs the run in progress. `spawn` starts the new run anyway,
 * for rules whose runs are genuinely independent.
 */
export function normalizeOverlap(value: unknown, fallback = 'skip'): 'skip' | 'spawn' {
  const candidate = value === undefined || value === null || value === '' ? fallback : value;
  return candidate === 'spawn' ? 'spawn' : 'skip';
}

/**
 * Build the stored `recurrence` object.
 *
 * `prev` is the rule's current config: every field the caller omits is kept, so
 * a PUT that only changes the period cannot silently reset the retention or
 * rewind the schedule. `defaultStatus` seeds `originalStatus` on creation —
 * the column runs start in.
 */
export function buildRecurrenceConfig(
  input: RecurrenceInput | null | undefined,
  { prev, defaultStatus }: { prev?: TaskRecurrence | null; defaultStatus?: string } = {}
): TaskRecurrence {
  const previous: TaskRecurrence = prev || {};
  const source: RecurrenceInput = input || {};
  const nowIso = new Date().toISOString();
  return {
    enabled: true,
    period: source.period || previous.period || 'daily',
    intervalMinutes: source.intervalMinutes || previous.intervalMinutes || 1440,
    originalStatus:
      source.originalStatus || previous.originalStatus || defaultStatus || 'backlog',
    historyRetentionDays: normalizeRetention(
      source.historyRetentionDays !== undefined
        ? source.historyRetentionDays
        : previous.historyRetentionDays
    ),
    keepLastOccurrences: normalizeKeepLast(
      source.keepLastOccurrences !== undefined
        ? source.keepLastOccurrences
        : previous.keepLastOccurrences
    ),
    onOverlap: normalizeOverlap(
      source.onOverlap,
      normalizeOverlap(previous.onOverlap as string | undefined)
    ),
    // Reference timestamp for the next run. Preserved across edits so toggling
    // a rule's settings mid-cycle neither postpones nor triggers a run.
    lastResetAt: (previous.lastResetAt as string) || nowIso,
    // Monotonic run counter — the source of `occurrence_seq`, so run numbers
    // keep climbing even after the retention sweep deletes the older rows.
    occurrenceCount: typeof previous.occurrenceCount === 'number' ? previous.occurrenceCount : 0,
    lastOccurrenceId: (previous.lastOccurrenceId as string) || null,
  };
}

/**
 * When the next run is due, as epoch ms — or null when the rule carries no
 * usable reference timestamp (in which case the scheduler leaves it alone
 * rather than firing continuously).
 */
export function nextRunAt(
  recurrence: TaskRecurrence | null | undefined,
  fallbackIso?: string | null
): number | null {
  if (!recurrence) return null;
  const intervalMs = (Number(recurrence.intervalMinutes) || 1440) * 60 * 1000;
  const refIso = (recurrence.lastResetAt as string) || fallbackIso;
  const refMs = refIso ? Date.parse(refIso) : NaN;
  if (!Number.isFinite(refMs)) return null;
  return refMs + intervalMs;
}
