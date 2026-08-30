// ── Board, sharing, workflow ────────────────────────────────────────────────
//
// Boards are the one entity the API returns as RAW SQL ROWS: there is no
// rowToBoard mapper, so every field below is snake_case and every TIMESTAMPTZ
// arrives as the ISO string res.json() makes of the Date node-postgres returns.
//
// Three endpoints return three DIFFERENT board shapes and they are not
// interchangeable — see Board / BoardListItem / AdminBoardListItem.
//
// This file also owns the workflow vocabulary (triggers, agent modes, actions)
// AND the task-status vocabulary (ReservedTaskStatus / TaskStatus), because the
// board's `workflow` JSONB is what defines a task's status values and what the
// automation engine executes. task.ts and agent.ts import from here.
//
// On the OPEN-VALUE-SPACE rule this file applies, see the header of index.ts.
// The whole workflow vocabulary below is rule 1 (closed union) even though
// `transitions` is stored through `z.array(z.any()).max(200)`
// (api/src/schemas/boards.ts:16): the engine is the only consumer and it
// normalises or ignores every off-set value — an unknown trigger never fires
// (taskStateMachine.ts:17), an unknown condition field evaluates to no-match
// (:85-110), any operator that is not 'neq' is treated as 'eq' (:112), and an
// absent/unknown mode defaults to 'decide'.

/**
 * Share permission, ranked read:0 < edit:1 < admin:2 (api/src/middleware/authz.ts:16).
 * The single closed set behind Board.share_permission, BoardShare.permission and
 * BoardWithAccess._permission — z.enum(['read','edit','admin']) at
 * api/src/schemas/boards.ts:3, enforced on both create and update, so no other
 * value can ever reach the column.
 */
export type BoardPermission = 'read' | 'edit' | 'admin';

/**
 * Modes a `run_agent` workflow action can be AUTHORED with today — the frozen
 * AgentMode enum at api/src/services/workflow/taskStateMachine.ts:31-36.
 */
export type AgentMode = 'refine' | 'decide' | 'title' | 'set_type';

/**
 * What can actually be READ off the wire. 'execute' was removed as an authorable
 * mode but is still persisted on legacy boards and legacy task rows:
 * mapLegacyExecuteMode (api/src/services/configManager.ts:149-167) rewrites it to
 * 'decide' only inside getWorkflowForBoard, i.e. for the engine — GET /boards
 * returns board.workflow raw. Dropping 'execute' from the union would make
 * taskConstants.ts:390-392 and TasksBoard.tsx:162 unreachable-by-type while they
 * are load-bearing at runtime.
 */
export type PersistedAgentMode = AgentMode | 'execute';

/**
 * A mode as it comes BACK off a task row, rather than as it is authored.
 *
 * Rule 2 (see index.ts): nothing validates the write. `action.mode` is a
 * client-authored workflow field, and the engine only replaces it when falsy —
 * `const mode = action.mode || AgentMode.DECIDE`
 * (api/src/services/workflow/actionExecutor.ts:665) — then persists it verbatim
 * (`actualTask.actionRunningMode = mode`, :441 and :478). An unknown mode
 * survives the round trip, which is why the frontend keeps a lookup map with a
 * fallback rather than a switch. Authoring sites keep the closed
 * `PersistedAgentMode`; anything read back off a stored row uses this.
 */
export type StoredAgentMode = PersistedAgentMode | (string & {});

/**
 * Trigger of a workflow transition — the frozen Trigger enum at
 * api/src/services/workflow/taskStateMachine.ts:17.
 */
export type WorkflowTrigger = 'on_enter' | 'condition';

/**
 * Fields a workflow condition can test (the evaluateCondition switch at
 * api/src/services/workflow/taskStateMachine.ts:85-110, plus
 * 'idle_agent_available' handled one level up at :128).
 *
 * Only the first five are authorable in the editor; creator_* / owner_* are
 * legacy aliases of assignee_status / assignee_enabled that the engine still
 * evaluates, so stored boards can carry them.
 */
export type WorkflowConditionField =
  | 'assignee_status'
  | 'assignee_enabled'
  | 'assignee_role'
  | 'task_has_assignee'
  | 'idle_agent_available'
  | 'creator_status'
  | 'creator_enabled'
  | 'owner_status'
  | 'owner_enabled';

/**
 * Anything that is not 'neq' is evaluated as 'eq'
 * (api/src/services/workflow/taskStateMachine.ts:112).
 */
export type WorkflowConditionOperator = 'eq' | 'neq';

/**
 * The three reserved, built-in statuses
 * (api/src/services/workflow/taskStateMachine.ts:14).
 */
export type ReservedTaskStatus = 'backlog' | 'done' | 'error';

/**
 * A task's status, and every field that carries one. Rule 2 (see index.ts): the
 * value is NOT a closed set — any non-reserved value is a board workflow column
 * id chosen by the user (boardDefaults.ts seeds 'todo'/'in_progress'/'done'),
 * and PUT /tasks/:id accepts any `column` string <= 100 chars
 * (api/src/schemas/tasks.ts:14). The `(string & {})` tail keeps autocompletion on
 * the reserved three while still accepting any column id — consumers only ever
 * compare against 'error' anyway (TaskCard.tsx:34, TasksBoard.tsx:437).
 *
 * This type lives HERE, next to BoardWorkflowColumn, because a board's columns
 * are what define the value space. `BoardWorkflowColumn.id` itself stays a plain
 * `string`: it is the DEFINITION of a status, not a reference to one.
 */
export type TaskStatus = ReservedTaskStatus | (string & {});

/**
 * One kanban column. Its `id` IS the value stored in tasks.status, which is why
 * renaming a column migrates the board's tasks server-side.
 * Produced by api/src/services/workflow/columnIds.ts:161.
 */
export interface BoardWorkflowColumn {
  /** Non-empty slug, deduped, max 100 chars. Also the task status value. */
  id: string;
  label: string;
  /** Hex string. The UI only styles the 7 values of AVAILABLE_COLORS and falls
   *  back to the gray entry for anything else. */
  color?: string;
  // The four display flags below are NOT part of the declared API contract: they
  // survive only because workflowColumnSchema is `.passthrough()`
  // (api/src/schemas/boards.ts:11). Written by WorkflowEditor, read by
  // taskConstants.ts:106-109.
  showAgent?: boolean;
  showCreator?: boolean;
  showProject?: boolean;
  showTaskType?: boolean;
}

/**
 * One guard on a 'condition'-triggered transition, evaluated periodically
 * against the task and the agent pool.
 * Produced by api/src/services/workflow/taskStateMachine.ts:81.
 */
export interface WorkflowCondition {
  field: WorkflowConditionField;
  operator?: WorkflowConditionOperator;
  /** Always compared as a string, including booleans ('true'/'false') and agent
   *  status ('idle'|'busy'|'error'|'none'). Read as `cond.value || ''`. */
  value?: string;
}

/**
 * Workflow action: assign the task to any available agent holding a given role.
 * Produced by api/src/services/workflow/actionExecutor.ts:280.
 */
export interface WorkflowActionAssignAgent {
  type: 'assign_agent';
  /** createAction seeds ''. The sentinel AUTO_ROLE ('__auto__', already exported
   *  by components/tasks/workflowRoles.ts) defers the choice to the Role Router
   *  LLM at run time. */
  role?: string;
}

/**
 * Workflow action: assign the task to one specific agent by id.
 * Produced by api/src/services/workflow/actionExecutor.ts:327.
 */
export interface WorkflowActionAssignAgentIndividual {
  type: 'assign_agent_individual';
  /** Absent or empty means unassign. */
  agentId?: string;
}

/**
 * Workflow action: run an agent on the task in one of the LLM modes — the
 * "Instructions (agent)" action the board columns are built around.
 * Produced by api/src/services/workflow/actionExecutor.ts:665.
 */
export interface WorkflowActionRunAgent {
  type: 'run_agent';
  /** Absent defaults to 'decide' server-side. Legacy boards still carry
   *  'execute' — see PersistedAgentMode. */
  mode?: PersistedAgentMode;
  role?: string;
  /** Omitted entirely by createAction for the 'title' and 'set_type' modes. */
  instructions?: string;
}

/**
 * Workflow action: move the task to another column.
 * Produced by api/src/services/workflow/actionExecutor.ts:361.
 */
export interface WorkflowActionChangeStatus {
  type: 'change_status';
  /** A BoardWorkflowColumn['id'], or the sentinel '__next__' meaning "the column
   *  right after the current one". Not a closed set — column ids are
   *  user-defined. */
  target?: string;
}

/**
 * Discriminated union on `type`. A transition whose `actions` is not an array is
 * filtered out on load by both the server (taskStateMachine.ts:69) and the
 * editor (taskConstants.ts:396).
 */
export type WorkflowAction =
  | WorkflowActionAssignAgent
  | WorkflowActionAssignAgentIndividual
  | WorkflowActionRunAgent
  | WorkflowActionChangeStatus;

/**
 * One automation rule attached to a column: when `trigger` fires on column
 * `from` and all `conditions` hold, run `actions` in order.
 * Produced by api/src/services/boardDefaults.ts:10.
 */
export interface WorkflowTransition {
  /** A BoardWorkflowColumn['id'], i.e. a task status; rewritten on column rename. */
  from: TaskStatus;
  trigger: WorkflowTrigger;
  /** OPTIONAL on the wire: the defaults write [], but neither validator requires
   *  it and the engine reads `(t.conditions || [])`. The three WorkflowEditor
   *  mutators that spread it unguarded are a latent TypeError. */
  conditions?: WorkflowCondition[];
  actions: WorkflowAction[];
}

/**
 * The boards.workflow JSONB blob that drives the kanban columns and the
 * automation engine — what WorkflowEditor edits and PUT /boards/:id/workflow
 * writes. Produced by api/src/routes/boards.ts:203.
 *
 * Every key is optional because the COLUMN default is '{}'
 * (api/src/services/database/baseSchema.ts:46): a raw row can legitimately carry
 * an empty object even though every write path supplies columns.
 */
export interface BoardWorkflow {
  columns?: BoardWorkflowColumn[];
  /** Genuinely optional: normalizeWorkflowColumnIds only re-emits the key when
   *  the incoming workflow already had an array (columnIds.ts:171), so a
   *  workflow saved without transitions stays without them — and a column
   *  reorder can produce exactly that state. */
  transitions?: WorkflowTransition[];
  /** Maintained ONLY by PUT /boards/:id/workflow, which recomputes it and
   *  ignores whatever the client sent. A workflow written through PUT /boards/:id
   *  never gets one. There is no optimistic-concurrency check anywhere. */
  version?: number;
}

/**
 * One entry of a board's mcp_auth map: the credential a board supplies for an MCP
 * server, merged UNDER the agent's own auth at run time
 * (api/src/services/agentManager/chat.ts:635).
 *
 * The board-side zod schema is only z.record(z.string(), z.any())
 * (api/src/schemas/boards.ts:52), so this shape is inferred from the strict
 * agent-side parallel (api/src/schemas/agents.ts:23-25). Treat the value as
 * possibly carrying extra keys.
 */
export interface BoardMcpAuthEntry {
  apiKey?: string;
}

/**
 * The raw boards row as it goes on the wire — returned by POST /boards,
 * PUT /boards/:id and PUT /boards/:id/workflow, and the base of every board list
 * shape. Produced by api/src/services/database/boards.ts:144.
 *
 * FOR THE API-CLIENT PASS: this interface is the 200 body, but the two PUT
 * handlers are not total. `updateBoard` ends in `return result.rows[0] || null`
 * (boards.ts:185) and short-circuits to `getBoardById(id)` — also nullable — when
 * the patch reduces to zero SET clauses (boards.ts:174); both handlers then
 * `res.json(updated)` with no guard (api/src/routes/boards.ts:190 and :207). The
 * board is known to exist at that point (authorizeBoardAccess ran first), so the
 * null is reachable only through a delete racing the UPDATE — but it IS
 * reachable. The fix belongs in the api.ts signature (`Promise<Board | null>`),
 * NOT here: the shape below is correct for every non-null body.
 *
 * NOTE what is NOT here: share_permission and owner_username. Those exist only on
 * the GET /boards UNION (see BoardListItem), which is why replacing a board in
 * React state with a rename / workflow-save response silently downgrades a shared
 * board to "owned".
 */
export interface Board {
  id: string;
  /** NOT NULL was explicitly dropped (api/src/services/database/migrations.ts:61)
   *  — orphan boards are a supported state. */
  user_id: string | null;
  name: string;
  workflow: BoardWorkflow;
  /** JSONB NOT NULL DEFAULT '{}'. Only ever written as {} and read by no frontend
   *  file, so no key set can be inferred — Record<string, unknown> is the honest
   *  type here, never `any`. */
  filters: Record<string, unknown>;
  position: number;
  /** Legacy: every row with is_default = TRUE is deleted at boot by
   *  removeLegacyDefaultBoards. Always false in practice. */
  is_default: boolean;
  /** Plugin IDS, not plugin objects (z.array(z.string()) at schemas/boards.ts:34). */
  plugins: string[];
  /** snake_case HERE. GET /boards/:id/plugins renames it to camelCase — see
   *  BoardPluginsResponse.mcpAuth. The two names must stay distinct. */
  mcp_auth: Record<string, BoardMcpAuthEntry>;
  project_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * What GET /boards actually returns: a Board plus the two sharing columns the
 * UNION adds. Produced by api/src/services/database/boards.ts:94.
 *
 * Both keys are always PRESENT here (the owned half of the UNION selects them as
 * an explicit NULL), so `share_permission === null` means "you own it".
 */
export interface BoardListItem extends Board {
  share_permission: BoardPermission | null;
  owner_username: string | null;
}

/**
 * What GET /boards/all (admin only) returns: a Board plus the owner's username /
 * display_name — and NOT the sharing columns.
 * Produced by api/src/services/database/boards.ts:75.
 */
export interface AdminBoardListItem extends Board {
  /** null for a board whose user_id is null (LEFT JOIN users). */
  username: string | null;
  display_name: string | null;
}

/**
 * What GET /boards/:id returns: the board row spread with the caller's effective
 * permission. Produced by api/src/routes/boards.ts:145.
 * No frontend api.ts wrapper calls this endpoint today.
 */
export interface BoardWithAccess extends Board {
  /** 'admin' for the owner and for system admins, otherwise the share row's
   *  permission (api/src/middleware/authz.ts:44-58). */
  _permission: BoardPermission;
  _isOwner: boolean;
}

/**
 * One membership row from GET /boards/:id/shares — the share joined to the target
 * user and to whoever granted it.
 * Produced by api/src/services/database/boardSharing.ts:9.
 */
export interface BoardShare {
  id: string;
  board_id: string;
  user_id: string;
  permission: BoardPermission;
  /** ON DELETE SET NULL — null once the granting user is deleted. */
  shared_by: string | null;
  created_at: string;
  /** Inner JOIN on users, and users.username is NOT NULL — always present. */
  username: string;
  display_name: string | null;
  /** null when shared_by is null (LEFT JOIN). */
  shared_by_username: string | null;
}

/**
 * What POST /boards/:id/shares (201) and PUT /boards/:id/shares/:userId return:
 * the BARE board_shares row, with none of the joined user columns.
 * Produced by api/src/services/database/boardSharing.ts:49.
 *
 * Deliberately NOT a BoardShare: the RETURNING clause has no user join, which is
 * exactly why ShareBoardModal throws the POST body away and refetches the list.
 */
export interface BoardShareMutationResult {
  id: string;
  board_id: string;
  user_id: string;
  permission: BoardPermission;
  shared_by: string | null;
  created_at: string;
}

/**
 * Actions recorded in the board sharing audit trail — the closed set of the five
 * call sites in api/src/routes/boards.ts (161, 302, 360, 385, 418).
 */
export type BoardAuditAction =
  'create' | 'delete' | 'share' | 'update_permission' | 'leave' | 'revoke';

/**
 * One row of GET /boards/:id/audit (SELECT *, no mapper).
 * Produced by api/src/services/database/boardSharing.ts:147.
 */
export interface BoardAuditLog {
  /** SERIAL PRIMARY KEY — a NUMBER here, unlike every other id in this file. */
  id: number;
  /** No FK and no NOT NULL: deliberately kept after the board is deleted. */
  board_id: string | null;
  action: BoardAuditAction;
  actor_id: string | null;
  actor_username: string | null;
  target_user_id: string | null;
  /** Only the 'share' action resolves it; null for every other action. */
  target_username: string | null;
  /** In practice { name } for create/delete and { permission } for
   *  share/update_permission — free JSON, hence Record<string, unknown>. */
  details: Record<string, unknown> | null;
  created_at: string;
}

/**
 * What GET /boards/:id/plugins returns — the only board endpoint that renames a
 * column on the way out. Produced by api/src/routes/boards.ts:226.
 */
export interface BoardPluginsResponse {
  /** Plugin ids only; cross-referenced against the GET /plugins catalog. */
  plugins: string[];
  /** camelCase HERE ONLY — every board row payload spells it mcp_auth. */
  mcpAuth: Record<string, BoardMcpAuthEntry>;
}

/**
 * The distinct repos actually IN USE on a board — derived from its non-deleted
 * tasks, never a stored list. Served by GET /projects/boards/:boardId/repos and
 * embedded in ProjectDetail.repos.
 * Produced by api/src/services/database/boardRepos.ts:17.
 *
 * NOT the same shape as AvailableRepo (the picker): no defaultBranch, no
 * description.
 */
export interface DerivedRepo {
  /** `row.repo_provider || 'github'`. The column is a free 50-char string on
   *  write, so this cannot honestly be closed to a literal union. */
  provider: string;
  /** 'owner/repo'. The query filters repo_full_name IS NOT NULL. */
  fullName: string;
  /** Synthesized, not stored: https://github.com/<fullName> for provider
   *  'github', otherwise the EMPTY STRING — never null. */
  htmlUrl: string;
}

/**
 * The distinct storage roots actually in use on a board, derived from tasks.
 * Produced by api/src/services/database/boardStorages.ts:14.
 * NOT the same shape as AvailableStorage: no displayName, no webUrl.
 */
export interface DerivedStorage {
  /** `row.storage_provider || 'onedrive'`; free string on write. */
  provider: string;
  path: string;
}
