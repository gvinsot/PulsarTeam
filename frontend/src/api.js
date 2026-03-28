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

  // Agents
  getAgents: () =>
    fetch(`${API_BASE}/agents`, { headers: getHeaders() }).then(handleResponse),

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
  addTask: (agentId, text, project, status, boardId, recurrence) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ text, ...(project !== undefined && { project }), ...(status && { status }), ...(boardId && { boardId }), ...(recurrence && { recurrence }) })
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

  updateTaskProject: (agentId, taskId, project) =>
    fetch(`${API_BASE}/agents/${agentId}/tasks/${taskId}`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ project: project || '' })
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

  // OneDrive OAuth
  getOnedriveStatus: () =>
    fetch(`${API_BASE}/onedrive/status`, { headers: getHeaders() }).then(handleResponse),

  getOnedriveAuthUrl: () =>
    fetch(`${API_BASE}/onedrive/auth-url`, { headers: getHeaders() }).then(handleResponse),

  onedriveCallback: (code) =>
    fetch(`${API_BASE}/onedrive/callback`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ code })
    }).then(handleResponse),

  disconnectOnedrive: () =>
    fetch(`${API_BASE}/onedrive/disconnect`, {
      method: 'POST',
      headers: getHeaders()
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

  // Projects (GitHub starred repos)
  getProjects: () =>
    fetch(`${API_BASE}/projects`, { headers: getHeaders() }).then(handleResponse),

  // Code Index — auto-index project by name
  indexProject: (projectName) =>
    fetch(`${API_BASE}/code-index/index-project`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ projectName })
    }).then(handleResponse),

  // Project Contexts (description + rules per project)
  getProjectContexts: () =>
    fetch(`${API_BASE}/project-contexts`, { headers: getHeaders() }).then(handleResponse),

  saveProjectContext: (name, description, rules) =>
    fetch(`${API_BASE}/project-contexts/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ description, rules })
    }).then(handleResponse),

  deleteProjectContext: (name) =>
    fetch(`${API_BASE}/project-contexts/${encodeURIComponent(name)}`, {
      method: 'DELETE',
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

  // Workflow
  getWorkflow: () =>
    fetch(`${API_BASE}/settings/general/workflow`, { headers: getHeaders() }).then(handleResponse),

  updateWorkflow: (workflow) =>
    fetch(`${API_BASE}/settings/general/workflow`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(workflow)
    }).then(handleResponse),

  // Boards (per-user multi-board)
  getBoards: () =>
    fetch(`${API_BASE}/boards`, { headers: getHeaders() }).then(handleResponse),

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

  getTasksByAssignee: (agentId) =>
    fetch(`${API_BASE}/boards/tasks/by-assignee/${agentId}`, { headers: getHeaders() }).then(handleResponse),

  // Project task stats
  getProjectTaskStats: (project) =>
    fetch(`${API_BASE}/agents/tasks/stats?project=${encodeURIComponent(project)}`, { headers: getHeaders() }).then(handleResponse),

  getProjectTimeSeries: (project, days = 30) =>
    fetch(`${API_BASE}/agents/tasks/stats/timeseries?project=${encodeURIComponent(project)}&days=${days}`, { headers: getHeaders() }).then(handleResponse),

  // Jira
  getJiraStatus: () =>
    fetch(`${API_BASE}/jira/status`, { headers: getHeaders() }).then(handleResponse),

  triggerJiraSync: () =>
    fetch(`${API_BASE}/jira/sync`, {
      method: 'POST',
      headers: getHeaders(),
    }).then(handleResponse),

  getJiraColumns: () =>
    fetch(`${API_BASE}/jira/columns`, { headers: getHeaders() }).then(handleResponse),

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
