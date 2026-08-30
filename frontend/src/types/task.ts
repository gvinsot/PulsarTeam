// ── Task and its sub-shapes ─────────────────────────────────────────────────
//
// `Task` describes ONE producer: rowToTask (api/src/services/database/tasks.ts:56),
// the SQL row → JSON mapper behind GET /tasks. The mapper is the authority: where
// it writes `|| undefined` the KEY IS DROPPED from the JSON (optional), where it
// writes a raw passthrough the key is present and may be null (nullable). The two
// are not the same and this file keeps them apart field by field.
//
// A `task:updated` SOCKET FRAME IS NOT A `Task`, and no amount of prose makes it
// one. Two independent reasons, both verified against the emitters:
//
//  1. The frame emitted right after creation carries the raw in-memory `newTask`
//     (api/src/services/agentManager/tasks.ts:172-222). That object is built by
//     hand and never round-trips through rowToTask, so it has NO updatedAt, no
//     commits, no title, no project/projectId, no repoHtmlUrl, no assignee and no
//     actionRunning.
//  2. Half of the other emit paths send the MUTATED task object rather than a
//     re-read row, and they write EXPLICIT NULLS where rowToTask normalises to
//     undefined. The most frequent path of all — a column drag — goes through
//     clearExecutionOnMove (api/src/services/taskMutations.ts:98-99), which sets
//     `task.startedAt = null; task.executionStatus = null;` and, under `full`,
//     `task.completedActionIdx = null` (:105).
//
// So the frame is DECLARED, not described: see TaskSocketPayload and
// TaskCreatedEvent at the bottom of this file. Nothing changes until a consumer
// adopts them — TasksBoard does not import this module yet. Once its socket
// state is typed with them, its two ways of mixing a frame into its Task[] stop
// type-checking: `return [...prev, task]` (TasksBoard.tsx:284) and
// `updated[idx] = { ...existing, ...task }` (:297). Both launder a frame into a
// `Task` in one expression today.
//
// (Not, note, the Date.parse calls: TasksBoard.tsx:294-295 and :212-213 all read
// `x.updatedAt ? Date.parse(x.updatedAt) : 0`, which narrows correctly and is
// already safe. The unsound step is the assignment, not the parse.)
//
// On the OPEN-VALUE-SPACE rule applied to the unions below, see index.ts.

import type { StoredAgentMode, TaskStatus } from './board';
import type { ConversationMessageType, ConversationRole, MessageToolResult } from './agent';

/**
 * RULE 2 (see index.ts). Enforced ONLY on the LLM set_type path
 * (SET_TYPE_VALID_TYPES, api/src/services/workflow/actionExecutor.ts:992) and
 * mirrored by the frontend TASK_TYPES. PUT /tasks/:id accepts ANY string <= 50
 * chars (`taskType: optionalString(50)`, api/src/schemas/tasks.ts:18), so an
 * off-union value is genuinely storable — and the lookup-map-with-fallback rule 2
 * asks for is already there: `TASK_TYPE_MAP[task.taskType] &&` (TaskCard.tsx:444).
 * The union is the product contract; the tail is what is storable.
 */
export type TaskType =
  'bug' | 'feature' | 'technical' | 'improvement' | 'documentation' | 'other' | (string & {});

/**
 * RULE 2. No API-side producer ever writes a priority — it comes straight from
 * the client and the API only length-caps it at 50 chars
 * (api/src/schemas/tasks.ts:19). The union is the frontend PRIORITIES list
 * (taskConstants.ts:247-275), which every renderer keys on through PRIORITY_MAP
 * (:278).
 */
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low' | (string & {});

/**
 * Closed set: 'watching' and 'stopped'; everything else clears the column to
 * NULL (api/src/services/agentManager/status.ts:44).
 */
export type TaskExecutionStatus = 'watching' | 'stopped';

/**
 * RULE 2. Provenance of a task. NOT validated server-side — POST /agents/:id/tasks
 * does `const resolvedSource = source || {...}` straight off the body
 * (api/src/routes/agents.ts:397) and addTask stores the caller's object verbatim
 * (agentManager/tasks.ts:184) — but the union below is the exhaustive set of
 * literals across every call site in api/src.
 *
 * The lookup-map-with-fallback rule 2 asks for is SOURCE_META
 * (taskConstants.ts:145), read as `SOURCE_META[task.source.type] || SOURCE_META.api`
 * (TaskCard.tsx:53). Beware it has no entry for 'auto' or 'transfer' (they fall
 * back to the 'API' badge) and defines two dead entries, 'agent' and 'recurrence',
 * that no producer ever writes.
 */
export type TaskSourceType =
  'user' | 'website' | 'api' | 'mcp' | 'auto' | 'transfer' | (string & {});

/**
 * RULE 2. Not validated by the API at all (`recurrence: z.any().optional()`,
 * api/src/schemas/tasks.ts:23); the union comes from the only writer,
 * RECURRENCE_PERIODS (taskConstants.ts:215). The fallback rule 2 asks for is
 * recurrenceLabel (taskConstants.ts:240-242), which returns the RAW value for an
 * unknown period.
 */
export type TaskRecurrencePeriod =
  'hourly' | 'daily' | 'weekly' | 'monthly' | 'custom' | (string & {});

/**
 * RULE 1 (closed union): `history` is not a field of updateTaskSchema
 * (api/src/schemas/tasks.ts:11-42), so no client can write one — api/src is the
 * only producer. Genuinely ABSENT for a plain status transition, which is why it
 * is optional rather than a required union.
 */
export type TaskHistoryEntryType =
  | 'edit'
  | 'reassign'
  | 'execution'
  | 'error'
  | 'stopped'
  | 'restored'
  | 'board_move'
  | 'workflow_column_rename';

/**
 * One git commit linked to a task, as pushed into task.commits.
 * Produced by api/src/services/agentManager/tasks.ts:658.
 */
export interface TaskCommit {
  /** May be a SHORT (7-char) or a full 40-char hash: addTaskCommit dedupes by
   *  prefix and upgrades a short hash in place when the full one later arrives.
   *  Consumers slice it defensively. */
  hash: string;
  /** Never null, but can be the empty string. Truncated to 200 chars on
   *  detection. */
  message: string;
  /** ISO 8601 — the LINK time, not the commit's author date. */
  date: string;
  /** Conditionally spread, so the key is genuinely ABSENT unless the git
   *  reconcile path supplied it. TaskTimeline correctly tests `=== false`
   *  rather than falsiness. */
  pushed?: boolean;
}

/**
 * An extra repo cloned alongside the primary one at run time.
 * Produced by api/src/services/taskRepos.ts:66 (normalizeSecondaryRepos is the
 * single gate on every write path, so both fields are always well-formed).
 */
export interface TaskSecondaryRepo {
  /** Defaults to 'github' when the input omits it. */
  provider: string;
  /** Always a well-formed 'owner/repo'; malformed entries, duplicates and the
   *  primary repo are dropped, and the list is capped at 10. */
  fullName: string;
}

/**
 * Provenance stamp recorded once at task creation.
 * Produced by api/src/services/agentManager/tasks.ts:184 (the caller's object is
 * stored verbatim).
 */
export interface TaskSource {
  type: TaskSourceType;
  /** `req.user?.username || undefined` → the key can be absent even on a 'user'
   *  source. Also set for 'website' and 'transfer'. */
  name?: string;
  /** Only present on a 'transfer' source — the id of the agent the task came
   *  from. */
  id?: string;
  /** Only present on an 'auto' source; the sole observed value is
   *  'commit-link'. */
  reason?: string;
}

/**
 * Recurring-reset configuration; the scheduler re-arms the task each interval.
 * Produced by api/src/services/agentManager/tasks.ts:198.
 *
 * Disabling recurrence sets the whole object to null (api/src/routes/tasks.ts:215),
 * it does NOT set enabled:false — see Task.recurrence.
 */
export interface TaskRecurrence {
  /** Every current writer sets it literally to true; typed boolean only because
   *  legacy rows could still carry false. */
  enabled: boolean;
  period: TaskRecurrencePeriod;
  /** Defaults to 1440. Only meaningful when period === 'custom'. */
  intervalMinutes: number;
  /** The column the task is reset back to. */
  originalStatus: TaskStatus;
  /** NULLABLE, and null means "keep everything". normalizeRetention maps
   *  null/0/''/false/NaN/<=0 to null and clamps to 3650. */
  historyRetentionDays: number | null;
  /** ISO 8601 reference timestamp for the next reset, rewritten each cycle. */
  lastResetAt: string;
}

/**
 * One conversation turn captured inside an 'execution' history entry.
 * Produced by api/src/services/agentManager/actionLogs.ts:95-104.
 *
 * This really IS a projection of ConversationMessage, not a look-alike: the
 * producer maps `executor.conversationHistory.slice(startMsgIdx)` and copies
 * `m.type` and `m.toolResults` BY REFERENCE (actionLogs.ts:101-102). So the
 * element types are imported from './agent' rather than re-guessed here — the
 * three fields below are the same values ConversationMessage declares, and the
 * only differences are which keys survive the copy.
 */
export interface TaskExecutionMessage {
  role: ConversationRole;
  /** `m.content || ''` — never null, possibly empty. */
  content: string;
  /** Raw passthrough with no fallback: every current writer sets it, but an
   *  undefined value makes JSON drop the key. Contrast ConversationMessage.timestamp,
   *  which is required. */
  timestamp?: string;
  /** `if (m.type) entry.type = m.type` — conditionally copied, so the key is
   *  absent on a plain turn. HistoryDetailModal tests `=== 'tool-result'`. */
  type?: ConversationMessageType;
  /** `if (m.toolResults) entry.toolResults = m.toolResults` — the SAME array
   *  object ConversationMessage carries, so the element type is MessageToolResult.
   *  (The only consumer reads `tr.success !== false`, which this satisfies.) */
  toolResults?: MessageToolResult[];
}

/**
 * One append-only audit entry in task.history — a status move, a field edit, an
 * execution log, an error, a stop, a restore, or a board move.
 * Produced by ~15 sites; the canonical status-move shape is
 * api/src/services/agentManager/tasks.ts:194.
 *
 * This is a WIDE OPTIONAL BAG rather than a discriminated union, and deliberately
 * so: `type` is absent on plain status transitions, and the two 'board_move'
 * producers emit two mutually incompatible key sets (fromBoard/toBoard from the
 * HTTP path, oldBoardId/newBoardId from the MCP path).
 */
export interface TaskHistoryEntry {
  type?: TaskHistoryEntryType;
  /** ISO 8601; set by every producer. The timeline sorts on it. */
  at: string;
  /** Actor LABEL, not an id: 'user', a username, an agent NAME, 'workflow',
   *  'mcp' or 'recurrence'. */
  by: string;
  /** The status AFTER the change. Optional because the 'execution' producer
   *  omits it entirely. */
  status?: TaskStatus;
  /** Previous status. NULLABLE on the already-errored branch, where it is
   *  written as `task.errorFromStatus || null`. */
  from?: TaskStatus | null;
  /** Two meanings: the NEW assignee id on a 'reassign' entry, or literal null on
   *  a status move that unassigned. */
  assignee?: string | null;
  /** Only emitted alongside `assignee: null` when a status move dropped an
   *  assignee. */
  previousAssignee?: string;
  /** Single-field 'edit' entries (the agentManager / MCP paths). Seen values:
   *  'taskType', 'text', 'secondaryRepos', 'repoFullName', 'storagePath'. */
  field?: string;
  /** `task[field] || null` — key present with a null value on the single-field
   *  edit path. `unknown` because the value is whatever the edited field held
   *  (string, TaskSecondaryRepo[], …); the consumer already branches on
   *  `typeof === 'string'`. */
  oldValue?: unknown;
  /** `value ?? null` — same shape as oldValue. */
  newValue?: unknown;
  /** An array of field-NAME STRINGS (a copy of editedFields, declared
   *  `const editedFields: string[] = []`). BOTH frontend consumers currently
   *  treat the elements as objects with .field/.oldValue/.newValue — that is the
   *  bug this type exists to surface. */
  fields?: string[];
  /** Only set (to literal true) on POST /tasks/bulk-move. */
  bulk?: boolean;
  // 'board_move', HTTP producer (api/src/services/taskMutations.ts:208-211).
  fromBoard?: string | null;
  toBoard?: string | null;
  fromBoardName?: string | null;
  toBoardName?: string | null;
  // 'board_move', MCP producer (api/src/services/agentManager/tools/handlers.ts:351).
  // Same discriminant, incompatible key set. Neither pair is rendered today.
  oldBoardId?: string | null;
  newBoardId?: string;
  /** 'execution' entries only; defaults to 'decide'. Historical rows can carry
   *  the removed 'execute' mode, which is why MODE_LABELS still maps it — and an
   *  unvalidated one, which is why this is StoredAgentMode and not the closed
   *  union. Same value space as `actionMode` below. */
  mode?: StoredAgentMode;
  /** 'execution' entries only; used with `at` to compute the run duration. */
  startedAt?: string;
  /** 'execution' entries only. */
  success?: boolean;
  /** 'execution' entries only — a projection of the executor's
   *  conversationHistory slice. */
  messages?: TaskExecutionMessage[];
  /** 'error' entries only; `message || 'Unknown error'`, so never empty. */
  error?: string;
  /** 'error' entries only, and only when the caller supplied a mode. Fed by the
   *  same variable as `mode` above, so it carries the same type. */
  actionMode?: StoredAgentMode;
  /** 'error' entries only, conditionally added. */
  actionIndex?: number;
  /** 'error' entries only, conditionally added. */
  agentName?: string;
}

/**
 * The kanban task payload — produced by rowToTask
 * (api/src/services/database/tasks.ts:56) and consumed by the whole tasks board.
 *
 * This shape is the GET /tasks body and nothing else. A `task:updated` socket
 * frame is NOT one of these: use TaskSocketPayload (or TaskCreatedEvent) for
 * anything that arrives over the socket, and see the head of this file for why.
 */
export interface Task {
  id: string;
  /** Raw passthrough with NO fallback. NULL for board-level tasks created
   *  unassigned via MCP add_task. Both consumers (a React key and the agent
   *  filter) tolerate null. */
  agentId: string | null;
  /** `row.text || ''` — never null. */
  text: string;
  /** `|| undefined` → the key is DROPPED from the JSON when the column is NULL. */
  title?: string;
  status: TaskStatus;
  boardId: string | null;
  /** Derived read-only from the LEFT JOIN boards → projects. */
  projectId: string | null;
  /** The project NAME (p.name), not an id. */
  project: string | null;
  /** Open string; 'github' is the only value any writer defaults to. */
  repoProvider: string | null;
  /** Validated as /^[\w.-]+\/[\w.-]+$/ on write. */
  repoFullName: string | null;
  /** Computed, never stored — and it hardcodes https://github.com/ regardless of
   *  repoProvider. */
  repoHtmlUrl: string | null;
  /** `Array.isArray(...) ? ... : []` — always an array, never null. */
  secondaryRepos: TaskSecondaryRepo[];
  /** Open string; 'onedrive' is the only default written. */
  storageProvider: string | null;
  /** Trimmed and capped at 500 chars. */
  storagePath: string | null;
  /** Agent UUID of the executor. Cleared to null on most status moves. */
  assignee: string | null;
  taskType?: TaskType;
  priority?: TaskPriority;
  /** UNLIKE createdAt/updatedAt this is NOT converted with .toISOString():
   *  rowToTask passes the raw pg Date through, so an in-process consumer sees a
   *  Date while an HTTP client sees the ISO string JSON.stringify makes of it. */
  dueDate?: string;
  source: TaskSource | null;
  /** Disabling recurrence sets this to null; it does not set enabled:false. */
  recurrence: TaskRecurrence | null;
  /** `row.commits || []` — always an array. */
  commits: TaskCommit[];
  /** `row.history || []` — always an array. */
  history: TaskHistoryEntry[];
  /** Free-text message set by markTaskError. */
  error?: string;
  /** ISO 8601. The DDL has no NOT NULL, but the INSERT always writes NOW(). */
  createdAt: string;
  /** ISO 8601, and LOAD-BEARING: TasksBoard uses Date.parse(updatedAt) to decide
   *  whether a socket payload beats a loadTasks() response. */
  updatedAt: string;
  completedAt?: string;
  startedAt?: string;
  /** Every live-task getter filters `deleted_at IS NULL`, so on the normal paths
   *  this key is always absent; it is only really present on GET /tasks/deleted. */
  deletedAt?: string;
  /** User UUID, written by a separate UPDATE. */
  deletedBy?: string;
  executionStatus?: TaskExecutionStatus;
  /** Explicit `!= null` guard in the mapper, so 0 survives. */
  completedActionIdx?: number;
  /** Internal workflow marker (a column/status id) that leaks onto the public
   *  payload under a leading underscore. It genuinely reaches the browser on
   *  every GET /tasks; no consumer reads it. */
  _pendingOnEnter?: TaskStatus;
  /** `|| false`. Drives the busy spinner and the drag lock. */
  actionRunning: boolean;
  /** Several emit paths `delete` the key rather than nulling it, so ABSENCE is
   *  the real wire state. */
  actionRunningAgentId?: string;
  /** Legacy rows may still carry 'execute', a removed mode — and, since nothing
   *  validates the workflow action that wrote it, an unknown one. */
  actionRunningMode?: StoredAgentMode;
  /** The column the task was in before erroring — a workflow column id,
   *  validated against the board's columns. */
  errorFromStatus?: TaskStatus;
  /** `|| false`. */
  isManual: boolean;
  /** BIGINT NOT NULL DEFAULT 0. node-postgres returns BIGINT as a STRING, hence
   *  the mapper's `parseInt(row.position, 10) || 0` — so this really is a number
   *  on the wire. */
  position: number;
  /** NULLABLE despite the DDL: the CREATE TABLE says NOT NULL DEFAULT 'prod' but
   *  the idempotent migration for pre-existing databases is a plain
   *  `ADD COLUMN IF NOT EXISTS environment TEXT`, so legacy rows return null.
   *  Values are hostname-derived: 'prod' | 'dev' | any subdomain. */
  environment: string | null;
  /** ENRICHMENT, not part of rowToTask: present ONLY on the GET /tasks response,
   *  absent from every `task:updated` payload. */
  agentName?: string | null;
  /** ENRICHMENT via enrichAssignee — on GET /tasks and on emitTaskUpdated, but
   *  ABSENT from the `task:updated` emitted right after creation. */
  assigneeName?: string | null;
  /** Same enrichment path as assigneeName. */
  assigneeIcon?: string | null;
}

/**
 * What a `task:updated` socket frame actually carries. NOT a `Task`.
 *
 * Every key is optional AND nullable, except `id`. That is not vagueness — it is
 * the intersection of what the ten emit sites can produce, and it needs no
 * guessing about which key set each one sends:
 *
 *  - OPTIONAL, because the frame emitted right after creation is the hand-built
 *    in-memory `newTask` (api/src/services/agentManager/tasks.ts:172-222), which
 *    simply has no updatedAt / commits / title / project / projectId /
 *    repoHtmlUrl / assignee / actionRunning key at all.
 *  - NULLABLE, because the mutation paths emit the MUTATED task object, and they
 *    write explicit nulls where rowToTask writes `|| undefined`:
 *    clearExecutionOnMove sets `startedAt = null`, `executionStatus = null`
 *    (api/src/services/taskMutations.ts:98-99) and `completedActionIdx = null`
 *    (:104) — on the most frequent path there is, a drag between columns.
 *  - `id` is the one guarantee: every emitter spreads a task that has one, and
 *    the handler's first line is `if (!task?.id) return` (TasksBoard.tsx:278).
 *
 * Adopting it turns the two laundering sites in TasksBoard's socket handler into
 * type errors: `return [...prev, task]` (:284) inserts a frame into the Task[]
 * that GET /tasks fills, and `updated[idx] = { ...existing, ...task }` (:297)
 * spreads its explicit nulls over a real Task. Merge a frame onto a `Task`
 * deliberately — field by field, or behind a guard — before treating it as one.
 *
 * The two halves bite at different times. The optionality half is already a
 * TS2322 under today's flags, so `[...prev, frame]` fails as soon as the state is
 * typed. The nullability half needs `strictNullChecks`, the next flag on the
 * tsconfig.json ratchet — until it lands, the spread merge stays silent.
 */
export type TaskSocketPayload = { [K in keyof Task]?: Task[K] | null } & Pick<Task, 'id'>;

/**
 * The narrower frame emitted once, immediately after creation
 * (api/src/services/agentManager/tasks.ts:222). It is a plain partial rather than
 * a nullable one: `newTask` is built from scratch and never passes through the
 * mutators that write explicit nulls, so its missing fields are missing KEYS.
 *
 * Assignable to TaskSocketPayload, so a handler typed on that accepts both.
 */
export type TaskCreatedEvent = Partial<Task> & Pick<Task, 'id'>;
