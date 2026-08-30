// ── Project, its boards, and the task statistics keyed by project name ──────
//
// NAMING TRAP, worth stating once, and it is a THREE-way trap. App-level
// `projects` state is NOT the Project entity: App.tsx fills it from
// GET /api/projects/available-repos — git repos keyed by 'owner/repo' — while
// Dashboard passes the real DB projects (`dbProjects`) to ProjectDrawer. Nor is
// that state the wire shape: App.tsx:114-123 re-maps every item into a normalised
// client object before storing it. So this module names all three separately:
//   Project          the DB row
//   AvailableRepo    what the two available-repos endpoints send
//   RepoPickerOption what App.projects holds and every picker prop receives
// They must never be conflated.
//
// Project rows are returned RAW (snake_case, no mapper) while the counts and the
// stats payloads grafted next to them are camelCase. That inconsistency is on the
// wire, so it is in the types.

import type { Board, DerivedRepo, DerivedStorage } from './board';

/**
 * The DB-backed project row, returned bare by POST /api/projects and
 * PUT /api/projects/:id and spread into every other project payload.
 * Produced by api/src/services/database/projects.ts:17.
 */
export interface Project {
  id: string;
  /** TEXT UNIQUE NOT NULL. Writes are constrained to /^[a-zA-Z0-9_\- .]+$/,
   *  1..200 chars — a pattern, not a closed union. */
  name: string;
  /** NOT NULL DEFAULT '' — never null, but often the empty string. */
  description: string;
  /** NOT NULL DEFAULT '', max 10000 chars on write. */
  rules: string;
  /** snake_case on the wire (the row is returned raw). ON DELETE SET NULL, and
   *  createProject passes `req.user?.userId || null`, so null is a real value. */
  owner_id: string | null;
  /** pg returns a Date for TIMESTAMPTZ; res.json serializes it to ISO-8601, so
   *  `string` is the wire type. */
  created_at: string;
  updated_at: string;
}

/**
 * What GET /api/projects returns: the Project row enriched with three counts.
 * Produced by api/src/routes/projects.ts:124.
 *
 * The three counts are CALLER-RELATIVE (they only see boards the caller can
 * reach), are computed with three extra queries per project, and are read by no
 * frontend file today. They are absent from ProjectDetail — which is why these
 * are two types and not one.
 */
export interface ProjectListItem extends Project {
  boardCount: number;
  repoCount: number;
  storageCount: number;
}

/**
 * What GET /api/projects/:id returns: the Project row plus its visible boards,
 * derived repos and derived storages.
 * Produced by api/src/routes/projects.ts:150.
 *
 * NOTE the boards here come from getBoardsForProject, which does NOT select
 * share_permission / owner_username — so they are plain `Board`, not
 * `BoardListItem`. Reading b.share_permission off one of these always yields
 * undefined, i.e. "no share", indistinguishable from a real read-only share.
 */
export interface ProjectDetail extends Project {
  /** Always an array, possibly empty; caller-scoped. */
  boards: Board[];
  /** Derived from the distinct repo_full_name of the project's non-deleted
   *  tasks — never a stored per-project repo list. */
  repos: DerivedRepo[];
  /** Derived from the distinct storage_path of non-deleted tasks. */
  storages: DerivedStorage[];
}

/**
 * A repo picker option. Served by two endpoints with the SAME key set but very
 * different truthfulness:
 *  - GET /api/projects/available-repos (global, derived from tasks) hard-codes
 *    defaultBranch: '' and description: '';
 *  - GET /api/projects/boards/:boardId/available-repos (live GitHub API through
 *    the board's OAuth token) sends the real values and always the literal
 *    provider 'github'.
 * Produced by api/src/routes/projects.ts:266 and :320.
 *
 * There is NO `name` key on either endpoint, despite App.tsx:116/118 reading one.
 * That read is where RepoPickerOption's invented `name` comes from — see below.
 * This type is what the ENDPOINTS return; it is NOT what any component receives.
 */
export interface AvailableRepo {
  /** 'github' on the board-scoped route; passed through from the task column on
   *  the global one, so a plain string. */
  provider: string;
  /** GitHub's full_name, 'owner/repo'. */
  fullName: string;
  htmlUrl: string;
  /** ALWAYS '' on the global route. */
  defaultBranch: string;
  /** ALWAYS '' on the global route. */
  description: string;
}

/**
 * UI-LOCAL. What `App.projects` actually holds — and what AgentDetail,
 * AddAgentModal and BroadcastPanel receive as their `projects` prop
 * (App.tsx:412, Dashboard.tsx:655 and :679). It is NOT an AvailableRepo:
 * loadProjects re-maps every item of GET /api/projects/available-repos into this
 * normalised client shape and stores THAT (App.tsx:114-123), then dedupes on
 * `name` (:126-131).
 *
 * Two of the four differences matter:
 *  - `name` and `repoName` are INVENTED CLIENT-SIDE; no endpoint sends either.
 *  - `description`, `htmlUrl` and `defaultBranch` are `|| ''`-coalesced here, so
 *    unlike on AvailableRepo they can never be undefined.
 */
export interface RepoPickerOption {
  /** `r.fullName || r.name`. THE PERSISTED VALUE: it is the `<option value>` of
   *  the repository picker (AddAgentModal.tsx:310-314) and is what gets stored as
   *  `Agent.project`. Also the dedupe key (App.tsx:127-129).
   *
   *  The `|| r.name` half is already dead: AvailableRepo has no `name` key on
   *  either producing endpoint. */
  name: string;
  /** Canonical 'owner/repo', straight from AvailableRepo.fullName. Rendered as the
   *  option label via `p.fullName || p.name`. */
  fullName: string;
  /** UNDEFINED-CAPABLE for two reasons, neither of which is an empty split:
   *  the producer is a ternary, `r.fullName ? r.fullName.split('/').pop() : r.name`
   *  (App.tsx:118), and `Array.prototype.pop()` is typed `T | undefined` however
   *  full the array is — while the else branch reads `r.name`, a key no
   *  available-repos item carries. Computed on every load and read by NOBODY: no
   *  file under frontend/src references it. */
  repoName: string | undefined;
  /** Passed through from AvailableRepo.provider. */
  provider: string;
  /** `r.description || ''` — never undefined here. */
  description: string;
  /** `r.htmlUrl || ''`. */
  htmlUrl: string;
  /** `r.defaultBranch || ''`, and the global available-repos route hard-codes ''
   *  anyway. */
  defaultBranch: string;
}

/**
 * A storage picker option from GET /api/projects/boards/:boardId/available-storages
 * — the connected OneDrive's top-level folders plus a synthetic root entry.
 * Produced by api/src/routes/projects.ts:384.
 */
export interface AvailableStorage {
  /** Genuinely closed: both the folder mapper and the synthetic root write the
   *  literal. Google Drive is deliberately not wired into this route yet. */
  provider: 'onedrive';
  /** '/<folderName>' for folders, exactly '/' for the drive root. */
  path: string;
  /** The Graph item name, or the literal 'Drive root' for the synthetic entry. */
  displayName: string;
  /** `i.webUrl || null`, and always null on the synthetic root entry. */
  webUrl: string | null;
}

/**
 * The {avg, median, count} triple used for every duration aggregate in the
 * project stats payload. All three are 0 (never null) for an empty sample.
 * Produced by api/src/services/agentManager/taskStats.ts:97.
 */
export interface DurationStats {
  /** Milliseconds, Math.round'ed. */
  avg: number;
  /** Milliseconds. */
  median: number;
  /** Sample size (transitions, or resolved tasks). */
  count: number;
}

/**
 * GET /api/agents/tasks/stats?project=<project NAME> — the aggregate behind
 * ProjectStats' summary cards.
 * Produced by api/src/services/agentManager/taskStats.ts:113.
 *
 * CAVEAT the numbers themselves carry: _collectTasks skips every task with a null
 * agentId and every agent outside the manager map, so BOARD-LEVEL tasks (created
 * unassigned via MCP add_task) are silently excluded from all of it. The card
 * labelled 'Total' is not the project's task count.
 */
export interface ProjectTaskStats {
  total: number;
  /** Keys are `task.taskType` or the literal 'untyped'. NOT a closed union —
   *  taskType is a free 50-char string on write. */
  byType: Record<string, number>;
  /** Keys are workflow column ids, an open set defined per board. */
  byStatus: Record<string, number>;
  resolution: DurationStats;
  /** Only types that actually resolved appear as keys. */
  resolutionByType: Record<string, DurationStats>;
  /** Keys are the statuses seen in history; possibly {}. */
  avgStateDurations: Record<string, DurationStats>;
}

/** One day of the created-vs-resolved bar chart. Zero-filled, never sparse. */
export interface CreatedVsResolvedPoint {
  /** 'YYYY-MM-DD' (UTC slice) — a real date-only string here. */
  date: string;
  created: number;
  resolved: number;
}

/** One day of the resolution-time evolution line. */
export interface ResolutionTimePoint {
  /** 'YYYY-MM-DD'. */
  date: string;
  /** Milliseconds; the chart converts to hours. */
  avgMs: number;
  /** Always > 0 given the producer's filter. */
  count: number;
}

/** One day of the open-tickets cumulative line. */
export interface OpenOverTimePoint {
  /** 'YYYY-MM-DD', copied from the createdVsResolved day. */
  date: string;
  /** Math.max(0, cumulative) — never negative. */
  open: number;
}

/**
 * GET /api/agents/tasks/stats/timeseries?project=<name>&days=N.
 * Produced by api/src/services/agentManager/taskStats.ts:201. `days` is clamped
 * to 1..365 by the route.
 */
export interface ProjectTimeSeries {
  /** One entry per day over the whole window, zero-filled. */
  createdVsResolved: CreatedVsResolvedPoint[];
  /** SPARSE by design: days with no resolution are filtered out, so this array is
   *  shorter than createdVsResolved and can be empty. */
  resolutionTimeEvolution: ResolutionTimePoint[];
  /** Same length as createdVsResolved. */
  openOverTime: OpenOverTimePoint[];
}

/** One agent legend entry of the agent-time chart. */
export interface AgentTimeAgent {
  /** Agent UUID, also the key into AgentTimeDay.agentTimes. Sourced from
   *  `t.assignee || t.agentId`, so it may be an id the manager does not know. */
  id: string;
  /** Falls back to `id.slice(0, 8)` for an agent the manager no longer knows —
   *  never null, but possibly a truncated UUID rather than a real name. */
  name: string;
}

/** One day of per-agent active milliseconds. */
export interface AgentTimeDay {
  /** Real 'YYYY-MM-DD' string (unlike BudgetDailyPoint.day, which is a full ISO
   *  timestamp), so `.slice(5)` correctly yields 'MM-DD'. */
  date: string;
  /** Keyed by AgentTimeAgent.id and explicitly zero-filled for every listed
   *  agent, so a missing key is unreachable. Values are milliseconds. */
  agentTimes: Record<string, number>;
}

/**
 * GET /api/agents/tasks/stats/agent-time?project=<name>&days=N — per-agent active
 * time, rendered by AgentTimeChart.
 * Produced by api/src/services/agentManager/taskStats.ts:319.
 *
 * This is a TASK-STATISTICS payload, not a budget one: it sums ACTIVE_STATES
 * durations from task history and never reads token_usage_log.
 */
export interface AgentTimeSeries {
  /** Only agents that actually accumulated time; can legitimately be empty. */
  agents: AgentTimeAgent[];
  /** One entry per day of the window, zero-filled. */
  daily: AgentTimeDay[];
  totalMs: number;
  /** Averaged over days WITH data only; 0 when there are none — never NaN. */
  avgDailyMs: number;
}

/** One day of created/completed counts inside ProjectTaskSummary.daily. */
export interface ProjectDailyPoint {
  /** Normalized to 'YYYY-MM-DD' by hand, because pg may hand back a Date or a
   *  string for `day::date`. */
  date: string;
  created: number;
  /** Note the naming break with ProjectTimeSeries, which calls the same idea
   *  `resolved`. */
  completed: number;
}

/**
 * One project's task rollup from GET /api/tasks/project-stats.
 * Produced by api/src/routes/tasks.ts:818.
 * Note this route names the id/name fields in camelCase, unlike the snake_case
 * Project row.
 */
export interface ProjectTaskSummary {
  id: string;
  name: string;
  /** ::int-cast, so a JSON number rather than pg's bigint-as-string. */
  total: number;
  /** status = 'done'. */
  done: number;
  /** status NOT IN ('done','error','backlog'). */
  active: number;
  /** status IN ('error','backlog'). */
  waiting: number;
  bugs: number;
  features: number;
  /** Integer percentage 0..100, computed server-side; 0 when total is 0. */
  completion: number;
  /** SPARSE: only days where created > 0 OR completed > 0 survive. `days` is
   *  clamped to 1..90 here, unlike the 1..365 of the agent-scoped stats routes. */
  daily: ProjectDailyPoint[];
}

/**
 * GET /api/tasks/project-stats?days=N. Exposed by api.ts but rendered by no
 * component today. Produced by api/src/routes/tasks.ts:831.
 */
export interface ProjectStatsResponse {
  projects: ProjectTaskSummary[];
}

/**
 * The acknowledgement body of the project mutations that return no entity:
 * DELETE /api/projects/:id and the board link/unlink routes.
 * Produced by api/src/routes/projects.ts:195.
 * Genuinely closed to the literal true — failures return a 4xx `{ error }`.
 */
export interface ProjectMutationAck {
  success: true;
}
