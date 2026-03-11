import { useState, useEffect } from 'react';
import { X, Key, Copy, RefreshCw, Trash2, Eye, EyeOff, Shield } from 'lucide-react';
import { api } from '../api';

export default function ApiKeyModal({ onClose, showToast }) {
  const [keyInfo, setKeyInfo] = useState(null);
  const [newKey, setNewKey] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    loadKeyInfo();
  }, []);

  const loadKeyInfo = async () => {
    try {
      setLoading(true);
      const data = await api.getApiKeyInfo();
      setKeyInfo(data.apiKey);
    } catch (err) {
      showToast?.('Failed to load API key info', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleGenerate = async () => {
    try {
      const data = await api.generateApiKey();
      setNewKey(data.key);
      setKeyInfo({ id: data.id, prefix: data.prefix, created_at: new Date().toISOString() });
      setShowKey(true);
      showToast?.('API key generated', 'success');
    } catch (err) {
      showToast?.('Failed to generate API key', 'error');
    }
  };

  const handleRevoke = async () => {
    try {
      await api.revokeApiKey();
      setKeyInfo(null);
      setNewKey(null);
      showToast?.('API key revoked', 'success');
    } catch (err) {
      showToast?.('Failed to revoke API key', 'error');
    }
  };

  const handleCopy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast?.('Failed to copy', 'error');
    }
  };

  const mcpEndpoint = `${window.location.origin}/api/swarm/mcp`;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b border-dark-700">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-100">MCP API Key</h2>
              <p className="text-xs text-dark-400">Secure external access to your swarm</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-5">
          {/* MCP Endpoint */}
          <div>
            <label className="block text-sm font-medium text-dark-300 mb-2">MCP Endpoint</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-sm text-dark-200 font-mono truncate">
                {mcpEndpoint}
              </code>
              <button
                onClick={() => handleCopy(mcpEndpoint)}
                className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
                title="Copy endpoint"
              >
                <Copy className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Current key status */}
          {loading ? (
            <div className="text-center py-4 text-dark-400 text-sm">Loading...</div>
          ) : keyInfo ? (
            <div className="space-y-3">
              <label className="block text-sm font-medium text-dark-300">Active Key</label>

              {/* Show newly generated key */}
              {newKey ? (
                <div className="space-y-2">
                  <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
                    <p className="text-xs text-emerald-400 mb-2 font-medium">
                      Copy this key now — it won't be shown again.
                    </p>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-dark-800 border border-dark-700 rounded px-2 py-1.5 text-sm font-mono text-dark-200 truncate">
                        {showKey ? newKey : '••••••••••••••••••••••••'}
                      </code>
                      <button
                        onClick={() => setShowKey(!showKey)}
                        className="p-1.5 text-dark-400 hover:text-dark-100 rounded transition-colors"
                      >
                        {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                      <button
                        onClick={() => handleCopy(newKey)}
                        className={`p-1.5 rounded transition-colors ${
                          copied ? 'text-emerald-400' : 'text-dark-400 hover:text-dark-100'
                        }`}
                      >
                        <Copy className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5">
                  <Key className="w-4 h-4 text-dark-400" />
                  <code className="text-sm font-mono text-dark-300">{keyInfo.prefix}</code>
                  <span className="text-xs text-dark-500 ml-auto">
                    {new Date(keyInfo.created_at).toLocaleDateString()}
                  </span>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2">
                <button
                  onClick={handleGenerate}
                  className="flex items-center gap-2 px-3 py-2 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-sm transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Regenerate
                </button>
                <button
                  onClick={handleRevoke}
                  className="flex items-center gap-2 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  Revoke
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <p className="text-sm text-dark-400">
                No API key configured. Generate one to allow external MCP clients to access your swarm.
              </p>
              <button
                onClick={handleGenerate}
                className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white rounded-lg text-sm font-medium transition-all shadow-lg shadow-emerald-500/20"
              >
                <Key className="w-4 h-4" />
                Generate API Key
              </button>
            </div>
          )}

          {/* MCP Tools */}
          <div className="border-t border-dark-700 pt-4">
            <h3 className="text-sm font-medium text-dark-300 mb-2">MCP Tools</h3>
            <ul className="space-y-1.5 text-xs text-dark-400">
              <li className="flex items-start gap-2">
                <span className="text-indigo-400 mt-0.5">list_agents</span>
                <span>— List all agents with status and project</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-indigo-400 mt-0.5">get_agent_status</span>
                <span>— Get detailed status, tasks, and metrics for an agent</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-indigo-400 mt-0.5">add_task</span>
                <span>— Add a task to an agent (auto-executed when idle)</span>
              </li>
            </ul>
          </div>

          {/* REST API */}
          <div className="border-t border-dark-700 pt-4">
            <h3 className="text-sm font-medium text-dark-300 mb-2">REST API</h3>
            <p className="text-xs text-dark-500 mb-2">Same API key, same header: <code className="text-dark-400">Authorization: Bearer &lt;key&gt;</code></p>
            <ul className="space-y-1.5 text-xs text-dark-400">
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-mono mt-0.5">GET</span>
                <span><code className="text-dark-300">/api/swarm/agents</code> — List agents (query: ?project=X&status=idle)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-emerald-400 font-mono mt-0.5">GET</span>
                <span><code className="text-dark-300">/api/swarm/agents/:id</code> — Agent details (id or name)</span>
              </li>
              <li className="flex items-start gap-2">
                <span className="text-amber-400 font-mono mt-0.5">POST</span>
                <span><code className="text-dark-300">/api/swarm/agents/:id/tasks</code> — Add task {"{"}"task": "...", "project": "..."{"}"}</span>
              </li>
            </ul>
          </div>

          {/* MCP config example */}
          <div className="border-t border-dark-700 pt-4">
            <h3 className="text-sm font-medium text-dark-300 mb-2">MCP Client Config</h3>
            <pre className="bg-dark-800 border border-dark-700 rounded-lg p-3 text-xs font-mono text-dark-300 overflow-x-auto whitespace-pre">
{`{
  "mcpServers": {
    "agent-swarm": {
      "url": "${mcpEndpoint}",
      "headers": {
        "Authorization": "Bearer <your-api-key>"
      }
    }
  }
}`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
