import { useState, useEffect } from 'react';
import { Save, Trash2, RotateCw } from 'lucide-react';
import { api } from '../../api';
import CodexAuthSection from './CodexAuthSection';

export default function SettingsTab({ agent, projects, currentProject, onRefresh, userRole, currentUser }) {
  const [form, setForm] = useState({
    name: agent.name,
    role: agent.role,
    description: agent.description,
    llmConfigId: agent.llmConfigId || '',
    icon: agent.icon,
    color: agent.color,
    project: agent.project || '',
    enabled: agent.enabled !== false,
    costPerInputToken: agent.costPerInputToken ?? '',
    costPerOutputToken: agent.costPerOutputToken ?? '',
    boardId: agent.boardId || '',
    runner: agent.runner || '',
  });
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [boards, setBoards] = useState([]);

  useEffect(() => {
    api.getLlmConfigs().then(setLlmConfigs).catch(() => {});
    api.getBoards().then(setBoards).catch(() => {});
  }, []);

  // Reset form when switching agents
  useEffect(() => {
    setForm({
      name: agent.name,
      role: agent.role,
      description: agent.description,
      llmConfigId: agent.llmConfigId || '',
      icon: agent.icon,
      color: agent.color,
      project: agent.project || '',
      enabled: agent.enabled !== false,
      costPerInputToken: agent.costPerInputToken ?? '',
      costPerOutputToken: agent.costPerOutputToken ?? '',
      boardId: agent.boardId || '',
      runner: agent.runner || '',
    });
    setSaved(false);
  }, [agent.id]);

  useEffect(() => {
    setForm(prev => {
      const nextProject = currentProject || '';
      return prev.project === nextProject ? prev : { ...prev, project: nextProject };
    });
  }, [currentProject]);

  // Auto-select a runner based on the LLM config provider.
  // Mirrors the "Auto" option in the runner dropdown.
  const resolveAutoRunner = (llmConfigId) => {
    const sel = llmConfigs.find(c => c.id === llmConfigId);
    const provider = (sel?.provider || '').toLowerCase();
    if (provider === 'anthropic' || provider === 'claude' || provider === 'claude-paid') return 'claudecode';
    if (provider === 'openai') return 'codex';
    return 'sandbox';
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { ...form };
      payload.costPerInputToken = payload.costPerInputToken !== '' ? parseFloat(payload.costPerInputToken) || null : null;
      payload.costPerOutputToken = payload.costPerOutputToken !== '' ? parseFloat(payload.costPerOutputToken) || null : null;
      payload.llmConfigId = payload.llmConfigId || null;
      payload.boardId = payload.boardId || null;
      // "Auto" resolves to a concrete runner so the backend (which rejects null/empty) accepts it.
      payload.runner = payload.runner || resolveAutoRunner(payload.llmConfigId);
      await api.updateAgent(agent.id, payload);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`Delete agent "${agent.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    try {
      await api.deleteAgent(agent.id);
      onRefresh();
    } catch (err) {
      console.error(err);
    } finally {
      setDeleting(false);
    }
  };

  const updateField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <div className="p-4 space-y-4">
      {/* Enabled toggle */}
      <div className="flex items-center justify-between px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <div>
          <span className="text-sm text-dark-200">Agent enabled</span>
          <p className="text-[11px] text-dark-500 mt-0.5">Disabled agents are excluded from delegation, broadcast, and handoff</p>
        </div>
        <button
          onClick={async () => {
            const newEnabled = !form.enabled;
            updateField('enabled', newEnabled);
            try {
              await api.updateAgent(agent.id, { enabled: newEnabled });
              onRefresh();
            } catch (err) {
              console.error(err);
              updateField('enabled', !newEnabled);
            }
          }}
          className={`relative w-10 h-5 rounded-full transition-colors ${form.enabled ? 'bg-indigo-500' : 'bg-dark-600'}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full transition-transform ${form.enabled ? 'translate-x-5' : ''}`} />
        </button>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Name</label>
          <input
            type="text" value={form.name}
            onChange={(e) => updateField('name', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Role</label>
          <input
            type="text" value={form.role}
            onChange={(e) => updateField('role', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          />
        </div>
        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Icon</label>
          <input
            type="text" value={form.icon}
            onChange={(e) => updateField('icon', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
            maxLength={4}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Description</label>
          <textarea
            value={form.description}
            onChange={(e) => updateField('description', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 resize-none"
            rows={2}
          />
        </div>
        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">LLM Configuration</label>
          <select
            value={form.llmConfigId}
            onChange={(e) => updateField('llmConfigId', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">-- Select an LLM config --</option>
            {(agent.isVoice
              ? llmConfigs.filter(c => c.model && c.model.includes('gpt-realtime'))
              : llmConfigs
            ).map(c => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.provider}/{c.model})
              </option>
            ))}
          </select>
          {agent.isVoice && !llmConfigs.some(c => c.model && c.model.includes('gpt-realtime')) && (
            <p className="text-[11px] text-amber-400 mt-1">No realtime LLM config found. Create one with model "gpt-realtime-1.5" in Admin Settings.</p>
          )}
          {form.llmConfigId && (() => {
            const sel = llmConfigs.find(c => c.id === form.llmConfigId);
            return sel ? (
              <div className="mt-2 p-2.5 bg-dark-700/50 rounded-lg border border-dark-600/50 text-xs text-dark-400 space-y-0.5">
                <p><span className="text-dark-300">Provider:</span> {sel.provider}</p>
                <p><span className="text-dark-300">Model:</span> <span className="font-mono">{sel.model}</span></p>
                {sel.endpoint && <p><span className="text-dark-300">Endpoint:</span> <span className="font-mono">{sel.endpoint}</span></p>}
                {sel.isReasoning && <p><span className="text-dark-300">Reasoning:</span> Yes</p>}
                {sel.contextSize && <p><span className="text-dark-300">Context:</span> {(sel.contextSize / 1000).toFixed(0)}k tokens</p>}
                {sel.maxOutputTokens && <p><span className="text-dark-300">Max Output:</span> {(sel.maxOutputTokens / 1000).toFixed(0)}k tokens</p>}
                {sel.temperature != null && <p><span className="text-dark-300">Temperature:</span> {sel.temperature}</p>}
              </div>
            ) : null;
          })()}
          <p className="text-[11px] text-dark-500 mt-1">LLM configurations are managed in Admin Settings</p>
        </div>

        <div className="col-span-2">
          <label className="block text-xs text-dark-400 mb-1.5">Runner (execution backend)</label>
          <select
            value={form.runner}
            onChange={(e) => updateField('runner', e.target.value)}
            className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
          >
            <option value="">Auto (based on LLM config)</option>
            <option value="sandbox">Pulsar Agent (sandbox)</option>
            <option value="claudecode">Claude Code Agent</option>
            <option value="openclaw">OpenClaw Agent</option>
            <option value="hermes">Hermes Agent</option>
            <option value="opencode">OpenCode Agent</option>
            <option value="codex">OpenAI Codex Agent</option>
          </select>
          <p className="text-[11px] text-dark-500 mt-1">Choose the container runtime for this agent. "Auto" selects based on the LLM configuration.</p>
        </div>

        <div>
          <label className="block text-xs text-dark-400 mb-1.5">Color</label>
          <input
            type="color" value={form.color}
            onChange={(e) => updateField('color', e.target.value)}
            className="h-9 w-full rounded-lg border border-dark-600 cursor-pointer bg-dark-800"
          />
        </div>
      </div>

      {/* Board */}
      <div className="px-3 py-2.5 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <label className="block text-xs text-dark-400 mb-1.5">Board</label>
        <select
          value={form.boardId}
          onChange={(e) => updateField('boardId', e.target.value)}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
        >
          <option value="">No board (visible to all)</option>
          {boards.map(b => (
            <option key={b.id} value={b.id}>{b.name}{b.is_default ? ' (default)' : ''}</option>
          ))}
        </select>
        <p className="text-[11px] text-dark-500 mt-1">Agents are visible to all users who have access to the selected board. An agent without a board is visible to everyone.</p>
      </div>

      {/* Metrics */}
      <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50">
        <h4 className="text-xs font-medium text-dark-300 mb-2">Metrics</h4>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div>
            <p className="text-dark-500">Messages</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalMessages || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Tokens In</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalTokensIn || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Tokens Out</p>
            <p className="font-mono text-dark-200">{agent.metrics?.totalTokensOut || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Errors</p>
            <p className="font-mono text-dark-200">{agent.metrics?.errors || 0}</p>
          </div>
          <div>
            <p className="text-dark-500">Last Active</p>
            <p className="font-mono text-dark-200 text-[10px]">
              {agent.metrics?.lastActiveAt ? new Date(agent.metrics.lastActiveAt).toLocaleTimeString() : 'Never'}
            </p>
          </div>
          <div>
            <p className="text-dark-500">Created</p>
            <p className="font-mono text-dark-200 text-[10px]">
              {new Date(agent.createdAt).toLocaleDateString()}
            </p>
          </div>
        </div>
      </div>

      {(form.runner === 'codex' || resolveAutoRunner(form.llmConfigId) === 'codex') && (
        <CodexAuthSection
          ownerId={agent.ownerId || currentUser?.id || currentUser?.userId}
          currentUser={currentUser}
        />
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex-1 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
        >
          {saving ? (
            <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
          ) : saved ? (
            <>
              <span className="text-emerald-300">&#10003;</span> Saved!
            </>
          ) : (
            <>
              <Save className="w-4 h-4" /> Save Changes
            </>
          )}
        </button>
        <button
          onClick={async () => {
            if (!confirm('Reload agent context? This stops the agent and invalidates every cache (conversation, runner sessions, MCP connections, LLM config, file tree) so the next message picks up your latest configuration.')) return;
            await api.reloadContext(agent.id);
            onRefresh();
          }}
          className="px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/20 rounded-lg text-sm font-medium transition-colors"
          title="Reload context — invalidate all caches (conversation, model info, MCP, file tree) to apply config changes"
        >
          <RotateCw className="w-4 h-4" />
        </button>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className="px-4 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 border border-red-500/20 rounded-lg text-sm font-medium transition-colors"
        >
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
