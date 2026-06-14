import { useState, useEffect, useCallback } from 'react';
import { Cpu, Plus, Trash2, Edit3 } from 'lucide-react';
import { api } from '../../api';
import LlmConfigModal from '../LlmConfigModal';

// `active` flips true when the LLM Models tab is selected; each activation
// re-fetches the LLM configs.
export default function LlmConfigsTab({ active, showToast }) {
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [llmLoading, setLlmLoading] = useState(false);
  const [llmForm, setLlmForm] = useState(null); // null = closed, {} = new, {id} = editing
  const [llmSaving, setLlmSaving] = useState(false);

  const loadLlmConfigs = useCallback(async () => {
    try {
      setLlmLoading(true);
      const data = await api.getLlmConfigs();
      setLlmConfigs(data);
    } catch (err) {
      showToast?.(`Failed to load LLM configs: ${err.message}`, 'error');
    } finally {
      setLlmLoading(false);
    }
  }, [showToast]);

  useEffect(() => { if (active) loadLlmConfigs(); }, [active, loadLlmConfigs]);

  const handleSaveLlmConfig = async (formData) => {
    try {
      setLlmSaving(true);
      if (formData.id) {
        await api.updateLlmConfig(formData.id, formData);
      } else {
        await api.createLlmConfig(formData);
      }
      setLlmForm(null);
      showToast?.(formData.id ? 'LLM config updated' : 'LLM config created', 'success');
      loadLlmConfigs();
    } catch (err) {
      showToast?.(`Failed to save LLM config: ${err.message}`, 'error');
    } finally {
      setLlmSaving(false);
    }
  };

  const handleDeleteLlmConfig = async (config) => {
    if (!confirm(`Delete LLM config "${config.name}"? Agents using it will fall back to legacy settings.`)) return;
    try {
      await api.deleteLlmConfig(config.id);
      showToast?.('LLM config deleted', 'success');
      loadLlmConfigs();
    } catch (err) {
      showToast?.(`Failed to delete: ${err.message}`, 'error');
    }
  };

  return (<>
    <div className="flex items-center justify-between">
      <h3 className="text-sm font-semibold text-dark-300 uppercase tracking-wider flex items-center gap-2">
        <Cpu className="w-4 h-4" />
        LLM Configurations ({llmConfigs.length})
      </h3>
      <button
        onClick={() => setLlmForm({ name: '', provider: 'anthropic', model: '', endpoint: '', apiKey: '', isReasoning: false, managesContext: false, temperature: null, contextSize: null, maxOutputTokens: null, costPerInputToken: null, costPerOutputToken: null })}
        className="flex items-center gap-2 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm font-medium transition-colors"
      >
        <Plus className="w-4 h-4" />
        New LLM
      </button>
    </div>

    {/* LLM Create/Edit Modal */}
    {llmForm && (
      <LlmConfigModal
        config={llmForm}
        onSave={handleSaveLlmConfig}
        onClose={() => setLlmForm(null)}
        saving={llmSaving}
      />
    )}

    {/* LLM Config List */}
    {llmLoading ? (
      <div className="text-center py-8">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin mx-auto" />
      </div>
    ) : llmConfigs.length === 0 ? (
      <div className="text-center py-12 text-dark-400">
        <Cpu className="w-12 h-12 mx-auto mb-3 opacity-30" />
        <p className="text-sm">No LLM configurations yet.</p>
        <p className="text-xs mt-1">Create one to make it available for your agents.</p>
      </div>
    ) : (
      <div className="space-y-2">
        {llmConfigs.map(config => (
          <div key={config.id} className="flex items-center justify-between p-4 bg-dark-800 rounded-xl border border-dark-700 hover:border-dark-600 transition-colors">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium text-dark-100">{config.name}</span>
                {config.isReasoning && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400">Reasoning</span>
                )}
              </div>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-xs text-dark-400 capitalize">{config.provider}</span>
                <span className="text-xs text-dark-500">{config.model}</span>
                {config.managesContext && (
                  <span className="ml-1 px-1.5 py-0.5 text-[10px] rounded bg-teal-500/10 text-teal-400 border border-teal-500/20">Managed Context</span>
                )}
                {config.endpoint && <span className="text-xs text-dark-600 truncate max-w-[200px]">{config.endpoint}</span>}
                {config.contextSize && <span className="text-xs text-dark-500">{(config.contextSize / 1000).toFixed(0)}k ctx</span>}
                {config.maxOutputTokens && <span className="text-xs text-dark-500">{(config.maxOutputTokens / 1000).toFixed(0)}k out</span>}
                {config.temperature != null && <span className="text-xs text-dark-500">temp {config.temperature}</span>}
                {config.costPerInputToken != null && (
                  <span className="text-xs text-dark-500">${config.costPerInputToken}/{config.costPerOutputToken} per 1M</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1 flex-shrink-0">
              <button onClick={() => setLlmForm({ ...config })}
                className="p-2 text-dark-400 hover:text-indigo-400 hover:bg-dark-700 rounded-lg transition-colors" title="Edit">
                <Edit3 className="w-4 h-4" />
              </button>
              <button onClick={() => handleDeleteLlmConfig(config)}
                className="p-2 text-dark-400 hover:text-red-400 hover:bg-dark-700 rounded-lg transition-colors" title="Delete">
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>
    )}

    <div className="p-4 bg-dark-800/50 rounded-xl border border-dark-700">
      <p className="text-xs text-dark-400">
        LLM configurations are shared across the team. When you assign an LLM to an agent, it uses the provider, model, and API key from this configuration.
        Agents can still override the API key in their own settings.
      </p>
    </div>
  </>);
}
