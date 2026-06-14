import { safeGet } from './lib/safeStorage';

const API_BASE = '/api';

const DEFAULT_TIMEOUT_MS = 30000;
// LLM/Docker-bound operations legitimately run for minutes — only guard
// against requests that hang forever.
const LONG_TIMEOUT_MS = 600000;

// Browsers have no default fetch timeout, so a wedged backend would hang
// callers forever. Callers can override by passing their own `signal`.
function apiFetch(url, opts = {}) {
  return fetch(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS), ...opts });
}

function getHeaders() {
  const token = safeGet('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function handleResponse(res) {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    // Non-JSON body (proxy error page, plain-text 404) — fall back to status.
    data = {};
  }
  if (!res.ok) {
    throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  }
  return data;
}

// Verb helpers — every endpoint below reads as method + path (+ payload).
// `long: true` swaps in the LONG_TIMEOUT_MS signal for LLM/Docker-bound calls;
// `auth: false` marks a public endpoint (bare Content-Type, no Authorization).
type RequestOpts = { long?: boolean; auth?: boolean };

const request = (method: string) => (path: string, body?: unknown, opts: RequestOpts = {}) =>
  apiFetch(`${API_BASE}${path}`, {
    method,
    headers: opts.auth === false ? { 'Content-Type': 'application/json' } : getHeaders(),
    ...(body !== undefined && { body: JSON.stringify(body) }),
    ...(opts.long && { signal: AbortSignal.timeout(LONG_TIMEOUT_MS) }),
  }).then(handleResponse);

// For GETs `auth: false` sends no headers at all — the public
// /auth/{provider}/status|url routes must stay header-free.
const get = (path: string, opts: { auth?: boolean } = {}) =>
  apiFetch(`${API_BASE}${path}`, opts.auth === false ? {} : { headers: getHeaders() }).then(handleResponse);

const post = request('POST');
const put = request('PUT');
const patch = request('PATCH');
const del = request('DELETE');

// PATCH /agents/:agentId/tasks/:taskId — shared by the agent-scoped task
// updaters below. Distinct from the standalone board-level `updateTask`
// export, which PUTs /tasks/:taskId.
const patchAgentTask = (agentId, taskId, fields) =>
  patch(`/agents/${agentId}/tasks/${taskId}`, fields);

// Shared agentId/boardId querystring + body builders for the per-agent /
// per-board integration endpoints.
const abQuery = (agentId?: string, boardId?: string) => {
  const params = new URLSearchParams();
  if (agentId) params.set('agentId', agentId);
  if (boardId) params.set('boardId', boardId);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
};

const abBody = (agentId?: string, boardId?: string) =>
  ({ ...(agentId && { agentId }), ...(boardId && { boardId }) });

// status + disconnect pair common to every integration provider; connect
// shapes differ per provider (Jira/WordPress/S3) and stay bespoke.
const integration = (base: string) => ({
  status: (agentId?: string, boardId?: string) => get(`/${base}/status${abQuery(agentId, boardId)}`),
  disconnect: (agentId?: string, boardId?: string) => post(`/${base}/disconnect`, abBody(agentId, boardId)),
});

// OAuth-based integrations additionally expose an auth-url endpoint.
const oauthIntegration = (base: string) => ({
  ...integration(base),
  authUrl: (agentId?: string, boardId?: string) => get(`/${base}/auth-url${abQuery(agentId, boardId)}`),
});

// Login OAuth (sign-in providers) — public routes: status/url send no
// headers at all, callback sends only Content-Type (no Authorization).
const loginProvider = (base: string) => ({
  status: () => get(`/auth/${base}/status`, { auth: false }),
  url: (redirectUri) => get(`/auth/${base}/url?redirect_uri=${encodeURIComponent(redirectUri)}`, { auth: false }),
  callback: (code, redirectUri) => post(`/auth/${base}/callback`, { code, redirect_uri: redirectUri }, { auth: false }),
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
  // Health
  getHealth: () =>
    apiFetch(`${API_BASE}/health`).then(res => res.json()),

  // Auth
  login: (username, password) =>
    post('/auth/login', { username, password }, { auth: false }),

  verify: () =>
    get('/auth/verify'),

  acceptTerms: () =>
    post('/auth/accept-terms'),

  completeTutorial: () =>
    post('/auth/complete-tutorial'),

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
  getAgents: () =>
    get('/agents'),

  // Tasks (direct from tasks table)
  getAllTasks: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return get(`/tasks${qs ? '?' + qs : ''}`);
  },

  getProjectStats: (days = 30) =>
    get(`/tasks/project-stats?days=${days}`),

  createAgent: (config) =>
    post('/agents', config, { long: true }),

  updateAgent: (id, updates) =>
    put(`/agents/${id}`, updates),

  deleteAgent: (id) =>
    del(`/agents/${id}`),

  stopAgent: (id) =>
    post(`/agents/${id}/stop`),

  // Task-level stop: clears the actionRunning flag on a task without
  // requiring the executor agent to still exist. Useful as a fallback when
  // the executor has been recycled and stopAgent returns 404.
  stopTask: (taskId) =>
    post(`/tasks/${taskId}/stop`),

  chatAgent: (id, message) =>
    post(`/agents/${id}/chat`, { message }, { long: true }),

  getHistory: (id) =>
    get(`/agents/${id}/history`),

  reloadHistory: (id) =>
    post(`/agents/${id}/history/reload`),

  clearHistory: (id) =>
    del(`/agents/${id}/history`),

  getCodexAuthStatus: (ownerId) =>
    get(`/codex-auth/${ownerId}/status`),

  uploadCodexAuth: (ownerId, authJson) =>
    post(`/codex-auth/${ownerId}`, { authJson }, { long: true }),

  deleteCodexAuth: (ownerId) =>
    del(`/codex-auth/${ownerId}`),

  reloadContext: (id) =>
    post(`/agents/${id}/reload-context`),

  restartRuntime: (id) =>
    post(`/agents/${id}/restart`, undefined, { long: true }),

  truncateHistory: (id, afterIndex) =>
    del(`/agents/${id}/history/after/${afterIndex}`),

  handoff: (fromId, targetAgentId, context) =>
    post(`/agents/${fromId}/handoff`, { targetAgentId, context }, { long: true }),

  broadcast: (message) =>
    post('/agents/broadcast/all', { message }, { long: true }),

  // Tasks
  addTask: (agentId, text, opts: {
    status?: string;
    boardId?: string;
    repoFullName?: string;
    repoProvider?: string;
    recurrence?: any;
    taskType?: string;
    isManual?: boolean;
    storagePath?: string | null;
    storageProvider?: string;
  } = {}) => {
    const { status, boardId, repoFullName, recurrence, taskType, isManual, repoProvider = 'github', storagePath = null, storageProvider = 'onedrive' } = opts;
    return post(`/agents/${agentId}/tasks`, {
      text,
      ...(status && { status }),
      ...(boardId && { boardId }),
      ...(repoFullName && { repoFullName, repoProvider }),
      ...(storagePath && { storagePath, storageProvider }),
      ...(recurrence && { recurrence }),
      ...(taskType && { taskType }),
      ...(isManual && { isManual }),
    });
  },

  setTaskAssignee: (agentId, taskId, assigneeId) =>
    patch(`/agents/${agentId}/tasks/${taskId}/assignee`, { assigneeId }),

  refineTask: (agentId, taskId, refineAgentId) =>
    post(`/agents/${agentId}/tasks/${taskId}/refine`, { refineAgentId }, { long: true }),

  setTaskStatus: (agentId, taskId, status) =>
    patchAgentTask(agentId, taskId, { status }),

  updateTask: (agentId, taskId, fields) =>
    patchAgentTask(agentId, taskId, fields),

  updateTaskRepo: (agentId, taskId, repoFullName, repoProvider = 'github') =>
    patchAgentTask(agentId, taskId, { repoFullName: repoFullName || null, repoProvider: repoFullName ? repoProvider : null }),

  updateTaskStorage: (agentId, taskId, storagePath, storageProvider = 'onedrive') =>
    patchAgentTask(agentId, taskId, { storagePath: storagePath || null, storageProvider: storagePath ? storageProvider : null }),

  removeTaskCommit: (agentId, taskId, hash) =>
    del(`/agents/${agentId}/tasks/${taskId}/commits/${hash}`),

  // RAG
  addRagDoc: (agentId, name, content) =>
    post(`/agents/${agentId}/rag`, { name, content }),

  addRagUrl: (agentId, name, url) =>
    post(`/agents/${agentId}/rag/url`, { name, url }),

  refreshRagDoc: (agentId, docId) =>
    post(`/agents/${agentId}/rag/${docId}/refresh`),

  deleteRagDoc: (agentId, docId) =>
    del(`/agents/${agentId}/rag/${docId}`),

  // Plugins (unified skills + MCP)
  getPlugins: () =>
    get('/plugins'),

  createPlugin: (config) =>
    post('/plugins', config),

  updatePlugin: (id, updates) =>
    put(`/plugins/${id}`, updates),

  deletePlugin: (id) =>
    del(`/plugins/${id}`),

  // Agent plugin assignment
  assignPlugin: (agentId, pluginId) =>
    post(`/agents/${agentId}/plugins`, { pluginId }),

  removePlugin: (agentId, pluginId) =>
    del(`/agents/${agentId}/plugins/${pluginId}`),

  // MCP Servers
  getMcpServers: () =>
    get('/mcp-servers'),

  connectMcpServer: (id) =>
    post(`/mcp-servers/${id}/connect`),

  testMcpServer: (id, apiKey) =>
    post(`/mcp-servers/${id}/test`, apiKey ? { apiKey } : undefined),

  // OneDrive OAuth (supports agentId or boardId)
  getOnedriveStatus: onedrive.status,

  getOnedriveAuthUrl: (agentId?, boardId?, opts?: { consumer?: boolean }) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    if (opts?.consumer) params.set('consumer', '1');
    const qs = params.toString();
    return get(`/onedrive/auth-url${qs ? `?${qs}` : ''}`);
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

  // Realtime (Voice)
  getRealtimeToken: (agentId) =>
    post('/realtime/token', { agentId }),

  // External voice (STT + LLM + TTS pipeline) — returns WSS URLs for the browser
  getExternalVoiceConfig: (agentId) =>
    get(`/external-voice/config/${encodeURIComponent(agentId)}`),

  // Global STT/TTS availability + WS URLs for the regular text chat.
  // agentId is optional and is only used to resolve a per-agent ttsVoiceId.
  getExternalVoiceServices: (agentId) =>
    get(`/external-voice/services${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),

  // Probes the configured STT or TTS WebSocket. service must be "stt" or "tts".
  // url + apiKey are optional — when omitted, the server uses the saved settings.
  testExternalVoiceService: (service: 'stt' | 'tts', url?: string, apiKey?: string) =>
    post(`/external-voice/test/${service}`, { ...(url ? { url } : {}), ...(apiKey !== undefined ? { apiKey } : {}) }),

  // Templates
  getTemplates: () =>
    get('/templates'),

  // Admin: reset instructions by role
  resetInstructionsByRole: (role) =>
    post(`/agents/reset-instructions/${encodeURIComponent(role)}`),

  // Projects (DB-backed)
  getProjects: () =>
    get('/projects'),

  getProject: (id) =>
    get(`/projects/${id}`),

  createProject: (name, description = '', rules = '') =>
    post('/projects', { name, description, rules }),

  updateProject: (id, fields) =>
    put(`/projects/${id}`, fields),

  deleteProject: (id) =>
    del(`/projects/${id}`),

  // Project ↔ Board linking
  attachBoardToProject: (projectId, boardId) =>
    post(`/projects/${projectId}/boards/${boardId}`),

  detachBoardFromProject: (projectId, boardId) =>
    del(`/projects/${projectId}/boards/${boardId}`),

  // Storages accessible via the board's OneDrive plugin OAuth token (picker source)
  getBoardAvailableStorages: (boardId) =>
    get(`/projects/boards/${boardId}/available-storages`),

  // Available repos from configured git connections (for the picker)
  getAvailableRepos: () =>
    get('/projects/available-repos'),

  // Available repos via the board's GitHub plugin OAuth token (for BoardReposPanel)
  getBoardAvailableRepos: (boardId) =>
    get(`/projects/boards/${boardId}/available-repos`),

  // Code Index — auto-index project by name
  indexProject: (projectName) =>
    post('/code-index/index-project', { projectName }, { long: true }),

  // GitHub explorer — all endpoints authenticate via the board's GitHub plugin OAuth.
  getGitHubActivity: (owner, repo, boardId, opts: { refresh?: boolean } = {}) => {
    const params = new URLSearchParams({ boardId });
    if (opts.refresh) params.set('refresh', '1');
    return get(`/projects/github-activity/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${params}`);
  },

  getGitHubBranches: (owner, repo, boardId) =>
    get(`/projects/github-branches/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?boardId=${encodeURIComponent(boardId)}`),

  getGitHubTree: (owner, repo, ref, boardId) =>
    get(`/projects/github-tree/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}?boardId=${encodeURIComponent(boardId)}`),

  getGitHubFile: (owner, repo, ref, filePath, boardId) =>
    get(`/projects/github-file/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${filePath}?boardId=${encodeURIComponent(boardId)}`),

  // Code call-graph analysis (UI → services or services → UI), on-demand.
  analyzeCodeGraph: (owner, repo, boardId, { direction = 'ui-to-service', ref = 'main', refresh = false } = {}) =>
    post(`/projects/code-graph/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?boardId=${encodeURIComponent(boardId)}`, { direction, ref, refresh }, { long: true }),

  // API Key (MCP)
  getApiKeyInfo: () =>
    get('/settings/api-key'),

  generateApiKey: () =>
    post('/settings/api-key'),

  revokeApiKey: () =>
    del('/settings/api-key'),

  // General settings
  getSettings: () =>
    get('/settings/general'),

  updateSettings: (patch) =>
    put('/settings/general', patch),

  // Reminder configuration
  getReminderConfig: () =>
    get('/settings/general/reminders'),

  updateReminderConfig: (patch) =>
    put('/settings/general/reminders', patch),

  // Boards (per-user multi-board)
  getBoards: () =>
    get('/boards'),

  getAllBoardsAdmin: () =>
    get('/boards/all'),

  createBoard: (name, workflow, filters) =>
    post('/boards', { name, workflow, filters }),

  updateBoard: (id, updates) =>
    put(`/boards/${id}`, updates),

  updateBoardWorkflow: (id, workflow) =>
    put(`/boards/${id}/workflow`, workflow),

  deleteBoard: (id) =>
    del(`/boards/${id}`),

  // Board plugins
  getBoardPlugins: (boardId) =>
    get(`/boards/${boardId}/plugins`),

  assignBoardPlugin: (boardId, pluginId) =>
    post(`/boards/${boardId}/plugins/assign`, { pluginId }),

  removeBoardPlugin: (boardId, pluginId) =>
    post(`/boards/${boardId}/plugins/remove`, { pluginId }),

  // Board sharing
  getBoardShares: (boardId) =>
    get(`/boards/${boardId}/shares`),

  shareBoardWith: (boardId, username, permission) =>
    post(`/boards/${boardId}/shares`, { username, permission }),

  updateBoardShare: (boardId, userId, permission) =>
    put(`/boards/${boardId}/shares/${userId}`, { permission }),

  removeBoardShare: (boardId, userId) =>
    del(`/boards/${boardId}/shares/${userId}`),

  getBoardUsers: () =>
    get('/boards/users'),

  // Project task stats
  getProjectTaskStats: (project) =>
    get(`/agents/tasks/stats?project=${encodeURIComponent(project)}`),

  getProjectTimeSeries: (project, days = 30) =>
    get(`/agents/tasks/stats/timeseries?project=${encodeURIComponent(project)}&days=${days}`),

  getProjectAgentTime: (project, days = 30) =>
    get(`/agents/tasks/stats/agent-time?project=${encodeURIComponent(project)}&days=${days}`),

  getGlobalAgentTime: (days = 30) =>
    get(`/agents/tasks/stats/agent-time?days=${days}`),

  // Jira (per-agent / per-board)
  getJiraStatus: jira.status,

  connectJira: (agentId: string, domain: string, email: string, apiToken: string, boardId?: string) =>
    post('/jira/connect', { agentId, domain, email, apiToken, ...(boardId && { boardId }) }),

  disconnectJira: jira.disconnect,

  // WordPress (per-agent / per-board)
  getWordPressStatus: wordpress.status,

  connectWordPress: (agentId: string, siteUrl: string, username: string, applicationPassword: string, boardId?: string) =>
    post('/wordpress/connect', { agentId, siteUrl, username, applicationPassword, ...(boardId && { boardId }) }),

  disconnectWordPress: wordpress.disconnect,

  // AWS S3 (per-agent / per-board)
  getS3Status: s3.status,

  connectS3: (agentId: string, secretAccessKey: string, accessKeyId: string, region: string, boardId?: string, endpoint?: string) =>
    post('/s3/connect', { agentId, accessKeyId, secretAccessKey, region, ...(boardId && { boardId }), ...(endpoint && { endpoint }) }),

  disconnectS3: s3.disconnect,

  // GitHub OAuth (per-agent / per-board)
  getGitHubStatus: github.status,
  getGitHubAuthUrl: github.authUrl,
  disconnectGitHub: github.disconnect,

  // Users (admin only)
  getUsers: () =>
    get('/users'),

  createUser: (data) =>
    post('/users', data),

  updateUser: (id, updates) =>
    put(`/users/${id}`, updates),

  deleteUser: (id) =>
    del(`/users/${id}`),

  // Impersonation (admin only)
  impersonate: (userId) =>
    post(`/auth/impersonate/${userId}`),

  // LLM Configs (admin only)
  getLlmConfigs: () =>
    get('/llm-configs'),

  createLlmConfig: (data) =>
    post('/llm-configs', data),

  updateLlmConfig: (id, data) =>
    put(`/llm-configs/${id}`, data),

  deleteLlmConfig: (id) =>
    del(`/llm-configs/${id}`),

  // Contact form (public — no auth)
  submitContact: (data: { email: string; phone: string; name?: string; company?: string; message?: string; type: 'contact' | 'support' }) =>
    post('/contact', data, { auth: false }),
};

// Budget
export const fetchBudgetSummary = (days = 1) =>
  get(`/budget/summary?days=${days}`);

export const fetchBudgetByAgent = (days = 30) =>
  get(`/budget/by-agent?days=${days}`);

export const fetchBudgetTimeline = (days = 7, groupBy = 'day') =>
  get(`/budget/timeline?days=${days}&groupBy=${groupBy}`);

export const fetchBudgetDaily = (days = 30) =>
  get(`/budget/daily?days=${days}`);

export const fetchBudgetConfig = () =>
  get('/budget/config');

export const updateBudgetConfig = (config) =>
  put('/budget/config', config);

export const fetchBudgetAlerts = () =>
  get('/budget/alerts');

export default api;

/* ── Task CRUD (board-level, uses /api/tasks/:id) ─────────────────────────── */
export const updateTask = (taskId, fields) =>
  put(`/tasks/${taskId}`, fields);

export const deleteTask = (taskId) =>
  del(`/tasks/${taskId}`);

export const clearTaskStopped = (taskId) =>
  patch(`/tasks/${taskId}/clear-stopped`);

/* ── Reorder tasks within a column ──────────────────────────────────── */
export const reorderTasks = (orderedIds) =>
  put('/tasks/reorder', { orderedIds });

/* ── Soft-delete management ──────────────────────────────────────────────── */
export const getDeletedTasks = () =>
  get('/tasks/deleted');

export const restoreTask = (taskId) =>
  post(`/tasks/${taskId}/restore`);

export const hardDeleteTask = (taskId) =>
  del(`/tasks/${taskId}/permanent`);

/* ── Commit diff ──────────────────────────────────────────────────────────── */
export const getCommitDiff = (taskId, hash) =>
  get(`/tasks/${taskId}/commits/${hash}/diff`);
