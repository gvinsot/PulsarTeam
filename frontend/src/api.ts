const API_BASE = '/api';

function getHeaders() {
  const token = localStorage.getItem('token');
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };
}

async function handleResponse(res) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

export const api = {
  // Health
  getHealth: () =>
    fetch(`${API_BASE}/health`).then(res => res.json()),

  // Auth
  login: (username, password) =>
    fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }).then(handleResponse),

  verify: () =>
    fetch(`${API_BASE}/auth/verify`, { headers: getHeaders() }).then(handleResponse),

  // Google OAuth
  googleStatus: () =>
    fetch(`${API_BASE}/auth/google/status`).then(handleResponse),

  googleAuthUrl: (redirectUri) =>
    fetch(`${API_BASE}/auth/google/url?redirect_uri=${encodeURIComponent(redirectUri)}`).then(handleResponse),

  googleCallback: (code, redirectUri) =>
    fetch(`${API_BASE}/auth/google/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    }).then(handleResponse),

  // Microsoft OAuth
  microsoftStatus: () =>
    fetch(`${API_BASE}/auth/microsoft/status`).then(handleResponse),

  microsoftAuthUrl: (redirectUri) =>
    fetch(`${API_BASE}/auth/microsoft/url?redirect_uri=${encodeURIComponent(redirectUri)}`).then(handleResponse),

  microsoftCallback: (code, redirectUri) =>
    fetch(`${API_BASE}/auth/microsoft/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    }).then(handleResponse),

  // GitHub OAuth (login)
  githubAuthStatus: () =>
    fetch(`${API_BASE}/auth/github/status`).then(handleResponse),

  githubAuthUrl: (redirectUri) =>
    fetch(`${API_BASE}/auth/github/url?redirect_uri=${encodeURIComponent(redirectUri)}`).then(handleResponse),

  githubAuthCallback: (code, redirectUri) =>
    fetch(`${API_BASE}/auth/github/callback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, redirect_uri: redirectUri })
    }).then(handleResponse),

  // Agents
  getAgents: () =>
    fetch(`${API_BASE}/agents`, { headers: getHeaders() }).then(handleResponse),

  // Tasks (direct from tasks table)
  getAllTasks: (params = {}) => {
    const qs = new URLSearchParams(params).toString();
    return fetch(`${API_BASE}/tasks${qs ? '?' + qs : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getProjectStats: (days = 30) =>
    fetch(`${API_BASE}/tasks/project-stats?days=${days}`, { headers: getHeaders() }).then(handleResponse),

  getAgent: (id) =>
    fetch(`${API_BASE}/agents/${id}`, { headers: getHeaders() }).then(handleResponse),

  getAgentStatus: (id) =>
    fetch(`${API_BASE}/agents/${id}/status`, { headers: getHeaders() }).then(handleResponse),

  getSwarmStatus: () =>
    fetch(`${API_BASE}/agents/swarm-status`, { headers: getHeaders() }).then(handleResponse),

  getAgentStatuses: (project) => {
    const params = project ? `?project=${encodeURIComponent(project)}` : '';
    return fetch(`${API_BASE}/agents/statuses${params}`, { headers: getHeaders() }).then(handleResponse);
  },

  getAgentsByProject: (project) =>
    fetch(`${API_BASE}/agents/by-project/${encodeURIComponent(project)}`, { headers: getHeaders() }).then(handleResponse),

  getProjectSummary: () =>
    fetch(`${API_BASE}/agents/project-summary`, { headers: getHeaders() }).then(handleResponse),

  createAgent: (config) =>
    fetch(`${API_BASE}/agents`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(config)
    }).then(handleResponse),

  updateAgent: (id, updates) =>
    fetch(`${API_BASE}/agents/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates)
    }).then(handleResponse),

  deleteAgent: (id) =>
    fetch(`${API_BASE}/agents/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  stopAgent: (id) =>
    fetch(`${API_BASE}/agents/${id}/stop`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  chatAgent: (id, message) =>
    fetch(`${API_BASE}/agents/${id}/chat`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ message })
    }).then(handleResponse),

  getHistory: (id) =>
    fetch(`${API_BASE}/agents/${id}/history`, { headers: getHeaders() }).then(handleResponse),

  clearHistory: (id) =>
    fetch(`${API_BASE}/agents/${id}/history`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  truncateHistory: (id, afterIndex) =>
    fetch(`${API_BASE}/agents/${id}/history/after/${afterIndex}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  handoff: (fromId, targetAgentId, context) =>
    fetch(`${API_BASE}/agents/${fromId}/handoff`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ targetAgentId, context })
    }).then(handleResponse),

  broadcast: (message) =>
    fetch(`${API_BASE}/agents/broadcast/all`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ message })
    }).then(handleResponse),

  updateAllProjects: (project) =>
    fetch(`${API_BASE}/agents/project/all`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ project })
    }).then(handleResponse),

  // Tasks
  addTask: (agentId, text, status, boardId, repoFullName, recurrence, taskType, isManual, repoProvider = 'github', storagePath = null, storageProvider = 'onedrive') =>
    fetch(`${API_BASE}/agents/${agentId}/tasks`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        text,
        ...(status && { status }),
        ...(boardId && { boardId }),
        ...(repoFullName && { repoFullName, repoProvider }),
        ...(storagePath && { storagePath, storageProvider }),
        ...(recurrence && { recurrence }),
        ...(taskType && { taskType }),
        ...(isManual && { isManual }),
      })
    }).then(handleResponse),

  toggleTask: (agentId, taskId) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders()
    }).then(handleResponse),

  deleteTask: (agentId, taskId) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  clearTasks: (agentId) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  transferTask: (fromAgentId, taskId, targetAgentId) =>
    fetch(`${API_BASE}/agents/${fromAgentId}/tasks/${taskId}/transfer`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ targetAgentId })
    }).then(handleResponse),

  setTaskAssignee: (agentId, taskId, assigneeId) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}/assignee`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ assigneeId })
    }).then(handleResponse),

  refineTask: (agentId, taskId, refineAgentId) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}/refine`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ refineAgentId })
    }).then(handleResponse),

  setTaskStatus: (agentId, taskId, status) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status })
    }).then(handleResponse),

  updateTaskText: (agentId, taskId, text) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ text })
    }).then(handleResponse),

  updateTask: (agentId, taskId, fields) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify(fields)
    }).then(handleResponse),

  updateTaskRepo: (agentId, taskId, repoFullName, repoProvider = 'github') =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ repoFullName: repoFullName || null, repoProvider: repoFullName ? repoProvider : null })
    }).then(handleResponse),

  updateTaskStorage: (agentId, taskId, storagePath, storageProvider = 'onedrive') =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ storagePath: storagePath || null, storageProvider: storagePath ? storageProvider : null })
    }).then(handleResponse),

  addTaskCommit: (agentId, taskId, hash, message) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}/commits`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ hash, message })
    }).then(handleResponse),

  removeTaskCommit: (agentId, taskId, hash) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}/commits/${hash}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Action Logs
  clearActionLogs: (agentId) =>
    fetch(`${API_BASE}/agents/${agentId}/action-logs`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // RAG
  addRagDoc: (agentId, name, content) =>
    fetch(`${API_BASE}/agents/${agentId}/rag`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, content })
    }).then(handleResponse),

  addRagUrl: (agentId, name, url) =>
    fetch(`${API_BASE}/agents/${agentId}/rag/url`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, url })
    }).then(handleResponse),

  refreshRagDoc: (agentId, docId) =>
    fetch(`${API_BASE}/agents/${agentId}/rag/${docId}/refresh`, {
      method: 'POST',
      headers: getHeaders(),
    }).then(handleResponse),

  deleteRagDoc: (agentId, docId) =>
    fetch(`${API_BASE}/agents/${agentId}/rag/${docId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Plugins (unified skills + MCP)
  getPlugins: () =>
    fetch(`${API_BASE}/plugins`, { headers: getHeaders() }).then(handleResponse),

  createPlugin: (config) =>
    fetch(`${API_BASE}/plugins`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(config)
    }).then(handleResponse),

  updatePlugin: (id, updates) =>
    fetch(`${API_BASE}/plugins/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates)
    }).then(handleResponse),

  deletePlugin: (id) =>
    fetch(`${API_BASE}/plugins/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Plugin MCP server associations
  addPluginMcp: (pluginId, mcpId) =>
    fetch(`${API_BASE}/plugins/${pluginId}/mcps/${mcpId}`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  removePluginMcp: (pluginId, mcpId) =>
    fetch(`${API_BASE}/plugins/${pluginId}/mcps/${mcpId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Agent plugin assignment
  assignPlugin: (agentId, pluginId) =>
    fetch(`${API_BASE}/agents/${agentId}/plugins`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ pluginId })
    }).then(handleResponse),

  removePlugin: (agentId, pluginId) =>
    fetch(`${API_BASE}/agents/${agentId}/plugins/${pluginId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Backward compat aliases
  getSkills: () =>
    fetch(`${API_BASE}/plugins`, { headers: getHeaders() }).then(handleResponse),
  assignSkill: (agentId, skillId) =>
    fetch(`${API_BASE}/agents/${agentId}/plugins`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ pluginId: skillId })
    }).then(handleResponse),
  removeSkill: (agentId, skillId) =>
    fetch(`${API_BASE}/agents/${agentId}/plugins/${skillId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // MCP Servers (CRUD)
  getMcpServers: () =>
    fetch(`${API_BASE}/mcp-servers`, { headers: getHeaders() }).then(handleResponse),

  createMcpServer: (config) =>
    fetch(`${API_BASE}/mcp-servers`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(config)
    }).then(handleResponse),

  updateMcpServer: (id, updates) =>
    fetch(`${API_BASE}/mcp-servers/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates)
    }).then(handleResponse),

  deleteMcpServer: (id) =>
    fetch(`${API_BASE}/mcp-servers/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  connectMcpServer: (id) =>
    fetch(`${API_BASE}/mcp-servers/${id}/connect`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  testMcpServer: (id, apiKey) =>
    fetch(`${API_BASE}/mcp-servers/${id}/test`, {
      method: 'POST',
      headers: getHeaders(),
      body: apiKey ? JSON.stringify({ apiKey }) : undefined,
    }).then(handleResponse),

  // OneDrive OAuth (supports agentId or boardId)
  getOnedriveStatus: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/onedrive/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getOnedriveAuthUrl: (agentId?, boardId?, opts?: { consumer?: boolean }) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    if (opts?.consumer) params.set('consumer', '1');
    const qs = params.toString();
    return fetch(`${API_BASE}/onedrive/auth-url${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  onedriveCallback: (code, state) =>
    fetch(`${API_BASE}/onedrive/callback`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ code, state })
    }).then(handleResponse),

  disconnectOnedrive: (agentId?, boardId?) =>
    fetch(`${API_BASE}/onedrive/disconnect`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) })
    }).then(handleResponse),

  // Gmail OAuth (supports agentId or boardId)
  getGmailStatus: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/gmail/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getGmailAuthUrl: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/gmail/auth-url${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  gmailCallback: (code, state) =>
    fetch(`${API_BASE}/gmail/callback`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ code, state })
    }).then(handleResponse),

  disconnectGmail: (agentId?, boardId?) =>
    fetch(`${API_BASE}/gmail/disconnect`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) })
    }).then(handleResponse),

  // Outlook OAuth (supports agentId or boardId) — shares Microsoft OAuth client with OneDrive
  getOutlookStatus: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/outlook/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getOutlookAuthUrl: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/outlook/auth-url${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  outlookCallback: (code, state) =>
    fetch(`${API_BASE}/outlook/callback`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ code, state })
    }).then(handleResponse),

  disconnectOutlook: (agentId?, boardId?) =>
    fetch(`${API_BASE}/outlook/disconnect`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) })
    }).then(handleResponse),

  // Google Drive OAuth (supports agentId or boardId)
  getGdriveStatus: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/gdrive/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getGdriveAuthUrl: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/gdrive/auth-url${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  disconnectGdrive: (agentId?, boardId?) =>
    fetch(`${API_BASE}/gdrive/disconnect`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) })
    }).then(handleResponse),

  // Slack OAuth (supports agentId or boardId)
  getSlackStatus: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/slack/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getSlackAuthUrl: (agentId?, boardId?) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/slack/auth-url${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  slackCallback: (code, state) =>
    fetch(`${API_BASE}/slack/callback`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ code, state })
    }).then(handleResponse),

  disconnectSlack: (agentId?, boardId?) =>
    fetch(`${API_BASE}/slack/disconnect`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) })
    }).then(handleResponse),

  // Realtime (Voice)
  getRealtimeToken: (agentId) =>
    fetch(`${API_BASE}/realtime/token`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ agentId })
    }).then(handleResponse),

  // Templates
  getTemplates: () =>
    fetch(`${API_BASE}/templates`, { headers: getHeaders() }).then(handleResponse),

  // Admin: reset instructions by role
  resetInstructionsByRole: (role) =>
    fetch(`${API_BASE}/agents/reset-instructions/${encodeURIComponent(role)}`, {
      method: 'POST',
      headers: getHeaders(),
    }).then(handleResponse),

  // Projects (DB-backed)
  getProjects: () =>
    fetch(`${API_BASE}/projects`, { headers: getHeaders() }).then(handleResponse),

  getProject: (id) =>
    fetch(`${API_BASE}/projects/${id}`, { headers: getHeaders() }).then(handleResponse),

  createProject: (name, description = '', rules = '') =>
    fetch(`${API_BASE}/projects`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, description, rules })
    }).then(handleResponse),

  updateProject: (id, fields) =>
    fetch(`${API_BASE}/projects/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(fields)
    }).then(handleResponse),

  deleteProject: (id) =>
    fetch(`${API_BASE}/projects/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Project ↔ Board linking
  attachBoardToProject: (projectId, boardId) =>
    fetch(`${API_BASE}/projects/${projectId}/boards/${boardId}`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  detachBoardFromProject: (projectId, boardId) =>
    fetch(`${API_BASE}/projects/${projectId}/boards/${boardId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Board repos — read-only; derived from tasks on the board
  getBoardRepos: (boardId) =>
    fetch(`${API_BASE}/projects/boards/${boardId}/repos`, { headers: getHeaders() }).then(handleResponse),

  // Board storages — read-only; derived from tasks on the board
  getBoardStorages: (boardId) =>
    fetch(`${API_BASE}/projects/boards/${boardId}/storages`, { headers: getHeaders() }).then(handleResponse),

  // Storages accessible via the board's OneDrive plugin OAuth token (picker source)
  getBoardAvailableStorages: (boardId) =>
    fetch(`${API_BASE}/projects/boards/${boardId}/available-storages`, { headers: getHeaders() }).then(handleResponse),

  // Available repos from configured git connections (for the picker)
  getAvailableRepos: () =>
    fetch(`${API_BASE}/projects/available-repos`, { headers: getHeaders() }).then(handleResponse),

  // Available repos via the board's GitHub plugin OAuth token (for BoardReposPanel)
  getBoardAvailableRepos: (boardId) =>
    fetch(`${API_BASE}/projects/boards/${boardId}/available-repos`, { headers: getHeaders() }).then(handleResponse),

  // Code Index — auto-index project by name
  indexProject: (projectName) =>
    fetch(`${API_BASE}/code-index/index-project`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ projectName })
    }).then(handleResponse),

  // GitHub explorer — all endpoints authenticate via the board's GitHub plugin OAuth.
  getGitHubActivity: (owner, repo, boardId, opts = {}) => {
    const params = new URLSearchParams({ boardId });
    if (opts.refresh) params.set('refresh', '1');
    return fetch(`${API_BASE}/projects/github-activity/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?${params}`, {
      headers: getHeaders()
    }).then(handleResponse);
  },

  getGitHubBranches: (owner, repo, boardId) =>
    fetch(`${API_BASE}/projects/github-branches/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}?boardId=${encodeURIComponent(boardId)}`, {
      headers: getHeaders()
    }).then(handleResponse),

  getGitHubTree: (owner, repo, ref, boardId) =>
    fetch(`${API_BASE}/projects/github-tree/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}?boardId=${encodeURIComponent(boardId)}`, {
      headers: getHeaders()
    }).then(handleResponse),

  getGitHubFile: (owner, repo, ref, filePath, boardId) =>
    fetch(`${API_BASE}/projects/github-file/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${filePath}?boardId=${encodeURIComponent(boardId)}`, {
      headers: getHeaders()
    }).then(handleResponse),

  // API Key (MCP)
  getApiKeyInfo: () =>
    fetch(`${API_BASE}/settings/api-key`, { headers: getHeaders() }).then(handleResponse),

  generateApiKey: () =>
    fetch(`${API_BASE}/settings/api-key`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  revokeApiKey: () =>
    fetch(`${API_BASE}/settings/api-key`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // General settings
  getSettings: () =>
    fetch(`${API_BASE}/settings/general`, { headers: getHeaders() }).then(handleResponse),

  updateSettings: (patch) =>
    fetch(`${API_BASE}/settings/general`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(patch)
    }).then(handleResponse),

  // Reminder configuration
  getReminderConfig: () =>
    fetch(`${API_BASE}/settings/general/reminders`, { headers: getHeaders() }).then(handleResponse),

  updateReminderConfig: (patch) =>
    fetch(`${API_BASE}/settings/general/reminders`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(patch)
    }).then(handleResponse),

  // Workflow (read-only — default board workflow)
  getWorkflow: () =>
    fetch(`${API_BASE}/settings/general/workflow`, { headers: getHeaders() }).then(handleResponse),

  // Boards (per-user multi-board)
  getBoards: () =>
    fetch(`${API_BASE}/boards`, { headers: getHeaders() }).then(handleResponse),

  getAllBoardsAdmin: () =>
    fetch(`${API_BASE}/boards/all`, { headers: getHeaders() }).then(handleResponse),

  getBoard: (id) =>
    fetch(`${API_BASE}/boards/${id}`, { headers: getHeaders() }).then(handleResponse),

  createBoard: (name, workflow, filters) =>
    fetch(`${API_BASE}/boards`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, workflow, filters })
    }).then(handleResponse),

  updateBoard: (id, updates) =>
    fetch(`${API_BASE}/boards/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates)
    }).then(handleResponse),

  updateBoardWorkflow: (id, workflow) =>
    fetch(`${API_BASE}/boards/${id}/workflow`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(workflow)
    }).then(handleResponse),

  deleteBoard: (id) =>
    fetch(`${API_BASE}/boards/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Board plugins
  getBoardPlugins: (boardId) =>
    fetch(`${API_BASE}/boards/${boardId}/plugins`, { headers: getHeaders() }).then(handleResponse),

  assignBoardPlugin: (boardId, pluginId) =>
    fetch(`${API_BASE}/boards/${boardId}/plugins/assign`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ pluginId })
    }).then(handleResponse),

  removeBoardPlugin: (boardId, pluginId) =>
    fetch(`${API_BASE}/boards/${boardId}/plugins/remove`, {
      method: 'POST', headers: getHeaders(), body: JSON.stringify({ pluginId })
    }).then(handleResponse),

  updateBoardMcpAuth: (boardId, mcpAuth) =>
    fetch(`${API_BASE}/boards/${boardId}/mcp-auth`, {
      method: 'PUT', headers: getHeaders(), body: JSON.stringify(mcpAuth)
    }).then(handleResponse),

  // Board sharing
  getBoardShares: (boardId) =>
    fetch(`${API_BASE}/boards/${boardId}/shares`, { headers: getHeaders() }).then(handleResponse),

  shareBoardWith: (boardId, username, permission) =>
    fetch(`${API_BASE}/boards/${boardId}/shares`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ username, permission })
    }).then(handleResponse),

  updateBoardShare: (boardId, userId, permission) =>
    fetch(`${API_BASE}/boards/${boardId}/shares/${userId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ permission })
    }).then(handleResponse),

  removeBoardShare: (boardId, userId) =>
    fetch(`${API_BASE}/boards/${boardId}/shares/${userId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  getBoardUsers: () =>
    fetch(`${API_BASE}/boards/users`, { headers: getHeaders() }).then(handleResponse),

  getBoardAuditLogs: (boardId) =>
    fetch(`${API_BASE}/boards/${boardId}/audit`, { headers: getHeaders() }).then(handleResponse),

  getTasksByAssignee: (agentId) =>
    fetch(`${API_BASE}/boards/tasks/by-assignee/${agentId}`, { headers: getHeaders() }).then(handleResponse),

  // Project task stats
  getProjectTaskStats: (project) =>
    fetch(`${API_BASE}/agents/tasks/stats?project=${encodeURIComponent(project)}`, { headers: getHeaders() }).then(handleResponse),

  getProjectTimeSeries: (project, days = 30) =>
    fetch(`${API_BASE}/agents/tasks/stats/timeseries?project=${encodeURIComponent(project)}&days=${days}`, { headers: getHeaders() }).then(handleResponse),

  getProjectAgentTime: (project, days = 30) =>
    fetch(`${API_BASE}/agents/tasks/stats/agent-time?project=${encodeURIComponent(project)}&days=${days}`, { headers: getHeaders() }).then(handleResponse),

  getGlobalAgentTime: (days = 30) =>
    fetch(`${API_BASE}/agents/tasks/stats/agent-time?days=${days}`, { headers: getHeaders() }).then(handleResponse),

  // Jira (per-agent / per-board)
  getJiraStatus: (agentId?: string, boardId?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/jira/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  connectJira: (agentId: string, domain: string, email: string, apiToken: string, boardId?: string) =>
    fetch(`${API_BASE}/jira/connect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ agentId, domain, email, apiToken, ...(boardId && { boardId }) }),
    }).then(handleResponse),

  disconnectJira: (agentId?: string, boardId?: string) =>
    fetch(`${API_BASE}/jira/disconnect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) }),
    }).then(handleResponse),

  // WordPress (per-agent / per-board)
  getWordPressStatus: (agentId?: string, boardId?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/wordpress/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  connectWordPress: (agentId: string, siteUrl: string, username: string, applicationPassword: string, boardId?: string) =>
    fetch(`${API_BASE}/wordpress/connect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ agentId, siteUrl, username, applicationPassword, ...(boardId && { boardId }) }),
    }).then(handleResponse),

  disconnectWordPress: (agentId?: string, boardId?: string) =>
    fetch(`${API_BASE}/wordpress/disconnect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) }),
    }).then(handleResponse),

  // AWS S3 (per-agent / per-board)
  getS3Status: (agentId?: string, boardId?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/s3/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  connectS3: (agentId: string, secretAccessKey: string, accessKeyId: string, region: string, boardId?: string, endpoint?: string) =>
    fetch(`${API_BASE}/s3/connect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ agentId, accessKeyId, secretAccessKey, region, ...(boardId && { boardId }), ...(endpoint && { endpoint }) }),
    }).then(handleResponse),

  disconnectS3: (agentId?: string, boardId?: string) =>
    fetch(`${API_BASE}/s3/disconnect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) }),
    }).then(handleResponse),

  // GitHub OAuth (per-agent / per-board)
  getGitHubStatus: (agentId?: string, boardId?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/github/status${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  getGitHubAuthUrl: (agentId?: string, boardId?: string) => {
    const params = new URLSearchParams();
    if (agentId) params.set('agentId', agentId);
    if (boardId) params.set('boardId', boardId);
    const qs = params.toString();
    return fetch(`${API_BASE}/github/auth-url${qs ? `?${qs}` : ''}`, { headers: getHeaders() }).then(handleResponse);
  },

  githubCallback: (code: string, state: string) =>
    fetch(`${API_BASE}/github/callback`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ code, state })
    }).then(handleResponse),

  disconnectGitHub: (agentId?: string, boardId?: string) =>
    fetch(`${API_BASE}/github/disconnect`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ ...(agentId && { agentId }), ...(boardId && { boardId }) }),
    }).then(handleResponse),

  // Users (admin only)
  getUsers: () =>
    fetch(`${API_BASE}/users`, { headers: getHeaders() }).then(handleResponse),

  createUser: (data) =>
    fetch(`${API_BASE}/users`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(data)
    }).then(handleResponse),

  updateUser: (id, updates) =>
    fetch(`${API_BASE}/users/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates)
    }).then(handleResponse),

  deleteUser: (id) =>
    fetch(`${API_BASE}/users/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Impersonation (admin only)
  impersonate: (userId) =>
    fetch(`${API_BASE}/auth/impersonate/${userId}`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  // LLM Configs (admin only)
  getLlmConfigs: () =>
    fetch(`${API_BASE}/llm-configs`, { headers: getHeaders() }).then(handleResponse),

  createLlmConfig: (data) =>
    fetch(`${API_BASE}/llm-configs`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(data)
    }).then(handleResponse),

  updateLlmConfig: (id, data) =>
    fetch(`${API_BASE}/llm-configs/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(data)
    }).then(handleResponse),

  deleteLlmConfig: (id) =>
    fetch(`${API_BASE}/llm-configs/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  // Contact form (public — no auth)
  submitContact: (data: { email: string; phone: string; name?: string; company?: string; message?: string; type: 'contact' | 'support' }) =>
    fetch(`${API_BASE}/contact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }).then(handleResponse),
};

// Budget
export const fetchBudgetSummary = (days = 1) =>
  fetch(`${API_BASE}/budget/summary?days=${days}`, { headers: getHeaders() }).then(handleResponse);

export const fetchBudgetByAgent = (days = 30) =>
  fetch(`${API_BASE}/budget/by-agent?days=${days}`, { headers: getHeaders() }).then(handleResponse);

export const fetchBudgetTimeline = (days = 7, groupBy = 'day') =>
  fetch(`${API_BASE}/budget/timeline?days=${days}&groupBy=${groupBy}`, { headers: getHeaders() }).then(handleResponse);

export const fetchBudgetDaily = (days = 30) =>
  fetch(`${API_BASE}/budget/daily?days=${days}`, { headers: getHeaders() }).then(handleResponse);

export const fetchBudgetConfig = () =>
  fetch(`${API_BASE}/budget/config`, { headers: getHeaders() }).then(handleResponse);

export const updateBudgetConfig = (config) =>
  fetch(`${API_BASE}/budget/config`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(config)
  }).then(handleResponse);

export const fetchBudgetAlerts = () =>
  fetch(`${API_BASE}/budget/alerts`, { headers: getHeaders() }).then(handleResponse);

export default api;

/* ── Task CRUD (board-level, uses /api/tasks/:id) ─────────────────────────── */
export const updateTask = (taskId, fields) =>
  fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify(fields),
  }).then(handleResponse);

export const deleteTask = (taskId) =>
  fetch(`${API_BASE}/tasks/${taskId}`, {
    method: 'DELETE',
    headers: getHeaders(),
  }).then(handleResponse);

export const clearTaskStopped = (taskId) =>
  fetch(`${API_BASE}/tasks/${taskId}/clear-stopped`, {
    method: 'PATCH',
    headers: getHeaders(),
  }).then(handleResponse);

/* ── Reorder tasks within a column ──────────────────────────────────── */
export const reorderTasks = (orderedIds) =>
  fetch(`${API_BASE}/tasks/reorder`, {
    method: 'PUT',
    headers: getHeaders(),
    body: JSON.stringify({ orderedIds }),
  }).then(handleResponse);

/* ── Bulk move ─────────────────────────────────────────────────────────── */
export const bulkMoveTasks = (taskIds, boardId, column) =>
  fetch(`${API_BASE}/tasks/bulk-move`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ taskIds, boardId, column }),
  }).then(handleResponse);

/* ── Soft-delete management ──────────────────────────────────────────────── */
export const getDeletedTasks = () =>
  fetch(`${API_BASE}/tasks/deleted`, {
    headers: getHeaders(),
  }).then(handleResponse);

export const restoreTask = (taskId) =>
  fetch(`${API_BASE}/tasks/${taskId}/restore`, {
    method: 'POST',
    headers: getHeaders(),
  }).then(handleResponse);

export const hardDeleteTask = (taskId) =>
  fetch(`${API_BASE}/tasks/${taskId}/permanent`, {
    method: 'DELETE',
    headers: getHeaders(),
  }).then(handleResponse);

/* ── Boards (standalone export for TaskModal) ────────────────────────────── */
export const getBoards = () =>
  fetch(`${API_BASE}/boards`, { headers: getHeaders() }).then(handleResponse);

/* ── Commit diff ──────────────────────────────────────────────────────────── */
export const getCommitDiff = (taskId, hash) =>
  fetch(`${API_BASE}/tasks/${taskId}/commits/${hash}/diff`, {
    headers: getHeaders(),
  }).then(handleResponse);