import { getPool } from './connection.js';
import { errorMessage } from '../../lib/errors.js';
import type { normalizeSecondaryRepos } from '../taskRepos.js';
import type { SecurityFlag, TaskTrustLevel } from '../../lib/taskTrust.js';
import { normalizeComments, type TaskComment } from '../../lib/taskComments.js';
import type { MaterializedAttachment } from '../../lib/taskAttachments.js';

// SELECT clause + joins shared by every task read query.
// Hydrates `project` (name, derived from board.project_id) so `rowToTask`
// doesn't need a separate fetch. Repo lives directly on the task row.
const TASK_SELECT = `
  SELECT t.*,
         p.id   AS _project_id,
         p.name AS _project_name
  FROM tasks t
  LEFT JOIN boards   b ON t.board_id = b.id
  LEFT JOIN projects p ON b.project_id = p.id
`;

// Writable columns for updateTaskFields, keyed by the accepted field name.
// Fields with a distinct camelCase form map to their snake_case column; fields
// whose name already equals the column are listed as identity entries. A single
// structure replaces the old parallel allow-list + camel→snake map (which had to
// be kept in sync). TASK_COLUMNS holds the snake_case columns for passthrough of
// already-snake_case keys (e.g. 'board_id'). Null prototype avoids inherited keys.
const TASK_COLUMN_BY_FIELD: Record<string, string> = Object.assign(Object.create(null), {
  text: 'text',
  title: 'title',
  status: 'status',
  assignee: 'assignee',
  priority: 'priority',
  source: 'source',
  recurrence: 'recurrence',
  commits: 'commits',
  history: 'history',
  error: 'error',
  position: 'position',
  boardId: 'board_id',
  taskType: 'task_type',
  dueDate: 'due_date',
  completedAt: 'completed_at',
  startedAt: 'started_at',
  executionStatus: 'execution_status',
  completedActionIdx: 'completed_action_idx',
  actionRunning: 'action_running',
  actionRunningAgentId: 'action_running_agent_id',
  actionRunningMode: 'action_running_mode',
  actionHeartbeatAt: 'action_heartbeat_at',
  errorFromStatus: 'error_from_status',
  pendingOnEnter: 'pending_on_enter',
  // Index (among the column's matching transitions) of the transition a
  // deferred chain resumes in — completedActionIdx is relative to it.
  resumeTransitionIdx: 'resume_transition_idx',
  // Durable copy of the in-flight run's commit context (gitReconcile.ts), so a
  // restart can still link what the agent committed before it.
  commitRun: 'commit_run',
  isManual: 'is_manual',
  isTemplate: 'is_template',
  templateId: 'template_id',
  occurrenceSeq: 'occurrence_seq',
  repoProvider: 'repo_provider',
  repoFullName: 'repo_full_name',
  secondaryRepos: 'secondary_repos',
  storageProvider: 'storage_provider',
  storagePath: 'storage_path',
  // Writable ONLY through updateTaskFields, i.e. deliberately. _doSaveTask sets
  // both on INSERT and never touches them on UPDATE — see there.
  trustLevel: 'trust_level',
  securityFlags: 'security_flags',
});
const TASK_COLUMNS = new Set<string>(Object.values(TASK_COLUMN_BY_FIELD));

/**
 * Every query that LISTS tasks must carry this.
 *
 * A recurring rule (`is_template`) is a row in `tasks` so it can reuse the whole
 * task shape — board, repo, storage, text, agent — but it is not a task: it must
 * never render on a board, never be picked by the workflow engine, never count
 * towards an agent's load, and never be returned by search or the MCP task
 * tools. Only the scheduler, the recurring-rules panel and a by-id lookup see
 * one. `IS NOT TRUE` (not `= FALSE`) so a NULL from a row written before the
 * column existed is excluded from the rules, not from the board.
 */
const NOT_TEMPLATE = 't.is_template IS NOT TRUE';

// ─── Task shapes ────────────────────────────────────────────────────────────
// `TaskRow` describes what the pg driver actually hands back for TASK_SELECT —
// not what the DDL suggests. Three driver behaviours matter and are the reason
// several columns are typed the way they are (see baseSchema.ts, CREATE TABLE
// tasks):
//   • JSONB columns (source, recurrence, commits, history, secondary_repos)
//     arrive already deserialized, so they are typed as their parsed shape.
//   • TIMESTAMPTZ columns arrive as `Date` objects, never as strings.
//   • `position` is a BIGINT, which pg returns as a string to avoid precision
//     loss — hence the parseInt in the mapper.
// Everything a consumer should use is derived from here: `Task` is
// ReturnType<typeof rowToTask>, so it cannot drift from the mapper.

/** A commit linked to a task by the git reconcile / run_command sweep. */
export interface TaskCommit {
  hash: string;
  message?: string;
  date?: string;
  /** Set once the runner has pushed the commit; absent until then. */
  pushed?: boolean;
  /** "owner/repo" when the commit lives in one of the task's SECONDARY repos;
   *  absent for the primary repo. */
  repo?: string;
}

/** The commit context of one run, persisted on the task while the run lives
 *  (see agentManager/tools/gitReconcile.ts). */
export interface TaskCommitRunRecord {
  executorId: string;
  baselineHead: string | null;
  startedAt: string;
  /** Baseline HEAD of each secondary repo ("owner/repo" → hash or null). */
  secondaryBaselines?: Record<string, string | null>;
  /** Set when the claim was cleared under the run (Stop, heal, reset): the run's
   *  window closes here, and its commits are linked by the commit sweeper. */
  endedAt?: string;
  /** Failed recovery attempts (the sweeper gives up after a few). */
  recoverAttempts?: number;
}

/** One append-only audit entry in `task.history`. Entries share a small core
 * (when / who / which status) and carry per-event extras, so extra keys are
 * allowed rather than enumerated. */
export interface TaskHistoryEntry {
  at?: string;
  by?: string;
  status?: string;
  from?: string;
  type?: string;
  field?: string;
  oldValue?: unknown;
  newValue?: unknown;
  [key: string]: unknown;
}

/** Where the task came from (user, MCP client, integration, ...). */
export interface TaskSource {
  type?: string;
  name?: string;
  [key: string]: unknown;
}

/** Recurring-task settings, written by addTask / setTaskRecurrence. */
export interface TaskRecurrence {
  enabled?: boolean;
  period?: string;
  intervalMinutes?: number;
  originalStatus?: string;
  historyRetentionDays?: number | null;
  lastResetAt?: string;
  [key: string]: unknown;
}

/** Derived from the single normalizer so the two cannot diverge. */
export type TaskSecondaryRepo = ReturnType<typeof normalizeSecondaryRepos>[number];

/** A `TASK_SELECT` row: every `tasks` column plus the two project aliases. */
export interface TaskRow {
  id: string;
  agent_id: string | null;
  text: string;
  title: string | null;
  status: string;
  board_id: string | null;
  assignee: string | null;
  task_type: string | null;
  priority: string | null;
  due_date: Date | null;
  source: TaskSource | null;
  recurrence: TaskRecurrence | null;
  commits: TaskCommit[] | null;
  history: TaskHistoryEntry[] | null;
  /** Discussion thread, separate from the description (lib/taskComments.ts). */
  comments: TaskComment[] | null;
  error: string | null;
  error_from_status: string | null;
  execution_status: string | null;
  completed_action_idx: number | null;
  action_running: boolean | null;
  action_running_agent_id: string | null;
  action_running_mode: string | null;
  /** Refreshed by a live run; a claim whose heartbeat stops is provably dead. */
  action_heartbeat_at: Date | null;
  pending_on_enter: string | null;
  resume_transition_idx: number | null;
  commit_run: TaskCommitRunRecord | null;
  is_manual: boolean | null;
  /** lib/taskTrust.ts: NULL (tenant), 'untrusted' (external, unapproved), 'approved'. */
  trust_level: string | null;
  /** Injection signals recorded when external text arrived (lib/taskTrust.ts). */
  security_flags: SecurityFlag[] | null;
  /** True on a recurring RULE — never rendered on a board, never executed. */
  is_template: boolean | null;
  /** Set on an occurrence: the rule that spawned it. */
  template_id: string | null;
  /** 1-based run number of an occurrence within its rule. */
  occurrence_seq: number | null;
  /** BIGINT — pg returns it as a string. */
  position: string;
  environment: string;
  repo_provider: string | null;
  repo_full_name: string | null;
  secondary_repos: TaskSecondaryRepo[] | null;
  storage_provider: string | null;
  storage_path: string | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  human_viewed_at: Date | null;
  created_at: Date | null;
  updated_at: Date | null;
  completed_at: Date | null;
  started_at: Date | null;
  /** Alias from the LEFT JOIN on projects — null for a board-less task. */
  _project_id: string | null;
  _project_name: string | null;
}

/**
 * Normalize a timestamp column to an ISO string. The pg driver hands back a
 * `Date`, but a task object round-tripped through JSON carries an ISO string
 * already — which is exactly what the `row.x?.toISOString?.() || row.x` chain
 * this replaces handled, with the same null passthrough.
 */
function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return typeof value === 'string' ? value : value.toISOString();
}

/** Convert a DB row to the in-memory task object format */
export function rowToTask(row: TaskRow) {
  return {
    id: row.id,
    agentId: row.agent_id,
    text: row.text || '',
    title: row.title || undefined,
    status: row.status || 'backlog',
    boardId: row.board_id || null,
    // Project is derived from board.project_id (read-only on the task object)
    projectId: row._project_id || null,
    project: row._project_name || null,
    // Repo lives directly on the task — picked from the board's GitHub plugin
    repoProvider: row.repo_provider || null,
    repoFullName: row.repo_full_name || null,
    repoHtmlUrl: row.repo_full_name ? `https://github.com/${row.repo_full_name}` : null,
    // Secondary repos cloned alongside the primary at run time ([{provider, fullName}])
    secondaryRepos: Array.isArray(row.secondary_repos) ? row.secondary_repos : [],
    // Storage lives directly on the task — picked from the board's OneDrive/Drive plugin
    storageProvider: row.storage_provider || null,
    storagePath: row.storage_path || null,
    assignee: row.assignee || null,
    taskType: row.task_type || undefined,
    priority: row.priority || undefined,
    dueDate: row.due_date || undefined,
    source: row.source || null,
    humanViewedAt: toIso(row.human_viewed_at ?? null),
    recurrence: row.recurrence || null,
    commits: row.commits || [],
    history: row.history || [],
    comments: normalizeComments(row.comments),
    error: row.error || undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
    completedAt: toIso(row.completed_at) || undefined,
    startedAt: toIso(row.started_at) || undefined,
    deletedAt: toIso(row.deleted_at) || undefined,
    deletedBy: row.deleted_by || undefined,
    executionStatus: row.execution_status || undefined,
    completedActionIdx: row.completed_action_idx != null ? row.completed_action_idx : undefined,
    _pendingOnEnter: row.pending_on_enter || undefined,
    resumeTransitionIdx: row.resume_transition_idx != null ? row.resume_transition_idx : undefined,
    commitRun: row.commit_run || undefined,
    actionRunning: row.action_running || false,
    actionRunningAgentId: row.action_running_agent_id || undefined,
    actionRunningMode: row.action_running_mode || undefined,
    actionHeartbeatAt: toIso(row.action_heartbeat_at ?? null) || undefined,
    errorFromStatus: row.error_from_status || undefined,
    isManual: row.is_manual || false,
    trustLevel: (row.trust_level as TaskTrustLevel | null) || null,
    securityFlags: Array.isArray(row.security_flags) ? row.security_flags : [],
    isTemplate: row.is_template || false,
    templateId: row.template_id || null,
    occurrenceSeq: row.occurrence_seq != null ? row.occurrence_seq : null,
    position: parseInt(row.position, 10) || 0,
    environment: row.environment,
  };
}

/** Exactly what the mapper builds — the starting point for `Task` below. */
type MappedTask = ReturnType<typeof rowToTask>;

/**
 * Fields that callers clear in place on a task object between two saves, by
 * assigning `null` or by `delete`-ing them (workflow chain bookkeeping, the
 * board-level running flags, ...). The mapper always emits them — as `undefined`
 * when empty — but a type saying "always present, never null" would reject that
 * clearing, so `Task` relaxes exactly these to optional + nullable.
 */
type ClearedInPlace =
  | 'startedAt'
  | 'completedAt'
  | 'actionRunningAgentId'
  | 'actionRunningMode'
  | 'completedActionIdx'
  | 'resumeTransitionIdx'
  | 'commitRun'
  | 'actionHeartbeatAt'
  | '_pendingOnEnter'
  | 'executionStatus'
  | 'errorFromStatus'
  | 'error'
  | 'taskType';

/**
 * The in-memory task object, derived from the one mapper that produces it.
 * Deriving instead of restating means the type follows `rowToTask` for free:
 * add a field to the mapper and every `Task`-annotated site sees it.
 */
export type Task = Omit<MappedTask, ClearedInPlace> & {
  [K in ClearedInPlace]?: MappedTask[K] | null;
} & {
  /** Transient, never persisted: the attachments copied onto the executing
   *  runner for this run (services/execution/taskAttachmentDelivery.ts), listed
   *  in the prompt by taskContentForPrompt. */
  materializedAttachments?: MaterializedAttachment[];
};

/**
 * What the write path accepts. Every field `_doSaveTask` reads is optional
 * except the primary key, because callers routinely persist a spread of a
 * partially-built task (`{ ...task, agentId }`).
 *
 * The four fields below are additionally nullable, unlike on the read model:
 * `_doSaveTask` coerces each one (`task.title || null`, `task.text || ''`, …),
 * and the routes hand it half-edited copies where an explicit `null` is how the
 * PUT body clears a field. Stating it here is what keeps those paths cast-free.
 */
export type TaskWriteInput = Omit<Partial<Task>, 'title' | 'text' | 'priority' | 'dueDate'> &
  Pick<Task, 'id'> & {
    title?: string | null;
    text?: string | null;
    priority?: string | null;
    dueDate?: Date | string | null;
  };

/**
 * Run a TASK_SELECT query with the given trailing clause + params, mapping rows
 * to task objects. On a no-pool/error condition returns [] (matching the per-
 * getter fallbacks). `errorPrefix` is the full console.error prefix to preserve
 * each getter's exact log wording.
 */
async function queryTasks(
  clause: string,
  params: unknown[] = [],
  errorPrefix = 'Failed to load tasks:'
): Promise<Task[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query<TaskRow>(`${TASK_SELECT} ${clause}`, params);
    return result.rows.map(rowToTask);
  } catch (err) {
    console.error(errorPrefix, errorMessage(err));
    return [];
  }
}

/** Single-row variant of queryTasks: returns the first task or null. */
async function queryOneTask(
  clause: string,
  params: unknown[],
  errorPrefix: string
): Promise<Task | null> {
  return (await queryTasks(clause, params, errorPrefix))[0] ?? null;
}

export async function getTasksByAgent(agentId: string) {
  return queryTasks(
    `WHERE t.agent_id = $1 AND t.deleted_at IS NULL AND ${NOT_TEMPLATE} ORDER BY t.created_at`,
    [agentId],
    'Failed to load tasks for agent:'
  );
}

export async function getAllTasks() {
  return queryTasks(
    `WHERE t.deleted_at IS NULL AND ${NOT_TEMPLATE} ORDER BY t.created_at`,
    [],
    'Failed to load all tasks:'
  );
}

/** Lightweight id-only scan of live tasks — used to purge stale ephemeral signals
 * without hydrating full task rows. Returns an array of task id strings. */
export async function getAllTaskIds(): Promise<string[]> {
  const pool = getPool();
  if (!pool) return [];
  try {
    const result = await pool.query<{ id: string }>(
      'SELECT id FROM tasks WHERE deleted_at IS NULL'
    );
    return result.rows.map(r => r.id);
  } catch (err) {
    console.error('Failed to load task ids:', errorMessage(err));
    return [];
  }
}

export async function getTaskById(taskId: string) {
  return queryOneTask('WHERE t.id = $1 AND t.deleted_at IS NULL', [taskId], 'Failed to get task:');
}

/** Hydrate a known set of ids in one round trip (bulk emits), joins included. */
export async function getTasksByIds(taskIds: string[]): Promise<Task[]> {
  if (!taskIds.length) return [];
  return queryTasks(
    'WHERE t.id = ANY($1::uuid[]) AND t.deleted_at IS NULL',
    [taskIds],
    'Failed to get tasks by id:'
  );
}

/**
 * Resolve a task by full id OR a unique id prefix (the short-id form agents and
 * the UI use). Tries the primary-key exact match first, then a prefix scan.
 * Task ids are full uuidv4, so a prefix can only collide if one id is a strict
 * prefix of another — which never happens for distinct uuids; we still cap at
 * two rows and treat an ambiguous (>1) match as not-found so a mutation can
 * never hit the wrong task. `id::text` keeps the comparison on the UUID column.
 *
 * This is the DB-backed equivalent of the in-memory `_findTaskByIdOrPrefix`,
 * and unlike it resolves tasks regardless of owner (including `agent_id = NULL`
 * board-level tasks).
 */
export async function getTaskByIdPrefix(idOrPrefix: string | null | undefined) {
  if (!idOrPrefix) return null;
  // Exact-id fast path (uses the PK index).
  const exact = await getTaskById(idOrPrefix);
  if (exact) return exact;
  const rows = await queryTasks(
    'WHERE LEFT(t.id::text, length($1)) = $1 AND t.deleted_at IS NULL ORDER BY t.created_at LIMIT 2',
    [idOrPrefix],
    'Failed to get task by id prefix:'
  );
  // Not found or ambiguous prefix → null (caller surfaces "not found").
  return rows.length === 1 ? rows[0] : null;
}

// Per-task write queue: serializes all saves for the same task so that
// fire-and-forget calls cannot overtake each other at the DB level.
const _taskWriteQueue = new Map(); // taskId -> Promise

export async function saveTaskToDb(task: TaskWriteInput) {
  const pool = getPool();
  if (!pool) return;

  const taskId = task.id;

  // Chain this save after the previous one for the same task.
  // This guarantees that even fire-and-forget calls execute in order.
  const prev = _taskWriteQueue.get(taskId) || Promise.resolve();
  const chained = prev.then(() => _doSaveTask(task));
  // The queue tail swallows rejections so a failed save can't poison the chain
  // for subsequent saves of the same task; the unsuppressed promise is returned
  // so awaiting callers still observe persistence failures.
  const tail = chained.catch(() => {});
  _taskWriteQueue.set(taskId, tail);
  // Evict the entry once settled (unless a newer save already replaced it) so
  // the Map doesn't grow with every task ID ever saved.
  tail.finally(() => {
    if (_taskWriteQueue.get(taskId) === tail) _taskWriteQueue.delete(taskId);
  });

  // Await our own turn so callers who `await saveTaskToDb()` get the guarantee
  return chained;
}

async function _doSaveTask(task: TaskWriteInput) {
  const pool = getPool();
  try {
    // saveTaskToDb (the only caller) already returned early when there was no
    // pool; re-check here so a pool torn down between queueing and execution
    // surfaces as a real error instead of a TypeError.
    if (!pool) throw new Error('Database not connected');
    await pool.query(
      `INSERT INTO tasks (id, agent_id, text, title, status, repo_provider, repo_full_name,
                          storage_provider, storage_path, board_id, assignee,
                          task_type, priority, due_date, source, recurrence, commits, history,
                          error, created_at, updated_at, completed_at, started_at,
                          execution_status, completed_action_idx, action_running, action_running_agent_id,
                          action_running_mode, error_from_status, is_manual, position, environment,
                          pending_on_enter, secondary_repos, is_template, template_id, occurrence_seq,
                          trust_level, security_flags, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,NOW(),$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39)
       ON CONFLICT (id) DO UPDATE SET
         text = $3, title = $4, status = $5, repo_provider = $6, repo_full_name = $7,
         storage_provider = $8, storage_path = $9,
         board_id = $10, assignee = $11,
         task_type = $12, priority = $13, due_date = $14, source = $15, recurrence = $16,
         history = $18, error = $19, updated_at = NOW(),
         completed_at = $21, started_at = $22,
         execution_status = $23, completed_action_idx = $24,
         error_from_status = $28, is_manual = $29, position = $30,
         pending_on_enter = $32, secondary_repos = $33,
         is_template = $34, template_id = $35, occurrence_seq = $36`,
      // trust_level / security_flags are NOT in the UPDATE list on purpose. Every
      // path in the codebase persists a spread of some task object through here,
      // and plenty of those objects were built before the column existed or
      // without it: letting them write it would silently turn an external task
      // into a tenant one. Provenance is set once, here, on INSERT; the only way
      // to change it afterwards is an explicit updateTaskFields (approval).
      // `comments` is excluded from the UPDATE for the same stale-snapshot
      // reason: it is only ever mutated through appendTaskComment /
      // deleteTaskComment, which touch the column atomically.
      // So are `commits` (mutateTaskCommits) and the run claim
      // (action_running / action_running_agent_id / action_running_mode, owned by
      // claimTaskRun / releaseTaskRun): a snapshot saved after a commit was linked,
      // or after a run ended, used to drop that commit or resurrect the finished
      // run's claim. A new row never starts claimed, whatever the object says.
      [
        task.id,
        task.agentId,
        task.text || '',
        task.title || null,
        task.status || 'backlog',
        task.repoProvider || (task.repoFullName ? 'github' : null),
        task.repoFullName || null,
        task.storageProvider || (task.storagePath ? 'onedrive' : null),
        task.storagePath || null,
        task.boardId || null,
        task.assignee || null,
        task.taskType || null,
        task.priority || null,
        task.dueDate || null,
        task.source ? JSON.stringify(task.source) : null,
        task.recurrence ? JSON.stringify(task.recurrence) : null,
        JSON.stringify(task.commits || []),
        JSON.stringify(task.history || []),
        task.error || null,
        task.createdAt || new Date().toISOString(),
        task.completedAt || null,
        task.startedAt || null,
        task.executionStatus || null,
        task.completedActionIdx != null ? task.completedActionIdx : null,
        false,
        null,
        null,
        task.errorFromStatus || null,
        task.isManual || false,
        task.position ?? 0,
        task.environment || 'prod',
        task._pendingOnEnter || null,
        JSON.stringify(Array.isArray(task.secondaryRepos) ? task.secondaryRepos : []),
        task.isTemplate || false,
        task.templateId || null,
        task.occurrenceSeq != null ? task.occurrenceSeq : null,
        task.trustLevel || null,
        JSON.stringify(Array.isArray(task.securityFlags) ? task.securityFlags : []),
        JSON.stringify(Array.isArray(task.comments) ? task.comments : []),
      ]
    );
  } catch (err) {
    console.error(`Failed to save task ${task.id}:`, errorMessage(err));
    throw err;
  }
}

export async function deleteTaskFromDb(taskId: string, deletedBy: string | null = null) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query(
      'UPDATE tasks SET deleted_at = NOW(), deleted_by = $2, updated_at = NOW() WHERE id = $1 AND deleted_at IS NULL',
      [taskId, deletedBy]
    );
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    console.error('Failed to soft-delete task:', errorMessage(err));
    return false;
  }
}

export async function hardDeleteTaskFromDb(taskId: string) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const result = await pool.query('DELETE FROM tasks WHERE id = $1', [taskId]);
    return (result.rowCount ?? 0) > 0;
  } catch (err) {
    console.error('Failed to hard-delete task:', errorMessage(err));
    return false;
  }
}

export async function restoreTaskFromDb(taskId: string) {
  const pool = getPool();
  if (!pool) return null;
  try {
    const updated = await pool.query(
      // A task deleted mid-run keeps its claim columns; restoring it must not bring
      // that dead claim back (it would make its agent look busy everywhere).
      `UPDATE tasks SET deleted_at = NULL, action_running = FALSE, action_running_agent_id = NULL,
              action_running_mode = NULL, action_heartbeat_at = NULL, started_at = NULL,
              commit_run = NULL, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NOT NULL RETURNING id`,
      [taskId]
    );
    if (updated.rows.length === 0) return null;
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to restore task:', errorMessage(err));
    return null;
  }
}

export async function getDeletedTasks() {
  return queryTasks(
    'WHERE t.deleted_at IS NOT NULL ORDER BY t.deleted_at DESC',
    [],
    'Failed to get deleted tasks:'
  );
}

export async function getDeletedTaskById(taskId: string) {
  return queryOneTask(
    'WHERE t.id = $1 AND t.deleted_at IS NOT NULL',
    [taskId],
    'Failed to get deleted task:'
  );
}

export async function deleteTasksByAgent(agentId: string) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      'UPDATE tasks SET deleted_at = NOW(), updated_at = NOW() WHERE agent_id = $1 AND deleted_at IS NULL',
      [agentId]
    );
  } catch (err) {
    console.error('Failed to soft-delete tasks for agent:', errorMessage(err));
  }
}

/**
 * Find tasks that need agent resume: active status, started, not currently watched,
 * with their assignee agent idle and enabled.
 *
 * When `environment` is provided, only tasks tagged with that environment are
 * returned.
 */
export async function getTasksForResume(environment?: string | null) {
  const pool = getPool();
  if (!pool) return [];
  try {
    const params: unknown[] = [];
    let envFilter = '';
    if (environment) {
      params.push(environment);
      envFilter = `AND t.environment = $1`;
    }
    const result = await pool.query(
      `
      SELECT t.*,
             p.id   AS _project_id,
             p.name AS _project_name,
             a.data AS agent_data
      FROM tasks t
      LEFT JOIN boards   b ON t.board_id = b.id
      LEFT JOIN projects p ON b.project_id = p.id
      JOIN agents a ON COALESCE(t.assignee, t.agent_id) = a.id
      WHERE t.deleted_at IS NULL
        AND t.is_template IS NOT TRUE
        AND t.started_at IS NOT NULL
        AND t.action_running IS NOT TRUE
        AND t.status NOT IN ('done', 'backlog', 'error')
        AND (t.execution_status IS NULL OR t.execution_status NOT IN ('watching', 'stopped'))
        AND (t.is_manual IS NULL OR t.is_manual = FALSE)
        AND t.trust_level IS DISTINCT FROM 'untrusted'
        ${envFilter}
      ORDER BY t.started_at ASC
    `,
      params
    );
    return result.rows.map(row => ({
      ...rowToTask(row),
      _agentStatus: row.agent_data?.status || 'idle',
      _agentEnabled: row.agent_data?.enabled !== false,
    }));
  } catch (err) {
    console.error('Failed to get tasks for resume:', errorMessage(err));
    return [];
  }
}

/**
 * Candidate tasks for the periodic workflow recheck (recheckPendingTransitions),
 * for a single environment, regardless of owner — this is what lets board-level
 * tasks (agent_id = NULL) be evaluated at all (the agent-keyed in-memory scan
 * could never see them).
 *
 * Filters: live (not deleted), on a board (workflows live on boards), not manual,
 * not stopped/watching, and NOT currently executing (action_running) — a running
 * task must not be re-dispatched, which is also the cross-replica guard that pairs
 * with the per-task advisory lock. Status is left wide (only done/error excluded)
 * because condition transitions can fire from backlog and other non-active columns;
 * `_recheckTask` then matches each task's status against its board's transitions.
 *
 * Indexed by `idx_tasks_workflow_recheck (environment, status)` (partial:
 * deleted_at IS NULL AND board_id IS NOT NULL) — see schema.ts.
 */
export async function getActiveWorkflowTasks(environment?: string | null) {
  const params: unknown[] = [];
  let envFilter = '';
  if (environment) {
    params.push(environment);
    envFilter = `AND t.environment = $1`;
  }
  return queryTasks(
    `WHERE t.deleted_at IS NULL
        AND ${NOT_TEMPLATE}
        AND t.board_id IS NOT NULL
        AND t.is_manual IS NOT TRUE
        AND t.trust_level IS DISTINCT FROM 'untrusted'
        AND t.status NOT IN ('done', 'error')
        AND t.action_running IS NOT TRUE
        AND (t.execution_status IS NULL OR t.execution_status NOT IN ('watching', 'stopped'))
        ${envFilter}
      ORDER BY t.created_at`,
    params,
    'Failed to get active workflow tasks:'
  );
}

/**
 * Candidate tasks for one-shot post-restart chain re-arming: live, board-bound,
 * non-manual tasks for this environment that carry a durable interruption marker
 * — a stale action_running flag (crashed mid run_agent) or a numeric
 * completed_action_idx (chain saved mid-way). The caller applies the finer
 * active-status / already-armed / stopped filters in JS (they depend on the
 * board workflow definition). MUST be read BEFORE clearAllStaleActionRunning so
 * the action_running signal is still present.
 */
export async function getInterruptedChainTasks(environment?: string | null) {
  const params: unknown[] = [];
  let envFilter = '';
  if (environment) {
    params.push(environment);
    envFilter = `AND t.environment = $1`;
  }
  return queryTasks(
    `WHERE t.deleted_at IS NULL
        AND ${NOT_TEMPLATE}
        AND t.board_id IS NOT NULL
        AND t.is_manual IS NOT TRUE
        AND t.trust_level IS DISTINCT FROM 'untrusted'
        AND (t.action_running IS TRUE OR t.completed_action_idx IS NOT NULL)
        ${envFilter}
      ORDER BY t.created_at`,
    params,
    'Failed to get interrupted chain tasks:'
  );
}

// A run whose claim is cleared by someone else (Stop, heal, boot cleanup, agent
// reset) leaves its commit context behind, stamped with the moment it ended:
// the commits made up to then are linked later (recoverPersistedCommitRun, run
// by the commit sweeper), and nothing made after that point is attributed to it.
const COMMIT_RUN_ENDED = `CASE WHEN commit_run IS NULL OR commit_run ? 'endedAt' THEN commit_run
  ELSE commit_run || jsonb_build_object('endedAt', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) END`;

/** Stamp the end of a task's run context (see COMMIT_RUN_ENDED). */
export async function markTaskCommitRunEnded(taskId: string) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(`UPDATE tasks SET commit_run = ${COMMIT_RUN_ENDED} WHERE id = $1`, [taskId]);
  } catch (err) {
    console.error('Failed to stamp the end of a commit run:', errorMessage(err));
  }
}

/**
 * Forget a task's run context — only while it is still the one that started at
 * `startedAt`: a later run of the same task may have replaced it.
 */
export async function clearTaskCommitRun(taskId: string, startedAt: string | null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query(
      `UPDATE tasks SET commit_run = NULL
        WHERE id = $1 AND commit_run IS NOT NULL
          AND ($2::text IS NULL OR commit_run->>'startedAt' = $2::text)`,
      [taskId, startedAt]
    );
  } catch (err) {
    console.error('Failed to clear a commit run:', errorMessage(err));
  }
}

/**
 * Run contexts of `environment` left with no claim — the run that wrote them
 * ended without linking its commits (killed, stopped elsewhere, or its repos
 * could not be read). A live run always holds its task's claim.
 */
export async function getOrphanCommitRuns(environment: string): Promise<Task[]> {
  return queryTasks(
    `WHERE t.commit_run IS NOT NULL AND t.action_running IS NOT TRUE
        AND t.deleted_at IS NULL AND t.environment = $1 AND ${NOT_TEMPLATE}`,
    [environment],
    'Failed to get orphan commit runs:'
  );
}

/**
 * Clear execution flags for the tasks a given agent EXECUTES (its assignments and
 * its live claim). Tasks it merely owns are left alone: the board's container
 * agent owns every card, and wiping their flags would orphan the runs other
 * agents have in flight.
 */
export async function clearTaskExecutionFlags(agentId: string, environment: string | null = null) {
  const pool = getPool();
  if (!pool) return;
  try {
    // Scoped to one environment when given: the sibling stack's run on this
    // (shared) agent is not this stack's to clear.
    const params: unknown[] = [agentId];
    let envFilter = '';
    if (environment) {
      params.push(environment);
      envFilter = 'AND environment = $2';
    }
    await pool.query(
      `
      UPDATE tasks SET
        execution_status = NULL,
        started_at = NULL,
        completed_action_idx = NULL,
        pending_on_enter = NULL,
        action_running = FALSE,
        action_running_agent_id = NULL,
        action_running_mode = NULL,
        action_heartbeat_at = NULL,
        commit_run = ${COMMIT_RUN_ENDED},
        error_from_status = NULL,
        updated_at = NOW()
      WHERE deleted_at IS NULL
        AND (assignee = $1 OR action_running_agent_id = $1)
        AND (started_at IS NOT NULL OR execution_status IS NOT NULL OR action_running = TRUE)
        ${envFilter}
    `,
      params
    );
  } catch (err) {
    console.error('Failed to clear task execution flags:', errorMessage(err));
  }
}

/**
 * Update only the execution_status of a task (lightweight update for watching/stopped transitions).
 */
export async function updateTaskExecutionStatus(taskId: string, executionStatus: string | null) {
  const pool = getPool();
  if (!pool) return;
  try {
    await pool.query('UPDATE tasks SET execution_status = $2, updated_at = NOW() WHERE id = $1', [
      taskId,
      executionStatus || null,
    ]);
  } catch (err) {
    console.error('Failed to update task execution status:', errorMessage(err));
  }
}

/**
 * Clear the run claim an agent holds. Scoped to one environment when given: a
 * Stop served by one stack interrupts that stack's PTY only, so it must not
 * release a run the sibling stack is driving on the same (shared) agent.
 */
export async function clearActionRunningForAgent(
  agentId: string,
  environment: string | null = null
) {
  const pool = getPool();
  if (!pool) return;
  try {
    const params: unknown[] = [agentId];
    let envFilter = '';
    if (environment) {
      params.push(environment);
      envFilter = 'AND environment = $2';
    }
    await pool.query(
      `
      UPDATE tasks SET
        action_running = FALSE,
        action_running_agent_id = NULL,
        action_running_mode = NULL,
        action_heartbeat_at = NULL,
        commit_run = ${COMMIT_RUN_ENDED},
        updated_at = NOW()
      WHERE action_running_agent_id = $1 AND action_running = TRUE ${envFilter}
    `,
      params
    );
  } catch (err) {
    console.error('Failed to clear action_running for agent:', errorMessage(err));
  }
}

/**
 * Boot-time cleanup of the execution markers this environment left behind.
 *
 *   • execution_status='watching' — the wait loop that set it died with the
 *     previous process; left behind it hides the task from the resume loop and
 *     the workflow recheck forever. Rows still holding a LIVE claim (fresh
 *     heartbeat: the previous replica of a start-first update is still running
 *     them) keep it.
 *   • legacy claims (action_running without a heartbeat, written by a build that
 *     predates heartbeats) — nothing can ever prove them alive, so they are
 *     cleared, and the column's on_enter is re-armed (the run they marked was
 *     interrupted mid-column; reArmInterruptedChains skips claimed rows, so
 *     nothing else would ever pick the task up again). Heartbeated claims are
 *     left to healStaleRunClaim, which only clears them once their run has
 *     provably stopped.
 *
 * Returns the number of rows touched.
 */
export async function clearAllStaleActionRunning(
  environment?: string | null,
  staleSeconds: number = RUN_CLAIM_STALE_SECONDS
) {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const params: unknown[] = [staleSeconds];
    let envFilter = '';
    if (environment) {
      params.push(environment);
      envFilter = `AND environment = $2`;
    }
    const result = await pool.query(
      `
      UPDATE tasks SET
        action_running = CASE WHEN action_heartbeat_at IS NULL THEN FALSE ELSE action_running END,
        action_running_agent_id = CASE WHEN action_heartbeat_at IS NULL THEN NULL ELSE action_running_agent_id END,
        action_running_mode = CASE WHEN action_heartbeat_at IS NULL THEN NULL ELSE action_running_mode END,
        pending_on_enter = CASE
          WHEN action_running = TRUE AND action_heartbeat_at IS NULL
               AND status NOT IN ('done', 'error') AND execution_status IS DISTINCT FROM 'stopped'
          THEN status ELSE pending_on_enter END,
        commit_run = CASE
          WHEN action_running = TRUE AND action_heartbeat_at IS NULL THEN ${COMMIT_RUN_ENDED}
          ELSE commit_run END,
        execution_status = CASE WHEN execution_status = 'watching' THEN NULL ELSE execution_status END,
        updated_at = NOW()
      WHERE deleted_at IS NULL
        AND (
          (action_running = TRUE AND action_heartbeat_at IS NULL)
          OR (execution_status = 'watching'
              AND (action_running IS NOT TRUE
                   OR action_heartbeat_at < NOW() - make_interval(secs => $1)))
        )
      ${envFilter}
    `,
      params
    );
    return result.rowCount || 0;
  } catch (err) {
    console.error('Failed to clear stale action_running flags:', errorMessage(err));
    return 0;
  }
}

// ── Additional task queries ───────────────────────────────────────────────────

/**
 * Get active tasks (not done/backlog/error) for a given agent (as owner).
 */
export async function getActiveTasksByAgent(agentId: string) {
  return queryTasks(
    `WHERE t.agent_id = $1 AND t.status NOT IN ('done','backlog','error')
         AND t.deleted_at IS NULL AND ${NOT_TEMPLATE} ORDER BY t.created_at`,
    [agentId],
    'Failed to get active tasks for agent:'
  );
}

/**
 * Get all tasks for a board.
 */
export async function getTasksByBoard(boardId: string) {
  return queryTasks(
    `WHERE t.board_id = $1 AND t.deleted_at IS NULL AND ${NOT_TEMPLATE} ORDER BY t.created_at`,
    [boardId],
    'Failed to get tasks for board:'
  );
}

/**
 * Find the board that has the most tasks for a given project name.
 * Resolved through boards.project_id → projects.name. Returns the board_id or null.
 */
export async function getBoardWithMostTasksForProject(projectName: string) {
  const pool = getPool();
  if (!pool || !projectName) return null;
  try {
    const result = await pool.query(
      `SELECT t.board_id, COUNT(*) AS task_count
       FROM tasks t
       JOIN boards b   ON t.board_id = b.id
       JOIN projects p ON b.project_id = p.id
       WHERE p.name ILIKE $1 AND t.deleted_at IS NULL AND t.is_template IS NOT TRUE
       GROUP BY t.board_id
       ORDER BY task_count DESC
       LIMIT 1`,
      [projectName]
    );
    return result.rows.length > 0 ? result.rows[0].board_id : null;
  } catch (err) {
    console.error('Failed to get board with most tasks for project:', errorMessage(err));
    return null;
  }
}

/**
 * Find the task an agent is currently executing an action for, identified by the
 * live `action_running_agent_id` flag (set while a run_agent action is in flight).
 * Independent of ownership/assignee and of the task's status — the flag is the
 * authoritative "this agent is working this task right now" signal. Returns the
 * most-recently-started match, or null.
 */
export async function getTaskByActionRunningAgent(
  agentId: string,
  environment: string | null = null
) {
  const params: unknown[] = [agentId];
  let envFilter = '';
  if (environment) {
    params.push(environment);
    envFilter = 'AND t.environment = $2';
  }
  return queryOneTask(
    `WHERE t.action_running_agent_id = $1 AND t.action_running IS TRUE AND t.deleted_at IS NULL
         AND ${NOT_TEMPLATE} ${envFilter}
       ORDER BY t.started_at DESC NULLS LAST LIMIT 1`,
    params,
    'Failed to get task by action-running agent:'
  );
}

/**
 * Get all tasks assigned to an agent (either as assignee or as owner when no assignee).
 */
export async function getTasksByAssignee(agentId: string) {
  return queryTasks(
    `WHERE (t.assignee = $1 OR (t.assignee IS NULL AND t.agent_id = $1))
         AND t.deleted_at IS NULL AND ${NOT_TEMPLATE} ORDER BY t.created_at`,
    [agentId],
    'Failed to get tasks by assignee:'
  );
}

/**
 * Find the first active task (with startedAt) for a given executor agent.
 * Checks both assignee and owner. Returns null if none found.
 */
export async function getActiveTaskForExecutor(agentId: string) {
  return queryOneTask(
    `WHERE (t.assignee = $1 OR (t.assignee IS NULL AND t.agent_id = $1))
         AND t.status NOT IN ('done','backlog','error')
         AND t.started_at IS NOT NULL
         AND t.deleted_at IS NULL
         AND ${NOT_TEMPLATE}
       ORDER BY t.started_at ASC LIMIT 1`,
    [agentId],
    'Failed to get active task for executor:'
  );
}

/**
 * Check if an agent has any active task (optionally excluding one task).
 * Returns true/false. Replaces the in-memory agentHasActiveTask cross-agent scan.
 */
export async function hasActiveTask(agentId: string, excludeTaskId: string | null = null) {
  const pool = getPool();
  if (!pool) return false;
  try {
    const params = [agentId];
    let excludeClause = '';
    if (excludeTaskId) {
      excludeClause = ' AND id != $2';
      params.push(excludeTaskId);
    }
    const result = await pool.query(
      `SELECT 1 FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND is_template IS NOT TRUE
         AND deleted_at IS NULL${excludeClause}
       LIMIT 1`,
      params
    );
    return result.rows.length > 0;
  } catch (err) {
    console.error('Failed to check active task:', errorMessage(err));
    return false;
  }
}

/**
 * Count active tasks for an agent (for load-balancing).
 */
export async function countActiveTasksForAgent(
  agentId: string,
  excludeTaskId: string | null = null
) {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const params = [agentId];
    let excludeClause = '';
    if (excludeTaskId) {
      excludeClause = ' AND id != $2';
      params.push(excludeTaskId);
    }
    const result = await pool.query(
      `SELECT COUNT(*)::int as count FROM tasks
       WHERE (assignee = $1 OR (assignee IS NULL AND agent_id = $1))
         AND status NOT IN ('done','backlog','error')
         AND is_template IS NOT TRUE
         AND deleted_at IS NULL${excludeClause}`,
      params
    );
    return result.rows[0]?.count || 0;
  } catch (err) {
    console.error('Failed to count active tasks:', errorMessage(err));
    return 0;
  }
}

/**
 * Every recurring RULE, whatever its board. The scheduler decides which are due
 * from each rule's own `recurrence.lastResetAt`.
 *
 * `is_template` is the filter, not `recurrence IS NOT NULL`: the two are
 * equivalent by invariant, but reading the flag means a rule whose recurrence
 * JSON was somehow cleared is still recognised as a rule (and skipped by the
 * scheduler) instead of silently re-entering the board as a task.
 */
export async function getRecurringTasks() {
  return queryTasks(
    `WHERE t.is_template IS TRUE
         AND t.recurrence IS NOT NULL
         AND t.deleted_at IS NULL`,
    [],
    'Failed to get recurring tasks:'
  );
}

/** Recurring rules of one board (the panel), or of every accessible board. */
export async function getTaskTemplates(boardId?: string | null) {
  const params: unknown[] = [];
  let boardFilter = '';
  if (boardId) {
    params.push(boardId);
    boardFilter = `AND t.board_id = $${params.length}`;
  }
  return queryTasks(
    `WHERE t.is_template IS TRUE AND t.deleted_at IS NULL ${boardFilter}
      ORDER BY t.created_at DESC`,
    params,
    'Failed to get task templates:'
  );
}

/** One rule by id — returns null for a normal task, so callers cannot edit a
 * card through the template routes (or a rule through the task routes). */
export async function getTaskTemplateById(templateId: string) {
  return queryOneTask(
    'WHERE t.id = $1 AND t.is_template IS TRUE AND t.deleted_at IS NULL',
    [templateId],
    'Failed to get task template:'
  );
}

/** Runs spawned by a rule, newest first. */
export async function getOccurrencesForTemplate(templateId: string, limit = 50) {
  return queryTasks(
    `WHERE t.template_id = $1 AND t.deleted_at IS NULL
      ORDER BY t.occurrence_seq DESC NULLS LAST, t.created_at DESC
      LIMIT $2`,
    [templateId, Math.min(Math.max(limit, 1), 500)],
    'Failed to get template occurrences:'
  );
}

/**
 * Is a previous run still in flight? Drives the `skip` overlap policy.
 *
 * Unfinished means "has not reached a terminal column": `done` and `error` are
 * both terminal (an errored run stopped, it is not still working). A run nobody
 * ever picked up counts as unfinished, which is the point — with `skip`, runs
 * stop piling up behind a workflow that is not moving.
 */
export async function countUnfinishedOccurrences(templateId: string): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  try {
    const result = await pool.query(
      `SELECT COUNT(*)::int AS count FROM tasks
        WHERE template_id = $1 AND deleted_at IS NULL AND status NOT IN ('done', 'error')`,
      [templateId]
    );
    return result.rows[0]?.count || 0;
  } catch (err) {
    console.error('Failed to count unfinished occurrences:', errorMessage(err));
    return 0;
  }
}

/**
 * Drop old runs of one rule. This is what bounds a recurring task's footprint
 * now that each cycle is its own row.
 *
 * Two independent limits, both optional (0/null disables): `retentionDays`
 * (older than N days) and `keepLast` (keep the N most recent runs). A run is
 * only ever eligible when it is FINISHED — an in-flight occurrence is never
 * deleted, however old, because it still belongs to an agent.
 *
 * Hard delete, not the soft `deleted_at`: a soft delete keeps the row, its
 * history and its commits forever, which is the growth this whole change
 * exists to stop. Audit rows go with it — `task_audit_logs.task_id` has no FK
 * (deliberately, so a deleted task keeps its trail), so nothing cascades and
 * they must be swept explicitly.
 */
export async function purgeTemplateOccurrences(
  templateId: string,
  { retentionDays, keepLast }: { retentionDays?: number | null; keepLast?: number | null } = {}
): Promise<number> {
  const pool = getPool();
  if (!pool) return 0;
  const days = retentionDays && retentionDays > 0 ? retentionDays : null;
  const keep = keepLast && keepLast > 0 ? keepLast : null;
  if (!days && !keep) return 0;
  try {
    const result = await pool.query<{ id: string }>(
      `WITH finished AS (
         SELECT id,
                COALESCE(completed_at, updated_at, created_at) AS ended_at,
                ROW_NUMBER() OVER (
                  ORDER BY occurrence_seq DESC NULLS LAST, created_at DESC
                ) AS recency
           FROM tasks
          WHERE template_id = $1
            AND deleted_at IS NULL
            AND status IN ('done', 'error')
       )
       DELETE FROM tasks
        WHERE id IN (
          SELECT id FROM finished
           WHERE ($2::int IS NOT NULL AND ended_at < NOW() - ($2 * INTERVAL '1 day'))
              OR ($3::int IS NOT NULL AND recency > $3)
        )
       RETURNING id`,
      [templateId, days, keep]
    );
    const ids = result.rows.map(r => r.id);
    if (ids.length > 0) {
      await pool
        .query('DELETE FROM task_audit_logs WHERE task_id = ANY($1::uuid[])', [ids])
        .catch(err => console.error('Failed to purge occurrence audit logs:', errorMessage(err)));
    }
    return ids.length;
  } catch (err) {
    console.error('Failed to purge template occurrences:', errorMessage(err));
    return 0;
  }
}

/**
 * Free-text + faceted search across the task history.
 *
 * All filters are optional. `query` matches title/text/error case-insensitively.
 * Date filters use ISO timestamps. By default soft-deleted tasks are excluded.
 * Returns up to `limit` rows (default 50, hard cap 200) ordered newest-first.
 */
export async function searchTasks(
  opts: {
    query?: string | null;
    agentId?: string | null;
    project?: string | null;
    boardId?: string | null;
    /** Tenant bound: when present, the search NEVER leaves these boards, and an
     * empty list matches nothing. `boardId` narrows further within it. Callers
     * acting for an agent pass its scope (lib/agentScope.ts); a human route
     * omits it and keeps its own guard. */
    boardIds?: string[] | null;
    status?: string | null;
    repoFullName?: string | null;
    createdAfter?: string | Date | null;
    createdBefore?: string | Date | null;
    completedAfter?: string | Date | null;
    completedBefore?: string | Date | null;
    onlyCompleted?: boolean | null;
    includeDeleted?: boolean | null;
    limit?: number | null;
    offset?: number | null;
  } = {}
) {
  const pool = getPool();
  if (!pool) return { total: 0, returned: 0, tasks: [] };
  if (opts.boardIds && opts.boardIds.length === 0) return { total: 0, returned: 0, tasks: [] };
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (!opts.includeDeleted) conditions.push('t.deleted_at IS NULL');
    // A recurring rule is configuration, not a task anyone searches for.
    conditions.push(NOT_TEMPLATE);

    if (opts.boardIds) {
      conditions.push(`t.board_id = ANY($${idx}::uuid[])`);
      params.push(opts.boardIds);
      idx++;
    }

    if (opts.query && opts.query.trim()) {
      conditions.push(`(t.text ILIKE $${idx} OR t.title ILIKE $${idx} OR t.error ILIKE $${idx})`);
      params.push(`%${opts.query.trim()}%`);
      idx++;
    }
    if (opts.agentId) {
      conditions.push(`(t.agent_id = $${idx} OR t.assignee = $${idx})`);
      params.push(opts.agentId);
      idx++;
    }
    if (opts.project) {
      conditions.push(`p.name ILIKE $${idx}`);
      params.push(opts.project);
      idx++;
    }
    if (opts.boardId) {
      conditions.push(`t.board_id = $${idx}`);
      params.push(opts.boardId);
      idx++;
    }
    if (opts.status) {
      conditions.push(`t.status = $${idx}`);
      params.push(opts.status);
      idx++;
    }
    if (opts.repoFullName) {
      conditions.push(`t.repo_full_name ILIKE $${idx}`);
      params.push(opts.repoFullName);
      idx++;
    }
    if (opts.createdAfter) {
      conditions.push(`t.created_at >= $${idx}`);
      params.push(opts.createdAfter);
      idx++;
    }
    if (opts.createdBefore) {
      conditions.push(`t.created_at <= $${idx}`);
      params.push(opts.createdBefore);
      idx++;
    }
    if (opts.completedAfter) {
      conditions.push(`t.completed_at >= $${idx}`);
      params.push(opts.completedAfter);
      idx++;
    }
    if (opts.completedBefore) {
      conditions.push(`t.completed_at <= $${idx}`);
      params.push(opts.completedBefore);
      idx++;
    }
    if (opts.onlyCompleted) {
      conditions.push(`t.completed_at IS NOT NULL`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.min(opts.limit || 50, 200));
    const offset = Math.max(0, opts.offset || 0);

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM tasks t
       LEFT JOIN boards   b ON t.board_id = b.id
       LEFT JOIN projects p ON b.project_id = p.id
       ${where}`,
      params
    );
    const total = countResult.rows[0]?.total || 0;

    const result = await pool.query(
      `${TASK_SELECT} ${where} ORDER BY t.created_at DESC LIMIT ${limit} OFFSET ${offset}`,
      params
    );
    const tasks = result.rows.map(rowToTask);
    return { total, returned: tasks.length, tasks };
  } catch (err) {
    console.error('Failed to search tasks:', errorMessage(err));
    return { total: 0, returned: 0, tasks: [] };
  }
}

/**
 * Get tasks filtered by status and/or board.
 * Both parameters are optional — pass null to skip a filter.
 */
/**
 * Same filter as getTasksByStatusAndBoard, but over an EXPLICIT set of boards.
 *
 * This is the form the agent-facing list_tasks uses: the caller resolves which
 * boards the agent may read (lib/agentScope.ts) and passes them in. An empty
 * set returns no task rather than every task on the instance, which is what
 * getTasksByStatusAndBoard(status, null) returns and why an agent must not
 * call it.
 */
export async function getTasksByStatusAndBoards(
  status: string | null,
  boardIds: string[]
): Promise<Task[]> {
  if (boardIds.length === 0) return [];
  const conditions = ['t.deleted_at IS NULL', NOT_TEMPLATE, 't.board_id = ANY($1::uuid[])'];
  const params: unknown[] = [boardIds];
  if (status) {
    conditions.push(`t.status = $2`);
    params.push(status);
  }
  return queryTasks(
    `WHERE ${conditions.join(' AND ')} ORDER BY t.position, t.created_at`,
    params,
    'Failed to get tasks by status/boards:'
  );
}

export async function getTasksByStatusAndBoard(
  status: string | null = null,
  boardId: string | null = null
) {
  const conditions = ['t.deleted_at IS NULL', NOT_TEMPLATE];
  const params: string[] = [];
  let idx = 1;
  if (status) {
    conditions.push(`t.status = $${idx}`);
    params.push(status);
    idx++;
  }
  if (boardId) {
    conditions.push(`t.board_id = $${idx}`);
    params.push(boardId);
    idx++;
  }
  return queryTasks(
    `WHERE ${conditions.join(' AND ')} ORDER BY t.position, t.created_at`,
    params,
    'Failed to get tasks by status/board:'
  );
}

/** Resolve a field name (camelCase or snake_case) to its writable column. */
function taskColumnFor(key: string): string | null {
  // Object.hasOwn avoids prototype-chain keys (e.g. 'toString') sneaking in.
  if (Object.hasOwn(TASK_COLUMN_BY_FIELD, key)) return TASK_COLUMN_BY_FIELD[key];
  return TASK_COLUMNS.has(key) ? key : null;
}

/** Objects and arrays go to JSONB columns as JSON text; scalars and Dates as-is. */
function toColumnValue(value: unknown): unknown {
  if (value instanceof Date) return value;
  return typeof value === 'object' && value !== null ? JSON.stringify(value) : value;
}

export interface UpdateTaskFieldsOptions {
  /**
   * Apply the update only if these columns still hold these values (null means
   * IS NULL). Returns null — nothing written — when the row no longer matches,
   * which is how a writer avoids clobbering a change made since it looked.
   */
  expect?: Record<string, unknown>;
}

/**
 * Update specific fields of a task. Returns the updated task, or null when
 * nothing was written (unknown task, `expect` mismatch, DB error).
 *
 * `historyAppend: [entry, …]` appends to `history` atomically (jsonb concat)
 * instead of rewriting the array from a snapshot, so concurrent writers cannot
 * drop each other's audit entries. Prefer it to passing `history`.
 */
export async function updateTaskFields(
  taskId: string,
  fields: Record<string, unknown>,
  { expect }: UpdateTaskFieldsOptions = {}
) {
  const pool = getPool();
  if (!pool) return null;
  const sets: string[] = [];
  // Heterogeneous on purpose: $1 is the id, the rest are whatever the caller
  // set — strings, numbers, Dates, or JSON.stringify'd objects (see below).
  const values: unknown[] = [taskId];
  let paramIdx = 2;
  const { historyAppend, ...columns } = fields;
  for (const [key, value] of Object.entries(columns)) {
    // Resolve the writable column: a known camelCase field maps to its snake_case
    // column, or an already-snake_case key passes through if it is a known column.
    const col = taskColumnFor(key);
    if (!col) continue;
    sets.push(`${col} = $${paramIdx}`);
    values.push(toColumnValue(value));
    paramIdx++;
  }
  if (Array.isArray(historyAppend) && historyAppend.length > 0 && !('history' in columns)) {
    sets.push(`history = COALESCE(history, '[]'::jsonb) || $${paramIdx}::jsonb`);
    values.push(JSON.stringify(historyAppend));
    paramIdx++;
  }
  if (sets.length === 0) return null;
  sets.push('updated_at = NOW()');
  const guards: string[] = [];
  for (const [key, value] of Object.entries(expect || {})) {
    const col = taskColumnFor(key);
    if (!col) continue;
    if (value === null || value === undefined) {
      guards.push(`${col} IS NULL`);
    } else {
      guards.push(`${col} = $${paramIdx}`);
      values.push(toColumnValue(value));
      paramIdx++;
    }
  }
  const where = ['id = $1', ...guards].join(' AND ');
  try {
    const updated = await pool.query(
      `UPDATE tasks SET ${sets.join(', ')} WHERE ${where} RETURNING id`,
      values
    );
    if (updated.rows.length === 0) return null;
    const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
    return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
  } catch (err) {
    console.error('Failed to update task fields:', errorMessage(err));
    return null;
  }
}

// ─── Run claims: one live run per task AND per agent, enforced by the DB ──────
//
// Every execution (workflow run_agent action, task-loop resume, explicit start)
// CLAIMS its task before it touches the agent: action_running +
// action_running_agent_id are set by ONE conditional UPDATE. Two guards make the
// claim exclusive across processes, replicas and the environments sharing this DB:
//   • `action_running IS NOT TRUE` — a task already being run is not claimed twice;
//   • the partial unique index uniq_tasks_running_agent — an agent already running
//     ANOTHER task anywhere makes the UPDATE fail with 23505.
// The in-process reservation (workflow/agentSelector.ts) stays the synchronous
// first line of defence; this is what holds when it cannot see the other run.
//
// A live run refreshes action_heartbeat_at; a claim whose heartbeat stopped
// belongs to a run that is provably gone (crash, killed replica, stopped stack)
// and is healed by healStaleRunClaim, from any environment.

/** A claim whose heartbeat is older than this is dead (heartbeat every ~20 s). */
export const RUN_CLAIM_STALE_SECONDS = 120;
/** Legacy claims (no heartbeat) of the own environment are dead after this. */
export const LEGACY_CLAIM_STALE_MINUTES = 20;

export type TaskRunClaimFailure =
  | 'task-running'
  | 'agent-busy'
  | 'moved'
  | 'stopped'
  | 'missing'
  | 'error';

/**
 * Claim `taskId` for `agentId`. With `expectStatus`, only while the task still
 * sits in that column: a card moved on while its old column's run was being
 * prepared must not be run with that column's instructions. A task the user
 * stopped is never claimed (its Stop may land before the claim). A workflow
 * run's claim also consumes the column's retry marker (pending_on_enter): left
 * set, a sibling replica could dispatch the column again while this run is
 * going. A task-loop resume ('resume') is no workflow action and leaves it.
 */
export async function claimTaskRun(
  taskId: string,
  agentId: string,
  mode: string,
  expectStatus: string | null = null
): Promise<{ ok: true; task: Task } | { ok: false; reason: TaskRunClaimFailure }> {
  const pool = getPool();
  if (!pool) return { ok: false, reason: 'error' };
  try {
    const claimed = await pool.query(
      `UPDATE tasks
          SET action_running = TRUE, action_running_agent_id = $2, action_running_mode = $3,
              started_at = COALESCE(started_at, NOW()), action_heartbeat_at = NOW(),
              pending_on_enter = CASE WHEN $3 = 'resume' THEN pending_on_enter ELSE NULL END,
              updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL AND action_running IS NOT TRUE
          AND ($4::text IS NULL OR status = $4::text)
          AND execution_status IS DISTINCT FROM 'stopped'
        RETURNING id`,
      [taskId, agentId, mode, expectStatus]
    );
    const task = await getTaskById(taskId);
    if (claimed.rows.length === 0) {
      if (!task) return { ok: false, reason: 'missing' };
      if (task.actionRunning) return { ok: false, reason: 'task-running' };
      if (task.executionStatus === 'stopped') return { ok: false, reason: 'stopped' };
      return { ok: false, reason: 'moved' };
    }
    if (!task) {
      // Claimed but unreadable: never leave the claim behind with no run to
      // heartbeat or release it.
      await releaseTaskRun(taskId, agentId).catch(() => {});
      return { ok: false, reason: 'error' };
    }
    return { ok: true, task };
  } catch (err) {
    if ((err as { code?: string })?.code === '23505') return { ok: false, reason: 'agent-busy' };
    console.error('Failed to claim task run:', errorMessage(err));
    return { ok: false, reason: 'error' };
  }
}

/** Keep a live claim fresh. Leaves updated_at alone: nothing visible changed.
 *  Returns false when the claim is gone, null when the DB could not be reached. */
export async function heartbeatTaskRun(taskId: string, agentId: string): Promise<boolean | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `UPDATE tasks SET action_heartbeat_at = NOW()
        WHERE id = $1 AND action_running IS TRUE AND action_running_agent_id = $2
        RETURNING id`,
      [taskId, agentId]
    );
    return r.rows.length > 0;
  } catch (err) {
    console.error('Failed to heartbeat task run:', errorMessage(err));
    return null;
  }
}

/**
 * End a run: clear its claim — but only while it is still THIS agent's. A Stop
 * or the healer may have cleared it already, and another run's claim must never
 * be released by a finished one. `clearAssignee` drops the assignee only if it
 * is still the executor (a user may have reassigned the task meanwhile).
 * Throws on a DB error so the caller can retry; returns the fresh row.
 */
export async function releaseTaskRun(
  taskId: string,
  agentId: string,
  {
    clearAssignee = false,
    keepStartedAt = false,
  }: { clearAssignee?: boolean; keepStartedAt?: boolean } = {}
): Promise<Task | null> {
  const pool = getPool();
  if (!pool) return null;
  await pool.query(
    `UPDATE tasks
        SET action_running = FALSE, action_running_agent_id = NULL, action_running_mode = NULL,
            action_heartbeat_at = NULL,
            started_at = CASE WHEN $3::boolean THEN started_at ELSE NULL END,
            updated_at = NOW()
      WHERE id = $1 AND action_running IS TRUE AND action_running_agent_id = $2`,
    [taskId, agentId, keepStartedAt]
  );
  if (clearAssignee) {
    // Independent of the claim: a Stop clears the claim before the run ends, and
    // the executor must not stay assigned to the card it was stopped on. Never
    // while another run holds the task.
    await pool.query(
      `UPDATE tasks SET assignee = NULL, updated_at = NOW()
        WHERE id = $1 AND assignee = $2 AND action_running IS NOT TRUE`,
      [taskId, agentId]
    );
  }
  return getTaskById(taskId);
}

/** Agents holding a live (or not yet healed) run claim, in any environment. */
export async function getRunningAgentIds(): Promise<Set<string>> {
  const pool = getPool();
  if (!pool) return new Set();
  try {
    const r = await pool.query<{ agent: string }>(
      `SELECT DISTINCT action_running_agent_id AS agent FROM tasks
        WHERE action_running IS TRUE AND deleted_at IS NULL AND action_running_agent_id IS NOT NULL`
    );
    return new Set(r.rows.map(row => row.agent));
  } catch (err) {
    console.error('Failed to list running agents:', errorMessage(err));
    return new Set();
  }
}

/** Predicate shared by the stale-claim query and its conditional heal. */
const STALE_CLAIM_SQL = `t.action_running IS TRUE AND t.deleted_at IS NULL AND (
     (t.action_heartbeat_at IS NOT NULL
        AND t.action_heartbeat_at < NOW() - make_interval(secs => $1))
     OR (t.action_heartbeat_at IS NULL AND t.environment = $2
        AND (t.started_at IS NULL OR t.started_at < NOW() - make_interval(mins => $3))))`;

/**
 * Claims whose run is provably gone: heartbeat older than `staleSeconds` (any
 * environment — a dead stack cannot heartbeat, and its claim would otherwise
 * block the shared agent everywhere), or legacy claims without a heartbeat of
 * `ownEnv` older than `legacyMinutes`.
 */
export async function getStaleRunClaims(
  ownEnv: string,
  staleSeconds: number = RUN_CLAIM_STALE_SECONDS,
  legacyMinutes: number = LEGACY_CLAIM_STALE_MINUTES
): Promise<Task[]> {
  return queryTasks(
    `WHERE ${STALE_CLAIM_SQL} AND ${NOT_TEMPLATE} ORDER BY t.created_at`,
    [staleSeconds, ownEnv, legacyMinutes],
    'Failed to get stale run claims:'
  );
}

/**
 * Clear one stale claim, re-checking staleness atomically (a heartbeat that
 * landed since the query keeps the claim), and re-arm the column's on_enter so
 * the workflow picks the task up again. The started_at stamp is kept: it is
 * what lets the resume loop pick up a run interrupted in a column without
 * workflow actions. Returns the healed row (with the stale claim's agent in
 * `staleAgentId`), or null when it was not stale anymore.
 */
export async function healStaleRunClaim(
  taskId: string,
  ownEnv: string,
  staleSeconds: number = RUN_CLAIM_STALE_SECONDS,
  legacyMinutes: number = LEGACY_CLAIM_STALE_MINUTES
): Promise<(Task & { staleAgentId: string | null }) | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query<{ agent: string | null }>(
      `WITH stale AS (
         SELECT t.id, t.action_running_agent_id AS agent FROM tasks t
          WHERE t.id = $4 AND ${STALE_CLAIM_SQL}
          FOR UPDATE)
       UPDATE tasks u
          SET action_running = FALSE, action_running_agent_id = NULL, action_running_mode = NULL,
              action_heartbeat_at = NULL,
              commit_run = ${COMMIT_RUN_ENDED.replace(/commit_run/g, 'u.commit_run')},
              execution_status = CASE WHEN u.execution_status = 'watching' THEN NULL ELSE u.execution_status END,
              pending_on_enter = CASE
                WHEN u.status IN ('done', 'error') OR u.execution_status = 'stopped' THEN u.pending_on_enter
                ELSE u.status END,
              updated_at = NOW()
         FROM stale WHERE u.id = stale.id
       RETURNING stale.agent`,
      [staleSeconds, ownEnv, legacyMinutes, taskId]
    );
    if (r.rows.length === 0) return null;
    const task = await getTaskById(taskId);
    return task ? { ...task, staleAgentId: r.rows[0].agent } : null;
  } catch (err) {
    console.error('Failed to heal stale run claim:', errorMessage(err));
    return null;
  }
}

/**
 * Agents that are the explicit assignee of an active (non backlog/done/error)
 * task other than `excludeTaskId`, on the same board and in the same
 * environment. Automatic assignment skips them, so the engine never puts one
 * agent on two in-progress cards of a board — while a card parked on another
 * board, or a QA card, does not starve this board's queue.
 */
export async function getActiveAssigneeIds(
  excludeTaskId: string | null,
  scope: { boardId: string | null; environment: string | null }
) {
  const pool = getPool();
  if (!pool) return new Set<string>();
  try {
    const r = await pool.query<{ agent: string }>(
      `SELECT DISTINCT assignee AS agent FROM tasks
        WHERE assignee IS NOT NULL AND deleted_at IS NULL AND is_template IS NOT TRUE
          AND status NOT IN ('done', 'backlog', 'error')
          AND ($1::uuid IS NULL OR id <> $1::uuid)
          AND board_id IS NOT DISTINCT FROM $2::uuid
          AND COALESCE(environment, 'prod') = COALESCE($3::text, 'prod')`,
      [excludeTaskId, scope.boardId, scope.environment]
    );
    return new Set(r.rows.map(row => row.agent));
  } catch (err) {
    console.error('Failed to list active assignees:', errorMessage(err));
    return new Set<string>();
  }
}

/**
 * Read-modify-write of `commits` under a row lock, in one transaction: two
 * linkers running at once (mid-run sweep, update_task, end-of-run reconcile)
 * both land, which a read + full-row save could not guarantee. `mutate`
 * receives the current list and returns the new one, or null for "no change".
 * Returns `{ task, changed }`, or null when the task does not exist.
 */
export async function mutateTaskCommits(
  taskId: string,
  mutate: (commits: TaskCommit[]) => TaskCommit[] | null
): Promise<{ task: Task; changed: boolean } | null> {
  const pool = getPool();
  if (!pool) return null;
  const client = await pool.connect();
  let changed = false;
  try {
    await client.query('BEGIN');
    const cur = await client.query<{ commits: TaskCommit[] | null }>(
      'SELECT commits FROM tasks WHERE id = $1 AND deleted_at IS NULL FOR UPDATE',
      [taskId]
    );
    if (cur.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const next = mutate(Array.isArray(cur.rows[0].commits) ? [...cur.rows[0].commits] : []);
    if (next) {
      await client.query('UPDATE tasks SET commits = $2, updated_at = NOW() WHERE id = $1', [
        taskId,
        JSON.stringify(next),
      ]);
      changed = true;
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  const task = await getTaskById(taskId);
  return task ? { task, changed } : null;
}

/**
 * Hand a task to another owning agent IN PLACE: same id, same commits, history,
 * comments and attachments (re-creating the row lost them all, and orphaned the
 * commits of a run still pointing at the old id).
 */
export async function transferTaskOwner(
  taskId: string,
  toAgentId: string,
  historyEntry: TaskHistoryEntry
): Promise<Task | null> {
  const pool = getPool();
  if (!pool) return null;
  try {
    const r = await pool.query(
      `UPDATE tasks SET agent_id = $2, assignee = $2,
              history = COALESCE(history, '[]'::jsonb) || $3::jsonb, updated_at = NOW()
        WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
      [taskId, toAgentId, JSON.stringify([historyEntry])]
    );
    return r.rows.length ? getTaskById(taskId) : null;
  } catch (err) {
    console.error('Failed to transfer task:', errorMessage(err));
    return null;
  }
}

/**
 * Append one comment to a task's thread, atomically (`comments || $2`), so a
 * concurrent writer holding a stale task snapshot can never drop it. Returns
 * the re-read task, or null when the task does not exist / no DB.
 */
export async function appendTaskComment(taskId: string, comment: TaskComment) {
  const pool = getPool();
  if (!pool) return null;
  const updated = await pool.query(
    `UPDATE tasks SET comments = COALESCE(comments, '[]'::jsonb) || $2::jsonb, updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL RETURNING id`,
    [taskId, JSON.stringify([comment])]
  );
  if (updated.rows.length === 0) return null;
  const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
  return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
}

/**
 * Remove one comment (by id) from a task's thread, atomically. Returns the
 * re-read task, or null when the task or the comment does not exist.
 */
export async function deleteTaskComment(taskId: string, commentId: string) {
  const pool = getPool();
  if (!pool) return null;
  const updated = await pool.query(
    `UPDATE tasks
        SET comments = COALESCE(
              (SELECT jsonb_agg(e.c ORDER BY e.n)
                 FROM jsonb_array_elements(comments) WITH ORDINALITY AS e(c, n)
                WHERE e.c->>'id' <> $2),
              '[]'::jsonb),
            updated_at = NOW()
      WHERE id = $1 AND deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(comments) AS e(c) WHERE e.c->>'id' = $2)
      RETURNING id`,
    [taskId, commentId]
  );
  if (updated.rows.length === 0) return null;
  const result = await pool.query(`${TASK_SELECT} WHERE t.id = $1`, [taskId]);
  return result.rows.length > 0 ? rowToTask(result.rows[0]) : null;
}
