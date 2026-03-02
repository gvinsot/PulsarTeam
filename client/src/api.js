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
  login: (username, password) =>
    fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    }).then(handleResponse),

  verify: () =>
    fetch(`${API_BASE}/auth/verify`, { headers: getHeaders() }).then(handleResponse),

  getAgents: () =>
    fetch(`${API_BASE}/agents`, { headers: getHeaders() }).then(handleResponse),

  getAgent: (id) =>
    fetch(`${API_BASE}/agents/${id}`, { headers: getHeaders() }).then(handleResponse),

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

  addTodo: (agentId, text) =>
    fetch(`${API_BASE}/agents/${agentId}/todos`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ text })
    }).then(handleResponse),

  toggleTodo: (agentId, todoId) =>
    fetch(`${API_BASE}/agents/${agentId}/todos/${todoId}`, {
      method: 'PATCH',
      headers: getHeaders()
    }).then(handleResponse),

  deleteTodo: (agentId, todoId) =>
    fetch(`${API_BASE}/agents/${agentId}/todos/${todoId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  clearActionLogs: (agentId) =>
    fetch(`${API_BASE}/agents/${agentId}/action-logs`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

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

  getPlugins: () =>
    fetch(`${API_BASE}/plugins`, { headers: getHeaders() }).then(handleResponse),

  getSkills: () =>
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

  createSkill: (config) =>
    fetch(`${API_BASE}/plugins`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify(config)
    }).then(handleResponse),

  updateSkill: (id, updates) =>
    fetch(`${API_BASE}/plugins/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify(updates)
    }).then(handleResponse),

  deleteSkill: (id) =>
    fetch(`${API_BASE}/plugins/${id}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  assignSkill: (agentId, skillId) =>
    fetch(`${API_BASE}/agents/${agentId}/skills`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ skillId })
    }).then(handleResponse),

  removeSkill: (agentId, skillId) =>
    fetch(`${API_BASE}/agents/${agentId}/skills/${skillId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

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

  assignMcpServer: (agentId, serverId) =>
    fetch(`${API_BASE}/agents/${agentId}/mcp-servers`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ serverId })
    }).then(handleResponse),

  removeMcpServer: (agentId, serverId) =>
    fetch(`${API_BASE}/agents/${agentId}/mcp-servers/${serverId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  attachMcpToPlugin: (pluginId, mcpId) =>
    fetch(`${API_BASE}/plugins/${pluginId}/mcps/${mcpId}`, {
      method: 'POST',
      headers: getHeaders()
    }).then(handleResponse),

  detachMcpFromPlugin: (pluginId, mcpId) =>
    fetch(`${API_BASE}/plugins/${pluginId}/mcps/${mcpId}`, {
      method: 'DELETE',
      headers: getHeaders()
    }).then(handleResponse),

  getRealtimeToken: (agentId) =>
    fetch(`${API_BASE}/realtime/token`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ agentId })
    }).then(handleResponse),

  getTemplates: () =>
    fetch(`${API_BASE}/templates`, { headers: getHeaders() }).then(handleResponse),

  getProjects: () =>
    fetch(`${API_BASE}/projects`, { headers: getHeaders() }).then(handleResponse),
};