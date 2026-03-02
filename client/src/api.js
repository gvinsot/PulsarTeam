const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3001/api';

function getToken() {
  return localStorage.getItem('token');
}

async function request(path, options = {}) {
  const token = getToken();
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed: ${res.status}`);
  return data;
}

export const api = {
  login: (username, password) =>
    request('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    }),

  verify: () => request('/auth/verify'),

  getAgents: () => request('/agents'),
  createAgent: (payload) => request('/agents', { method: 'POST', body: JSON.stringify(payload) }),
  updateAgent: (id, payload) => request(`/agents/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteAgent: (id) => request(`/agents/${id}`, { method: 'DELETE' }),

  getTemplates: () => request('/templates'),
  getProjects: () => request('/projects'),

  // Plugins (new canonical)
  getPlugins: () => request('/plugins'),
  getPlugin: (id) => request(`/plugins/${id}`),
  createPlugin: (payload) => request('/plugins', { method: 'POST', body: JSON.stringify(payload) }),
  updatePlugin: (id, payload) => request(`/plugins/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePlugin: (id) => request(`/plugins/${id}`, { method: 'DELETE' }),
  getPluginSettings: () => request('/plugins/settings'),
  savePluginSettings: (payload) => request('/plugins/settings', { method: 'PUT', body: JSON.stringify(payload) }),

  // Backward compatibility for existing UI
  getSkills: () => request('/plugins'),
  createSkill: (payload) => request('/plugins', { method: 'POST', body: JSON.stringify(payload) }),
  updateSkill: (id, payload) => request(`/plugins/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteSkill: (id) => request(`/plugins/${id}`, { method: 'DELETE' }),

  getMcpServers: () => request('/mcp-servers'),
  createMcpServer: (payload) => request('/mcp-servers', { method: 'POST', body: JSON.stringify(payload) }),
  updateMcpServer: (id, payload) => request(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteMcpServer: (id) => request(`/mcp-servers/${id}`, { method: 'DELETE' }),
  connectMcpServer: (id) => request(`/mcp-servers/${id}/connect`, { method: 'POST' })
};