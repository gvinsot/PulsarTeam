const API_BASE = process.env.REACT_APP_API_URL || '';

async function request(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed: ${res.status}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    return res.json();
  }
  return null;
}

export const apiService = {
  getTasks() {
    return request('/api/tasks');
  },

  clearTasksByStatus(status) {
    return request('/api/tasks/clear', {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },
};