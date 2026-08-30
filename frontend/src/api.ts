import type {
  AdminBoardListItem,
  Agent,
  AgentCredentialsUpdate,
  AgentMcpAuthUpdate,
  AgentRagDocument,
  AgentTemplate,
  AgentTimeSeries,
  ApiKeyCreated,
  ApiKeyInfoResponse,
  AvailableRepo,
  AvailableStorage,
  Board,
  BoardListItem,
  BoardPermission,
  BoardPluginsResponse,
  BoardShare,
  BoardShareMutationResult,
  BoardWorkflow,
  BudgetAlertsResponse,
  BudgetByAgentRow,
  BudgetConfig,
  BudgetConfigUpdateResponse,
  BudgetDailyPoint,
  BudgetSummaryResponse,
  BudgetTimelineGroupBy,
  BudgetTimelinePoint,
  CodeGraphDirection,
  CodeGraphResponse,
  CodeIndexProjectResponse,
  CommitDiff,
  ConversationMessage,
  GitHubActivityResponse,
  GitHubBranch,
  GitHubFileContent,
  GitHubTreeResponse,
  ImpersonateResponse,
  LlmConfig,
  LlmConfigDraft,
  McpServer,
  McpTestResult,
  OAuthAuthUrlResponse,
  OAuthProviderStatus,
  Plugin,
  PluginDraft,
  PluginMcpDraft,
  Project,
  ProjectDetail,
  ProjectListItem,
  ProjectMutationAck,
  ProjectStatsResponse,
  ProjectTaskStats,
  ProjectTimeSeries,
  ReminderConfig,
  SessionPayload,
  Settings,
  StoredAgentMode,
  Task,
  TaskCreatedEvent,
  TaskExecutionStatus,
  TaskPriority,
  TaskRecurrencePeriod,
  TaskStatus,
  TaskType,
  TermsAcceptedResponse,
  TutorialCompletedResponse,
  User,
  UserDirectoryEntry,
  UserMutationResult,
  UserRole,
  VerifyResponse,
} from './types';

const API_BASE = '/api';

const DEFAULT_TIMEOUT_MS = 30000;
// LLM/Docker-bound operations legitimately run for minutes — only guard
// against requests that hang forever.
const LONG_TIMEOUT_MS = 600000;

/* ── Shapes this module owns ──────────────────────────────────────────────────
 *
 * Everything below is a wire shape that has no home in `./types` because it is
 * either a REQUEST body (the types module describes what the API produces) or a
 * response the module deliberately does not model. They live here, next to the
 * single call site that uses them, and are exported so consumers can name them.
 */

/**
 * A task as returned by the MUTATION routes, which is NOT the same thing as a
 * `Task`.
 *
 * `Task` describes the GET /tasks body, where rowToTask coalesces missing values
 * to `undefined`. The mutation routes instead `res.json()` the MUTATED in-memory
 * object, and the mutators write EXPLICIT `null` into exactly these eight fields:
 * clearExecutionOnMove sets startedAt / executionStatus / completedActionIdx
 * (api/src/services/taskMutations.ts:98-104) and setTaskStatus additionally sets
 * completedAt / actionRunningAgentId / actionRunningMode / errorFromStatus /
 * error (api/src/services/agentManager/tasks.ts:283-308, :1006-1015).
 *
 * Every other key keeps its `Task` type: the object still comes out of rowToTask.
 * Under today's flags `string | null` collapses to `string`, so this is free; it
 * only starts speaking once `strictNullChecks` lands, which is the point.
 */
export type MutatedTask = Omit<
  Task,
  | 'startedAt'
  | 'completedAt'
  | 'executionStatus'
  | 'completedActionIdx'
  | 'actionRunningAgentId'
  | 'actionRunningMode'
  | 'errorFromStatus'
  | 'error'
> & {
  startedAt?: string | null;
  completedAt?: string | null;
  executionStatus?: TaskExecutionStatus | null;
  completedActionIdx?: number | null;
  actionRunningAgentId?: string | null;
  actionRunningMode?: StoredAgentMode | null;
  errorFromStatus?: TaskStatus | null;
  error?: string | null;
};

/**
 * A secondary repo as CLIENTS SEND it. NOT a `TaskSecondaryRepo`: the write
 * schema makes `provider` optional (api/src/schemas/tasks.ts:32) and
 * normalizeSecondaryRepos defaults it to 'github', so the response shape always
 * has one while the request shape need not.
 */
export interface TaskSecondaryRepoInput {
  provider?: string;
  fullName: string;
}

/**
 * The `recurrence` sub-object as CLIENTS SEND it. NOT a `TaskRecurrence`:
 * `originalStatus` and `lastResetAt` are stamped server-side
 * (api/src/services/agentManager/tasks.ts:196-210), and `enabled` is the only key
 * the server reads before rebuilding the rest — `{ enabled: false }` is how the
 * UI turns recurrence off.
 */
export interface TaskRecurrenceInput {
  enabled: boolean;
  period?: TaskRecurrencePeriod;
  intervalMinutes?: number;
  /** null / 0 both mean "keep everything". */
  historyRetentionDays?: number | null;
}

/**
 * Body of PUT /api/tasks/:id — the board-level task update
 * (api/src/schemas/tasks.ts:11-42). NOT a `Partial<Task>`: the destination column
 * is called `column` here (not `status`), the schema carries a `description` and a
 * `type` that rowToTask never emits, and every string field is
 * `.optional().nullable()`, so `null` is an accepted way to clear one.
 */
export interface TaskUpdateInput {
  title?: string | null;
  description?: string | null;
  /** The destination column id — `status` on the response side. */
  column?: TaskStatus | null;
  boardId?: string | null;
  agentId?: string | null;
  /** Legacy alias of taskType, still accepted by the schema. */
  type?: TaskType | null;
  taskType?: TaskType | null;
  priority?: TaskPriority | null;
  dueDate?: string | null;
  position?: number;
  isManual?: boolean;
  recurrence?: TaskRecurrenceInput | null;
  repoFullName?: string | null;
  repoProvider?: string | null;
  /** The schema accepts a bare 'owner/repo' string as well as the object form. */
  secondaryRepos?: Array<string | TaskSecondaryRepoInput>;
  storagePath?: string | null;
  storageProvider?: string | null;
}

/**
 * Body of PATCH /api/agents/:agentId/tasks/:taskId — the agent-scoped updater
 * (api/src/routes/agents.ts:476-490). A different, smaller key set than
 * TaskUpdateInput: the column is `status` here, and `source` is rejected outright
 * with a 400 rather than ignored.
 */
export interface AgentTaskPatchInput {
  status?: TaskStatus;
  text?: string;
  title?: string;
  repoFullName?: string | null;
  repoProvider?: string | null;
  secondaryRepos?: TaskSecondaryRepoInput[];
  storageProvider?: string | null;
  storagePath?: string | null;
  recurrence?: TaskRecurrenceInput | null;
  taskType?: TaskType;
  isManual?: boolean;
}

/**
 * Body of POST /api/agents and PUT /api/agents/:id.
 *
 * ASYMMETRIC with `Agent` on exactly two fields, which is why it cannot be a bare
 * `Partial<Agent>`: `mcpAuth` and `credentials` are read back as redacted presence
 * markers (AgentMcpAuthRef / AgentCredentialRef) but are WRITTEN as plaintext
 * (AgentMcpAuthUpdate / AgentCredentialsUpdate, where '' deletes an entry).
 * `batchSize` is create-only and never comes back on a read.
 */
export type AgentWriteInput = Partial<Omit<Agent, 'mcpAuth' | 'credentials'>> & {
  mcpAuth?: AgentMcpAuthUpdate;
  credentials?: AgentCredentialsUpdate;
  /** POST /agents only: > 1 switches the response to the batch envelope. */
  batchSize?: number;
};

/** POST /api/agents with `batchSize > 1`, and every POST /api/agents/:id/batch. */
export interface AgentBatchCreated {
  batch: true;
  agents: Agent[];
}

/**
 * The two-armed 201 body of POST /api/agents (api/src/routes/agents.ts:141-144).
 * `batch` and `agents` are declared as absent-typed keys on the single-agent arm
 * so callers can read the discriminant — the created agent genuinely has neither
 * key, so `batch?: undefined` states a fact rather than widening one.
 */
export type AgentCreated = (Agent & { batch?: undefined; agents?: undefined }) | AgentBatchCreated;

/** Body of POST /api/users (api/src/schemas/users.ts:3). */
export interface UserCreateInput {
  username: string;
  password: string;
  /** REQUEST side, so this is not the read-side Rule 2: `UserRole` is what the
   *  zod enum accepts (api/src/schemas/users.ts:6) and anything else earns a 400.
   *  The `(string & {})` tail exists because UsersTab holds the `<select>` value
   *  as a plain string; it keeps autocompletion without pretending that form
   *  state is already narrowed. */
  role?: UserRole | (string & {});
  displayName?: string;
}

/** Body of PUT /api/users/:id — every field optional (schemas/users.ts:10). */
export type UserUpdateInput = Partial<UserCreateInput>;

/**
 * Body of PUT /api/boards/:id (api/src/schemas/boards.ts:28). `.passthrough()`,
 * so unknown keys survive validation — but updateBoard only persists the columns
 * named here, which is why this stays a closed shape rather than an index
 * signature.
 */
export interface BoardUpdateInput {
  name?: string;
  workflow?: BoardWorkflow;
  filters?: Record<string, unknown>;
  plugins?: string[];
  mcp_auth?: Board['mcp_auth'];
}

/**
 * The body of every integration `GET /<provider>/status` route. ONE declaration
 * for two producers that do not agree:
 *
 *  - OAuth providers — onedrive, gmail, outlook, gdrive, slack, github
 *    (api/src/routes/oauthProviderRoutes.ts:137) — emit `configured`, `connected`,
 *    `agentId`, `boardId` plus per-provider extras (email, username…).
 *  - CREDENTIAL providers — jira, wordpress, s3
 *    (api/src/routes/lib/credentialConnector.ts:90-108) — emit NO `configured` key
 *    at all, and their two early returns omit `agentId`/`boardId` as well.
 *
 * Hence the `| undefined` on the three keys the credential half can omit: they are
 * declared present-but-possibly-undefined rather than optional because
 * ConnectStatus (components/connect/useConnectStatus.ts) requires `configured`,
 * and the widgets are out of this pass's scope. Under `strictNullChecks` that
 * mismatch surfaces at the widget, which is where it belongs.
 *
 * The index signature carries the per-provider extras, which no route declares.
 */
export interface IntegrationStatus {
  /** ABSENT on jira / wordpress / s3. */
  configured: boolean | undefined;
  connected: boolean;
  /** Absent on the credential connector's unresolvable-scope branch. */
  agentId: string | null | undefined;
  boardId: string | null | undefined;
  [key: string]: unknown;
}

/** POST /<provider>/disconnect, and the credential connectors' POST /connect. */
export interface IntegrationAck {
  success: boolean;
  [key: string]: unknown;
}

/**
 * GET /api/local-folder/status — the desktop-bridge presence probe. Per-USER, not
 * agent- or board-scoped, so it shares nothing with IntegrationStatus.
 * Produced by api/src/routes/localFolder.ts:22.
 */
export interface LocalFolderStatus {
  connected: boolean;
  /** `info?.folders ?? []`. Every entry is run through `String()` when the
   *  desktop registers (api/src/ws/socketHandler.ts:118), so these really are
   *  strings. */
  folders: string[];
  /** `Date.now()` at registration — epoch milliseconds, not an ISO string. */
  registeredAt: number | null;
  /** `process.env.DESKTOP_DOWNLOAD_URL || null`. */
  downloadUrl: string | null;
}

/**
 * GET /api/codex-auth/:ownerId/status (api/src/routes/codexAuth.ts:23 and :39).
 * `plan` is a closed set: the handler seeds it to 'unknown' and only ever
 * overwrites it with one of the other three literals. Both timestamps are EPOCH
 * MILLISECONDS, not ISO strings — `Date.parse(...)` and `new Date(...).getTime()`
 * (api/src/services/database/oauthTokens.ts:99).
 */
export type CodexAuthStatus =
  | { authenticated: false; ownerId: string }
  | {
      authenticated: true;
      ownerId: string;
      plan: 'unknown' | 'chatgpt-oauth' | 'api-key' | 'opaque';
      expiresAt: number | null;
      updatedAt: number | null;
    };

/** The `{ ok: true }` acknowledgement used by the task and codex-auth routes. */
export interface OkAck {
  ok: boolean;
}

/** The `{ success: true }` acknowledgement used by the agent/board/user routes. */
export interface SuccessAck {
  success: boolean;
}

/**
 * Per-session CSRF token.
 *
 * The session itself is an HttpOnly cookie that nothing here can read — that is
 * the point: a script injection can no longer lift the credential off the page.
 * What it costs is CSRF exposure, since the browser now attaches the session by
 * itself, so the API requires this token in `X-CSRF-Token` on every
 * state-changing request. The server hands it over in the login and
 * /auth/verify responses.
 *
 * It is held in memory only — deliberately not in localStorage, which is what
 * we just moved the session out of. A reload drops it, and App re-obtains it
 * from /auth/verify on boot.
 */
let csrfToken: string | null = null;

export function setCsrfToken(token: string | null | undefined): void {
  csrfToken = token || null;
}

// Browsers have no default fetch timeout, so a wedged backend would hang
// callers forever. Callers can override by passing their own `signal`.
function apiFetch(url: string, opts: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    // The session cookie is the credential. Same-origin defaults to sending it
    // anyway; explicit because the desktop shell proxies these same calls.
    credentials: 'include',
    ...opts,
  });
}

function getHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}),
  };
}

// The parsed body is `unknown` until we prove otherwise, so reading `.error` off
// it needs an actual check rather than a cast.
function errorFromBody(data: unknown, status: number): string {
  if (data && typeof data === 'object' && 'error' in data) {
    const { error } = data;
    if (typeof error === 'string' && error) return error;
  }
  return `Request failed (${status})`;
}

async function handleResponse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON body (proxy error page, plain-text 404) — fall back to status.
    data = {};
  }
  if (!res.ok) {
    throw Object.assign(new Error(errorFromBody(data, res.status)), {
      status: res.status,
    });
  }
  // ── THE TYPE BOUNDARY ──────────────────────────────────────────────────────
  // This assertion is the single place in the frontend where an untyped wire
  // value becomes a typed one. JSON.parse cannot know what it produced, and no
  // runtime validator sits between the API and this line, so `T` is a CLAIM: it
  // is only as true as the per-endpoint annotations below, which is why each of
  // them cites the handler it was read from. Do not copy this pattern anywhere
  // else — every other file gets its types from here, already narrowed.
  return data as T;
}

// Verb helpers — every endpoint below reads as method + path (+ payload).
// `long: true` swaps in the LONG_TIMEOUT_MS signal for LLM/Docker-bound calls;
// `auth: false` marks a public endpoint.
//
// `auth: false` no longer suppresses a credential — the session is a cookie the
// browser attaches either way. It only means "this route works logged out", and
// for GETs it also keeps the request header-free (and therefore preflight-free).
// Bodied verbs always send the CSRF token when we hold one: a public POST made
// while a session happens to be active is still CSRF-checked server-side.
type RequestOpts = { long?: boolean; auth?: boolean };

const request =
  (method: string) =>
  <T>(path: string, body?: unknown, opts: RequestOpts = {}): Promise<T> =>
    apiFetch(`${API_BASE}${path}`, {
      method,
      headers: getHeaders(),
      ...(body !== undefined && { body: JSON.stringify(body) }),
      ...(opts.long && { signal: AbortSignal.timeout(LONG_TIMEOUT_MS) }),
    }).then(res => handleResponse<T>(res));

// For GETs `auth: false` sends no headers at all — the public
// /auth/{provider}/status|url routes must stay header-free.
const get = <T>(path: string, opts: { auth?: boolean } = {}): Promise<T> =>
  apiFetch(`${API_BASE}${path}`, opts.auth === false ? {} : { headers: getHeaders() }).then(res =>
    handleResponse<T>(res)
  );

const post = request('POST');
const put = request('PUT');
const patch = request('PATCH');
const del = request('DELETE');

// PATCH /agents/:agentId/tasks/:taskId — shared by the agent-scoped task
// updaters below. Distinct from the standalone board-level `updateTask`
// export, which PUTs /tasks/:taskId.
const patchAgentTask = (agentId: string, taskId: string, fields: AgentTaskPatchInput) =>
  patch<MutatedTask>(`/agents/${agentId}/tasks/${taskId}`, fields);

// Shared agentId/boardId querystring + body builders for the per-agent /
// per-board integration endpoints.
const abQuery = (agentId?: string, boardId?: string) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (boardId) params.set('boardId', boardId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

const abBody = (agentId?: string, boardId?: string) => ({
  ...(agentId && { agentId }),
  ...(boardId && { boardId }),
});

// status + disconnect pair common to every integration provider; connect
// shapes differ per provider (Jira/WordPress/S3) and stay bespoke.
const integration = (base: string) => ({
  status: (agentId?: string, boardId?: string) =>
    get<IntegrationStatus>(`/${base}/status${abQuery(agentId, boardId)}`),
  disconnect: (agentId?: string, boardId?: string) =>
    post<SuccessAck>(`/${base}/disconnect`, abBody(agentId, boardId)),
});

// OAuth-based integrations additionally expose an auth-url endpoint.
const oauthIntegration = (base: string) => ({
  ...integration(base),
  authUrl: (agentId?: string, boardId?: string) =>
    get<{ authUrl: string }>(`/${base}/auth-url${abQuery(agentId, boardId)}`),
});

// Login OAuth (sign-in providers) — public routes: status/url send no
// headers at all, callback sends only Content-Type (no Authorization).
const loginProvider = (base: string) => ({
  status: () => get<OAuthProviderStatus>(`/auth/${base}/status`, { auth: false }),
  url: (redirectUri: string) =>
    get<OAuthAuthUrlResponse>(`/auth/${base}/url?redirect_uri=${encodeURIComponent(redirectUri)}`, {
      auth: false,
    }),
  callback: (code: string, redirectUri: string) =>
    post<SessionPayload>(
      `/auth/${base}/callback`,
      { code, redirect_uri: redirectUri },
      {
        auth: false,
      }
    ),
});

const googleLogin = loginProvider('google');
const microsoftLogin = loginProvider('microsoft');
const githubLogin = loginProvider('github');

// OneDrive keeps a custom authUrl for its `consumer` flag.
const onedrive = integration('onedrive');
const gmail = oauthIntegration('gmail');
const outlook = oauthIntegration('outlook');
const gdrive = oauthIntegration('gdrive');
const slack = oauthIntegration('slack');
const github = oauthIntegration('github');
const jira = integration('jira');
const wordpress = integration('wordpress');
const s3 = integration('s3');

export const api = {
  // Health — the public liveness probe (api/src/index.ts:312). The only call that
  // bypasses handleResponse, so the declared return type is what widens
  // `res.json()`'s `any` here instead of an assertion.
  getHealth: (): Promise<{ status: 'ok'; database: 'connected' | 'unavailable' }> =>
    apiFetch(`${API_BASE}/health`).then(res => res.json()),

  // Auth
  login: (username: string, password: string) =>
    post<SessionPayload>('/auth/login', { username, password }, { auth: false }),

  verify: () => get<VerifyResponse>('/auth/verify'),

  // Drops the session cookie server-side. The page cannot clear an HttpOnly
  // cookie itself, so logging out is a request, not a local delete.
  logout: () => post<OkAck>('/auth/logout'),

  acceptTerms: () => post<TermsAcceptedResponse>('/auth/accept-terms'),

  completeTutorial: () => post<TutorialCompletedResponse>('/auth/complete-tutorial'),

  // Google OAuth
  googleStatus: googleLogin.status,
  googleAuthUrl: googleLogin.url,
  googleCallback: googleLogin.callback,

  // Microsoft OAuth
  microsoftStatus: microsoftLogin.status,
  microsoftAuthUrl: microsoftLogin.url,
  microsoftCallback: microsoftLogin.callback,

  // GitHub OAuth (login)
  githubAuthUrl: githubLogin.url,
  githubAuthCallback: githubLogin.callback,

  // Agents
  getAgents: () => get<Agent[]>('/agents'),

  // Tasks (direct from tasks table)
  getAllTasks: (params: Record<string, string> = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get<Task[]>(`/tasks${qs ? '?' + qs : ''}`);
  },

  getProjectStats: (days = 30) => get<ProjectStatsResponse>(`/tasks/project-stats?days=${days}`),

  // Returns the batch envelope instead of a bare Agent when batchSize > 1
  // (api/src/routes/agents.ts:141).
  createAgent: (config: AgentWriteInput) => post<AgentCreated>('/agents', config, { long: true }),

  updateAgent: (id: string, updates: AgentWriteInput) => put<Agent>(`/agents/${id}`, updates),

  convertAgentToBatch: (id: string, batchSize: number) =>
    post<AgentBatchCreated>(`/agents/${id}/batch`, { batchSize }, { long: true }),

  deleteAgent: (id: string) => del<SuccessAck>(`/agents/${id}`),

  stopAgent: (id: string) => post<OkAck & { stopped: boolean }>(`/agents/${id}/stop`),

  // Task-level stop: clears the actionRunning flag on a task without
  // requiring the executor agent to still exist. Useful as a fallback when
  // the executor has been recycled and stopAgent returns 404.
  stopTask: (taskId: string) => post<OkAck>(`/tasks/${taskId}/stop`),

  // `response` is whatever agentManager.sendMessage resolved to — a
  // `Promise<any>` in api/src with no declared shape (index.ts:153), so the
  // honest declaration here is unknown, not a string.
  chatAgent: (id: string, message: string) =>
    post<{ response: unknown }>(`/agents/${id}/chat`, { message }, { long: true }),

  // GET /agents/:id/history returns a BARE array (routes/agents.ts:218). The
  // `history?: undefined` marker is not a second arm: it states that the array
  // has no such property, which is exactly what ExternalVoiceChatTab's
  // `data?.history` probe reads — a dead branch kept compiling by declaration,
  // not by pretending an envelope exists.
  getHistory: (id: string) =>
    get<ConversationMessage[] & { history?: undefined }>(`/agents/${id}/history`),

  reloadHistory: (id: string) => post<ConversationMessage[]>(`/agents/${id}/history/reload`),

  clearHistory: (id: string) => del<SuccessAck>(`/agents/${id}/history`),

  getCodexAuthStatus: (ownerId: string) => get<CodexAuthStatus>(`/codex-auth/${ownerId}/status`),

  // `authJson` is the PARSED auth.json, not its text: the route 400s unless
  // `typeof authJson === 'object'`, then reads `authJson.tokens.access_token` /
  // `authJson.OPENAI_API_KEY` and re-stringifies it
  // (api/src/routes/codexAuth.ts:47-56). `unknown` because the caller hands over
  // a raw `JSON.parse` of a user-supplied file and the route is what validates
  // the shape — the previous `string` was simply the wrong type.
  uploadCodexAuth: (ownerId: string, authJson: unknown) =>
    post<OkAck>(`/codex-auth/${ownerId}`, { authJson }, { long: true }),

  deleteCodexAuth: (ownerId: string) => del<OkAck>(`/codex-auth/${ownerId}`),

  reloadContext: (id: string) => post<SuccessAck>(`/agents/${id}/reload-context`),

  restartRuntime: (id: string) =>
    post<SuccessAck>(`/agents/${id}/restart`, undefined, { long: true }),

  truncateHistory: (id: string, afterIndex: number) =>
    del<ConversationMessage[]>(`/agents/${id}/history/after/${afterIndex}`),

  // Same unknown `response` as chatAgent — the handoff resolves the same
  // sendMessage value (routes/agents.ts:328).
  handoff: (fromId: string, targetAgentId: string, context: string) =>
    post<{ response: unknown }>(
      `/agents/${fromId}/handoff`,
      { targetAgentId, context },
      { long: true }
    ),

  // `results` is agentManager.broadcastMessage's return value, which api/src
  // declares as `any` — nothing in the type module models it.
  broadcast: (message: string) =>
    post<{ results: unknown }>('/agents/broadcast/all', { message }, { long: true }),

  // Tasks
  //
  // The 201 body is the hand-built in-memory `newTask`
  // (api/src/services/agentManager/tasks.ts:172-226), NOT a rowToTask output: it
  // has no updatedAt / commits / title / project / assignee / actionRunning key,
  // and not even an agentId. TaskCreatedEvent is exactly that object; the extra
  // `taskId?: undefined` records that the `result.taskId` fallback in
  // AllCommitsDiffModal reads a key no producer writes.
  addTask: (
    agentId: string,
    text: string,
    opts: {
      status?: TaskStatus;
      boardId?: string;
      repoFullName?: string;
      repoProvider?: string;
      secondaryRepos?: TaskSecondaryRepoInput[];
      recurrence?: TaskRecurrenceInput;
      taskType?: TaskType;
      isManual?: boolean;
      storagePath?: string | null;
      storageProvider?: string;
    } = {}
  ) => {
    const {
      status,
      boardId,
      repoFullName,
      secondaryRepos,
      recurrence,
      taskType,
      isManual,
      repoProvider = 'github',
      storagePath = null,
      storageProvider = 'onedrive',
    } = opts;
    return post<TaskCreatedEvent & { taskId?: undefined }>(`/agents/${agentId}/tasks`, {
      text,
      ...(status && { status }),
      ...(boardId && { boardId }),
      ...(repoFullName && { repoFullName, repoProvider }),
      ...(secondaryRepos && secondaryRepos.length > 0 && { secondaryRepos }),
      ...(storagePath && { storagePath, storageProvider }),
      ...(recurrence && { recurrence }),
      ...(taskType && { taskType }),
      ...(isManual && { isManual }),
    });
  },

  setTaskAssignee: (agentId: string, taskId: string, assigneeId: string | null) =>
    patch<MutatedTask>(`/agents/${agentId}/tasks/${taskId}/assignee`, { assigneeId }),

  refineTask: (agentId: string, taskId: string, refineAgentId: string) =>
    post<{ success: boolean; text: string }>(
      `/agents/${agentId}/tasks/${taskId}/refine`,
      { refineAgentId },
      { long: true }
    ),

  setTaskStatus: (agentId: string, taskId: string, status: TaskStatus) =>
    patchAgentTask(agentId, taskId, { status }),

  updateTask: (agentId: string, taskId: string, fields: AgentTaskPatchInput) =>
    patchAgentTask(agentId, taskId, fields),

  updateTaskRepo: (
    agentId: string,
    taskId: string,
    repoFullName: string | null,
    repoProvider = 'github'
  ) =>
    patchAgentTask(agentId, taskId, {
      repoFullName: repoFullName || null,
      repoProvider: repoFullName ? repoProvider : null,
    }),

  updateTaskSecondaryRepos: (
    agentId: string,
    taskId: string,
    secondaryRepos: TaskSecondaryRepoInput[]
  ) => patchAgentTask(agentId, taskId, { secondaryRepos: secondaryRepos || [] }),

  updateTaskStorage: (
    agentId: string,
    taskId: string,
    storagePath: string | null,
    storageProvider = 'onedrive'
  ) =>
    patchAgentTask(agentId, taskId, {
      storagePath: storagePath || null,
      storageProvider: storagePath ? storageProvider : null,
    }),

  removeTaskCommit: (agentId: string, taskId: string, hash: string) =>
    del<MutatedTask>(`/agents/${agentId}/tasks/${taskId}/commits/${hash}`),

  // RAG
  addRagDoc: (agentId: string, name: string, content: string) =>
    post<AgentRagDocument>(`/agents/${agentId}/rag`, { name, content }),

  addRagUrl: (agentId: string, name: string, url: string) =>
    post<AgentRagDocument>(`/agents/${agentId}/rag/url`, { name, url }),

  refreshRagDoc: (agentId: string, docId: string) =>
    post<AgentRagDocument>(`/agents/${agentId}/rag/${docId}/refresh`),

  deleteRagDoc: (agentId: string, docId: string) =>
    del<SuccessAck>(`/agents/${agentId}/rag/${docId}`),

  // Plugins (unified skills + MCP)
  getPlugins: () => get<Plugin[]>('/plugins'),

  // Both take a DRAFT, not a `Partial<Plugin>`. `Plugin` is the READ shape: its
  // `mcps` rows carry a server-minted `id` and an `apiKey` masked down to
  // `'' | '••••••••'`, neither of which a form can produce. The write schema is
  // looser on exactly those two fields — `id: z.string().optional()` and
  // `apiKey: z.string().max(500).optional()`, i.e. a plaintext key
  // (api/src/routes/plugins.ts:9,17) — which is what `PluginMcpDraft` spells out.
  // Typed as `Partial<…>` because PUT validates with `pluginSchema.partial()`
  // (plugins.ts:49) and POST is only ever handed a fully-populated draft anyway.
  createPlugin: (config: Partial<PluginDraft<PluginMcpDraft>>) => post<Plugin>('/plugins', config),

  updatePlugin: (id: string, updates: Partial<PluginDraft<PluginMcpDraft>>) =>
    put<Plugin>(`/plugins/${id}`, updates),

  deletePlugin: (id: string) => del<SuccessAck>(`/plugins/${id}`),

  // Agent plugin assignment — `plugins` is the agent's resulting skill-id list
  // (api/src/routes/agents.ts:853).
  assignPlugin: (agentId: string, pluginId: string) =>
    post<SuccessAck & { plugins: string[] }>(`/agents/${agentId}/plugins`, { pluginId }),

  removePlugin: (agentId: string, pluginId: string) =>
    del<SuccessAck>(`/agents/${agentId}/plugins/${pluginId}`),

  // MCP Servers
  getMcpServers: () => get<McpServer[]>('/mcp-servers'),

  // Throws (500) rather than 404ing on an unknown id — mcpManager._connectServer
  // raises, so this never resolves to null.
  connectMcpServer: (id: string) => post<McpServer>(`/mcp-servers/${id}/connect`),

  testMcpServer: (id: string, apiKey?: string) =>
    post<McpTestResult>(`/mcp-servers/${id}/test`, apiKey ? { apiKey } : undefined),

  // OneDrive OAuth (supports agentId or boardId)
  getOnedriveStatus: onedrive.status,

  getOnedriveAuthUrl: (agentId?: string, boardId?: string, opts?: { consumer?: boolean }) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    if (opts?.consumer) params.set('consumer', '1');
    const qs = params.toString();
    return get<{ authUrl: string }>(`/onedrive/auth-url${qs ? `?${qs}` : ''}`);
  },

  disconnectOnedrive: onedrive.disconnect,

  // Gmail OAuth (supports agentId or boardId)
  getGmailStatus: gmail.status,
  getGmailAuthUrl: gmail.authUrl,
  disconnectGmail: gmail.disconnect,

  // Outlook OAuth (supports agentId or boardId) — shares Microsoft OAuth client with OneDrive
  getOutlookStatus: outlook.status,
  getOutlookAuthUrl: outlook.authUrl,
  disconnectOutlook: outlook.disconnect,

  // Google Drive OAuth (supports agentId or boardId)
  getGdriveStatus: gdrive.status,
  getGdriveAuthUrl: gdrive.authUrl,
  disconnectGdrive: gdrive.disconnect,

  // Slack OAuth (supports agentId or boardId)
  getSlackStatus: slack.status,
  getSlackAuthUrl: slack.authUrl,
  disconnectSlack: slack.disconnect,

  // Realtime (Voice) — an OpenAI ephemeral-token envelope built inline at
  // api/src/routes/realtime.ts:166; the type module models no voice shape.
  getRealtimeToken: (agentId: string) =>
    post<{
      token: string;
      expiresAt: number;
      session: unknown;
      voice: string;
      model: string;
      transcriptionModel: string;
    }>('/realtime/token', { agentId }),

  // External voice (STT + LLM + TTS pipeline) — returns WSS URLs for the browser.
  // The SttConfig/TtsConfig pair that describes these blocks lives in
  // lib/externalVoiceClient.ts on purpose and is not re-exported by ./types, so
  // this stays structural.
  getExternalVoiceConfig: (agentId: string) =>
    get<{
      stt: { wsUrl: string; sampleRate: number; encoding: string; channels: number };
      tts: {
        wsUrl: string;
        sampleRate: number;
        encoding: string;
        channels: number;
        voiceId: string;
      };
      llmConfigId: string | null;
    }>(`/external-voice/config/${encodeURIComponent(agentId)}`),

  // Global STT/TTS availability + WS URLs for the regular text chat.
  // agentId is optional and is only used to resolve a per-agent ttsVoiceId.
  // Each half is a two-arm union: the unavailable arm is `{ available: false }`
  // and carries no URL at all (api/src/routes/externalVoice.ts:91-101).
  getExternalVoiceServices: (agentId?: string) =>
    get<{
      stt:
        | { available: true; wsUrl: string; sampleRate: number; encoding: string; channels: number }
        | { available: false };
      tts:
        | {
            available: true;
            wsUrl: string;
            sampleRate: number;
            encoding: string;
            channels: number;
            voiceId: string;
          }
        | { available: false };
    }>(`/external-voice/services${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),

  // Probes the configured STT or TTS WebSocket. service must be "stt" or "tts".
  // url + apiKey are optional — when omitted, the server uses the saved settings.
  // The body is probeWebSocket's result, an untyped local helper.
  testExternalVoiceService: (service: 'stt' | 'tts', url?: string, apiKey?: string) =>
    post<{ ok: boolean; error?: string; [key: string]: unknown }>(
      `/external-voice/test/${service}`,
      {
        ...(url ? { url } : {}),
        ...(apiKey !== undefined ? { apiKey } : {}),
      }
    ),

  // Templates
  getTemplates: () => get<AgentTemplate[]>('/templates'),

  // Admin: reset instructions by role
  resetInstructionsByRole: (role: string) =>
    post<SuccessAck & { role: string; resetCount: number; agentIds: string[] }>(
      `/agents/reset-instructions/${encodeURIComponent(role)}`
    ),

  // Projects (DB-backed)
  getProjects: () => get<ProjectListItem[]>('/projects'),

  getProject: (id: string) => get<ProjectDetail>(`/projects/${id}`),

  createProject: (name: string, description = '', rules = '') =>
    post<Project>('/projects', { name, description, rules }),

  // Guarded: a missing project 404s before res.json (routes/projects.ts:182).
  updateProject: (id: string, fields: Partial<Project>) => put<Project>(`/projects/${id}`, fields),

  deleteProject: (id: string) => del<ProjectMutationAck>(`/projects/${id}`),

  // Project ↔ Board linking
  attachBoardToProject: (projectId: string, boardId: string) =>
    post<ProjectMutationAck>(`/projects/${projectId}/boards/${boardId}`),

  detachBoardFromProject: (projectId: string, boardId: string) =>
    del<ProjectMutationAck>(`/projects/${projectId}/boards/${boardId}`),

  // Storages accessible via the board's OneDrive plugin OAuth token (picker source)
  getBoardAvailableStorages: (boardId: string) =>
    get<AvailableStorage[]>(`/projects/boards/${boardId}/available-storages`),

  // Available repos from configured git connections (for the picker).
  // NOTE this is AvailableRepo[], not RepoPickerOption[]: App.tsx:114-123 remaps
  // every item into its own normalised shape before storing it — and that remap
  // reads `r.name`, a key NEITHER available-repos route emits (see AvailableRepo
  // in types/project.ts). `name?: undefined` says exactly that: the property is
  // readable and always absent.
  getAvailableRepos: () =>
    get<Array<AvailableRepo & { name?: undefined }>>('/projects/available-repos'),

  // Available repos via the board's GitHub plugin OAuth token (for BoardReposPanel)
  getBoardAvailableRepos: (boardId: string) =>
    get<AvailableRepo[]>(`/projects/boards/${boardId}/available-repos`),

  // Code Index — auto-index project by name
  indexProject: (projectName: string) =>
    post<CodeIndexProjectResponse>('/code-index/index-project', { projectName }, { long: true }),

  // GitHub explorer — all endpoints authenticate via the board's GitHub plugin OAuth.
  getGitHubActivity: (
    owner: string,
    repo: string,
    boardId: string,
    opts: { refresh?: boolean } = {}
  ) => {
    const params = new URLSearchParams({ boardId });
    if (opts.refresh) params.set('refresh', '1');
    return get<GitHubActivityResponse>(
      `/projects/github-activity/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${params}`
    );
  },

  getGitHubBranches: (owner: string, repo: string, boardId: string) =>
    get<GitHubBranch[]>(
      `/projects/github-branches/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?boardId=${encodeURIComponent(boardId)}`
    ),

  getGitHubTree: (owner: string, repo: string, ref: string, boardId: string) =>
    get<GitHubTreeResponse>(
      `/projects/github-tree/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}?boardId=${encodeURIComponent(boardId)}`
    ),

  getGitHubFile: (owner: string, repo: string, ref: string, filePath: string, boardId: string) =>
    get<GitHubFileContent>(
      `/projects/github-file/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${filePath}?boardId=${encodeURIComponent(boardId)}`
    ),

  // Code call-graph analysis (UI → services or services → UI), on-demand.
  analyzeCodeGraph: (
    owner: string,
    repo: string,
    boardId: string,
    {
      direction = 'ui-to-service',
      ref = 'main',
      refresh = false,
    }: { direction?: CodeGraphDirection; ref?: string; refresh?: boolean } = {}
  ) =>
    post<CodeGraphResponse>(
      `/projects/code-graph/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?boardId=${encodeURIComponent(boardId)}`,
      { direction, ref, refresh },
      { long: true }
    ),

  // API Key (MCP)
  getApiKeyInfo: () => get<ApiKeyInfoResponse>('/settings/api-key'),

  generateApiKey: () => post<ApiKeyCreated>('/settings/api-key'),

  revokeApiKey: () => del<SuccessAck>('/settings/api-key'),

  // General settings
  getSettings: () => get<Settings>('/settings/general'),

  updateSettings: (patch: Partial<Settings>) => put<Settings>('/settings/general', patch),

  // Reminder configuration
  getReminderConfig: () => get<ReminderConfig>('/settings/general/reminders'),

  updateReminderConfig: (patch: Partial<ReminderConfig>) =>
    put<ReminderConfig>('/settings/general/reminders', patch),

  // Boards (per-user multi-board)
  getBoards: () => get<BoardListItem[]>('/boards'),

  getAllBoardsAdmin: () => get<AdminBoardListItem[]>('/boards/all'),

  createBoard: (name?: string, workflow?: BoardWorkflow, filters?: Record<string, unknown>) =>
    post<Board>('/boards', { name, workflow, filters }),

  // NULLABLE: updateBoard() ends in `return result.rows[0] || null`
  // (api/src/services/database/boards.ts:185) and short-circuits to getBoardById
  // when the patch sets no column (:174); routes/boards.ts:190 res.json()s that
  // straight through with no guard.
  updateBoard: (id: string, updates: BoardUpdateInput) =>
    put<Board | null>(`/boards/${id}`, updates),

  // Same unguarded updateBoard() result (routes/boards.ts:214).
  updateBoardWorkflow: (id: string, workflow: BoardWorkflow) =>
    put<Board | null>(`/boards/${id}/workflow`, workflow),

  deleteBoard: (id: string) => del<SuccessAck>(`/boards/${id}`),

  // Board plugins
  getBoardPlugins: (boardId: string) => get<BoardPluginsResponse>(`/boards/${boardId}/plugins`),

  // Same unguarded updateBoard() result (routes/boards.ts:259). The
  // already-assigned short-circuit (:256) returns the board it loaded instead,
  // which is never null.
  assignBoardPlugin: (boardId: string, pluginId: string) =>
    post<Board | null>(`/boards/${boardId}/plugins/assign`, { pluginId }),

  // Same unguarded updateBoard() result (routes/boards.ts:276).
  removeBoardPlugin: (boardId: string, pluginId: string) =>
    post<Board | null>(`/boards/${boardId}/plugins/remove`, { pluginId }),

  // Board sharing
  getBoardShares: (boardId: string) => get<BoardShare[]>(`/boards/${boardId}/shares`),

  // `permission` carries the same request-side tail as UserCreateInput.role: the
  // zod enum is the real gate, ShareBoardModal holds the select value as a string.
  shareBoardWith: (
    boardId: string,
    username: string,
    permission: BoardPermission | (string & {})
  ) => post<BoardShareMutationResult>(`/boards/${boardId}/shares`, { username, permission }),

  updateBoardShare: (
    boardId: string,
    userId: string,
    permission: BoardPermission | (string & {})
  ) => put<BoardShareMutationResult>(`/boards/${boardId}/shares/${userId}`, { permission }),

  removeBoardShare: (boardId: string, userId: string) =>
    del<SuccessAck>(`/boards/${boardId}/shares/${userId}`),

  getBoardUsers: () => get<UserDirectoryEntry[]>('/boards/users'),

  // Project task stats
  getProjectTaskStats: (project: string) =>
    get<ProjectTaskStats>(`/agents/tasks/stats?project=${encodeURIComponent(project)}`),

  getProjectTimeSeries: (project: string, days = 30) =>
    get<ProjectTimeSeries>(
      `/agents/tasks/stats/timeseries?project=${encodeURIComponent(project)}&days=${days}`
    ),

  getProjectAgentTime: (project: string, days = 30) =>
    get<AgentTimeSeries>(
      `/agents/tasks/stats/agent-time?project=${encodeURIComponent(project)}&days=${days}`
    ),

  getGlobalAgentTime: (days = 30) =>
    get<AgentTimeSeries>(`/agents/tasks/stats/agent-time?days=${days}`),

  // Jira (per-agent / per-board)
  getJiraStatus: jira.status,

  connectJira: (
    agentId: string,
    domain: string,
    email: string,
    apiToken: string,
    boardId?: string
  ) =>
    post<IntegrationAck>('/jira/connect', {
      agentId,
      domain,
      email,
      apiToken,
      ...(boardId && { boardId }),
    }),

  disconnectJira: jira.disconnect,

  // WordPress (per-agent / per-board)
  getWordPressStatus: wordpress.status,

  connectWordPress: (
    agentId: string,
    siteUrl: string,
    username: string,
    applicationPassword: string,
    boardId?: string
  ) =>
    post<IntegrationAck>('/wordpress/connect', {
      agentId,
      siteUrl,
      username,
      applicationPassword,
      ...(boardId && { boardId }),
    }),

  disconnectWordPress: wordpress.disconnect,

  // AWS S3 (per-agent / per-board)
  getS3Status: s3.status,

  connectS3: (
    agentId: string,
    secretAccessKey: string,
    accessKeyId: string,
    region: string,
    boardId?: string,
    endpoint?: string
  ) =>
    post<IntegrationAck>('/s3/connect', {
      agentId,
      accessKeyId,
      secretAccessKey,
      region,
      ...(boardId && { boardId }),
      ...(endpoint && { endpoint }),
    }),

  disconnectS3: s3.disconnect,

  // Local Folder (desktop bridge — per-user, not agent/board scoped). Status
  // reflects whether THIS user's desktop app is online with a folder shared.
  getLocalFolderStatus: () => get<LocalFolderStatus>('/local-folder/status'),

  // GitHub OAuth (per-agent / per-board)
  getGitHubStatus: github.status,
  getGitHubAuthUrl: github.authUrl,
  disconnectGitHub: github.disconnect,

  // Users (admin only)
  getUsers: () => get<User[]>('/users'),

  createUser: (data: UserCreateInput) => post<UserMutationResult>('/users', data),

  updateUser: (id: string, updates: UserUpdateInput) =>
    put<UserMutationResult>(`/users/${id}`, updates),

  deleteUser: (id: string) => del<SuccessAck>(`/users/${id}`),

  // Impersonation (admin only)
  impersonate: (userId: string) => post<ImpersonateResponse>(`/auth/impersonate/${userId}`),

  // Hands the admin their own session back. Server-side now: the page has no
  // copy of the original token to swap in.
  stopImpersonation: () => post<SessionPayload>('/auth/stop-impersonation'),

  // LLM Configs (admin only)
  getLlmConfigs: () => get<LlmConfig[]>('/llm-configs'),

  createLlmConfig: (data: LlmConfigDraft) => post<LlmConfig>('/llm-configs', data),

  updateLlmConfig: (id: string, data: LlmConfigDraft) => put<LlmConfig>(`/llm-configs/${id}`, data),

  deleteLlmConfig: (id: string) => del<SuccessAck>(`/llm-configs/${id}`),

  // Contact form (public — no auth)
  submitContact: (data: {
    email: string;
    phone: string;
    name?: string;
    company?: string;
    message?: string;
    type: 'contact' | 'support';
  }) => post<SuccessAck & { message: string }>('/contact', data, { auth: false }),
};

// Budget
export const fetchBudgetSummary = (days = 1) =>
  get<BudgetSummaryResponse>(`/budget/summary?days=${days}`);

export const fetchBudgetByAgent = (days = 30) =>
  get<BudgetByAgentRow[]>(`/budget/by-agent?days=${days}`);

export const fetchBudgetTimeline = (days = 7, groupBy: BudgetTimelineGroupBy = 'day') =>
  get<BudgetTimelinePoint[]>(`/budget/timeline?days=${days}&groupBy=${groupBy}`);

export const fetchBudgetDaily = (days = 30) =>
  get<BudgetDailyPoint[]>(`/budget/daily?days=${days}`);

export const fetchBudgetConfig = () => get<BudgetConfig>('/budget/config');

// `Partial`, not `BudgetConfig`: the PUT body schema gives BOTH fields a zod
// `.default()` — dailyBudget 0, alertThreshold 80 (api/src/routes/budget.ts:23-24)
// — so `{}` is a valid body and comes back filled in. The dashboard genuinely
// sends a partial draft (`{ ...config }` with a null `config`).
export const updateBudgetConfig = (config: Partial<BudgetConfig>) =>
  put<BudgetConfigUpdateResponse>('/budget/config', config);

export const fetchBudgetAlerts = () => get<BudgetAlertsResponse>('/budget/alerts');

export default api;

/* ── Task CRUD (board-level, uses /api/tasks/:id) ─────────────────────────── */
// Guarded (404 on a missing task), but the body is the MUTATED task, not a
// rowToTask output — see MutatedTask.
export const updateTask = (taskId: string, fields: TaskUpdateInput) =>
  put<MutatedTask>(`/tasks/${taskId}`, fields);

export const deleteTask = (taskId: string) => del<OkAck>(`/tasks/${taskId}`);

export const clearTaskStopped = (taskId: string) => patch<OkAck>(`/tasks/${taskId}/clear-stopped`);

/* ── Reorder tasks within a column ──────────────────────────────────── */
export const reorderTasks = (orderedIds: string[]) =>
  put<OkAck & { count: number }>('/tasks/reorder', { orderedIds });

/* ── Soft-delete management ──────────────────────────────────────────────── */
// The only route where Task.deletedAt / deletedBy are actually populated.
export const getDeletedTasks = () => get<Task[]>('/tasks/deleted');

export const restoreTask = (taskId: string) => post<Task>(`/tasks/${taskId}/restore`);

export const hardDeleteTask = (taskId: string) => del<OkAck>(`/tasks/${taskId}/permanent`);

/* ── Commit diff ──────────────────────────────────────────────────────────── */
export const getCommitDiff = (taskId: string, hash: string) =>
  get<CommitDiff>(`/tasks/${taskId}/commits/${hash}/diff`);
