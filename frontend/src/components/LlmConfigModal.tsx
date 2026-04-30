import { useState } from 'react';
import { X, Save, Eye, EyeOff, Cpu } from 'lucide-react';

const PROVIDER_OPTIONS = ['anthropic', 'claude-paid', 'openai', 'google', 'deepseek', 'mistral', 'openrouter', 'vllm', 'ollama'];
const PROVIDER_LABELS = { 'claude-paid': 'Anthropic Paid Plan' };

interface LlmConfigModalProps {
  config: any;
  onSave: (config: any) => Promise<void>;
  onClose: () => void;
  saving: boolean;
}

export default function LlmConfigModal({ config, onSave, onClose, saving }: LlmConfigModalProps) {
  const [form, setForm] = useState({ ...config });
  const [showApiKey, setShowApiKey] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSave(form);
  };

  const isEditing = !!form.id;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[110] flex items-center justify-center p-4">
      <div className="bg-dark-900 border border-dark-700 rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between p-6 border-b border-dark-700">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
              <Cpu className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-100">{isEditing ? 'Edit LLM Config' : 'New LLM Config'}</h2>
              <p className="text-xs text-dark-400">{isEditing ? `Editing "${form.name}"` : 'Create a new LLM configuration'}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-auto p-6 space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-dark-400 mb-1">Name</label>
              <input type="text" value={form.name || ''} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="e.g. Claude Opus 4" required />
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">Provider</label>
              <select value={form.provider || ''} onChange={e => {
                  const prov = e.target.value;
                  const updates: any = { provider: prov, model: '' };
                  if (prov === 'claude-paid') { updates.endpoint = 'http://claudecode-service:8000'; updates.apiKey = ''; }
                  setForm(f => ({ ...f, ...updates }));
                }}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500" required>
                <option value="">Select provider...</option>
                {PROVIDER_OPTIONS.map(p => <option key={p} value={p}>{PROVIDER_LABELS[p] || p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">Model ID</label>
              <input type="text" value={form.model || ''} onChange={e => setForm(f => ({ ...f, model: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="e.g. claude-opus-4-20250514" required />
            </div>
            {form.provider !== 'claude-paid' && (
            <div>
              <label className="block text-xs text-dark-400 mb-1">Endpoint <span className="text-dark-500">(vLLM/Ollama only)</span></label>
              <input type="text" value={form.endpoint || ''} onChange={e => setForm(f => ({ ...f, endpoint: e.target.value }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="http://localhost:8000/v1" />
            </div>
            )}
            {form.provider === 'claude-paid' && (
            <div className="sm:col-span-2">
              <div className="px-3 py-2 bg-dark-800/50 border border-dark-700 rounded-lg text-xs text-dark-400">
                Authentication is handled via OAuth per agent (claudecode-service). No API key needed.
                Endpoint is auto-configured to <code className="text-indigo-400">claudecode-service:8000</code>.
              </div>
            </div>
            )}
            {form.provider !== 'claude-paid' && (
            <div className="relative">
              <label className="block text-xs text-dark-400 mb-1">API Key</label>
              <input type={showApiKey ? 'text' : 'password'}
                autoComplete="off"
                value={form.apiKey || ''} onChange={e => setForm(f => ({ ...f, apiKey: e.target.value }))}
                className="w-full px-3 py-2 pr-10 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="API key for this LLM" />
              <button type="button" onClick={() => setShowApiKey(v => !v)}
                className="absolute right-2 top-7 text-dark-400 hover:text-dark-200">
                {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            )}
            <div className="flex items-center gap-4 pt-5">
              <label className="flex items-center gap-2 text-sm text-dark-300 cursor-pointer">
                <input type="checkbox" checked={form.isReasoning || false} onChange={e => setForm(f => ({ ...f, isReasoning: e.target.checked }))}
                  className="rounded border-dark-600 bg-dark-900 text-indigo-500 focus:ring-indigo-500" />
                Reasoning model
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm text-dark-300 cursor-pointer">
              <input type="checkbox" checked={form.managesContext || false} onChange={e => setForm(f => ({ ...f, managesContext: e.target.checked }))}
                className="rounded border-dark-600 bg-dark-900 text-teal-500 focus:ring-teal-500" />
              Manages own context
            </label>
            <label className="flex items-center gap-2 text-sm text-dark-300 cursor-pointer">
              <input type="checkbox" checked={form.supportsImages || false} onChange={e => setForm(f => ({ ...f, supportsImages: e.target.checked }))}
                className="rounded border-dark-600 bg-dark-900 text-emerald-500 focus:ring-emerald-500" />
              Supports images
            </label>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-dark-400 mb-1">Context Size <span className="text-dark-500">(tokens)</span></label>
              <input type="number" min="1" value={form.contextSize ?? ''} onChange={e => setForm(f => ({ ...f, contextSize: e.target.value ? Number(e.target.value) : null }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="e.g. 200000" />
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">Max Output Tokens</label>
              <input type="number" min="1" value={form.maxOutputTokens ?? ''} onChange={e => setForm(f => ({ ...f, maxOutputTokens: e.target.value ? Number(e.target.value) : null }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="e.g. 16384" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <input
                  type="checkbox" checked={form.temperature != null}
                  onChange={e => setForm(f => ({ ...f, temperature: e.target.checked ? 0.7 : null }))}
                  className="rounded border-dark-600 bg-dark-900 text-indigo-500 focus:ring-indigo-500"
                />
                <label className="text-xs text-dark-400">
                  Temperature{form.temperature != null ? `: ${form.temperature}` : ' (disabled — model default)'}
                </label>
              </div>
              {form.temperature != null && (
                <input type="range" min="0" max="1" step="0.1" value={form.temperature}
                  onChange={e => setForm(f => ({ ...f, temperature: parseFloat(e.target.value) }))}
                  className="w-full accent-indigo-500" />
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-dark-400 mb-1">Cost / 1M input tokens ($)</label>
              <input type="number" step="0.01" min="0" value={form.costPerInputToken ?? ''} onChange={e => setForm(f => ({ ...f, costPerInputToken: e.target.value ? Number(e.target.value) : null }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="e.g. 15.00" />
            </div>
            <div>
              <label className="block text-xs text-dark-400 mb-1">Cost / 1M output tokens ($)</label>
              <input type="number" step="0.01" min="0" value={form.costPerOutputToken ?? ''} onChange={e => setForm(f => ({ ...f, costPerOutputToken: e.target.value ? Number(e.target.value) : null }))}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                placeholder="e.g. 75.00" />
            </div>
          </div>

          {/* Footer buttons */}
          <div className="flex justify-end gap-3 pt-2 border-t border-dark-700">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-dark-400 hover:text-dark-200 hover:bg-dark-800 rounded-lg transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 px-5 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors disabled:opacity-50">
              <Save className="w-4 h-4" />
              {saving ? 'Saving...' : isEditing ? 'Update' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
