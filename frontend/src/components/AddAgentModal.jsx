import { useState } from 'react';
import { X, Cpu, Search, FolderCode, Crown, Mic, Copy } from 'lucide-react';
import { api } from '../api';

export default function AddAgentModal({ templates, projects, agents = [], onClose, onCreated }) {
  const [step, setStep] = useState('choose'); // choose | template | custom
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [form, setForm] = useState({
    name: '',
    role: '',
    description: '',
    instructions: 'You are a helpful AI assistant.',
    provider: 'ollama',
    model: 'qwen3-coder-next:q4_K_M',
    endpoint: 'https://llm-dev.methodinfo.fr',
    apiKey: '',
    temperature: 0.7,
    temperatureEnabled: true,
    maxTokens: 128000,
    contextLength: 0,
    icon: '🤖',
    color: '#6366f1',
    project: '',
    isLeader: false,
    isVoice: false,
    isReasoning: false,
    voice: 'alloy',
  });
  const [creating, setCreating] = useState(false);

  const filteredTemplates = templates.filter(t =>
    t.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.role.toLowerCase().includes(searchQuery.toLowerCase()) ||
    t.description.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const applyTemplate = (template) => {
    setForm(prev => ({
      ...prev,
      name: template.name,
      role: template.role,
      description: template.description,
      instructions: template.instructions,
      temperature: template.temperature,
      temperatureEnabled: template.temperature != null,
      maxTokens: template.maxTokens,
      icon: template.icon,
      color: template.color,
      isLeader: template.isLeader || template.isVoice || false,
      isVoice: template.isVoice || false,
      voice: template.isVoice ? 'alloy' : prev.voice,
      ...(template.provider ? { provider: template.provider } : {}),
      ...(template.model ? { model: template.model } : {}),
    }));
    setSelectedTemplate(template);
    setStep('custom');
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const { temperatureEnabled, ...payload } = form;
      payload.temperature = temperatureEnabled ? payload.temperature : null;
      const agent = await api.createAgent({
        ...payload,
        template: selectedTemplate?.id || null,
      });
      onCreated(agent);
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  };

  const updateField = (key, value) => setForm(prev => ({ ...prev, [key]: value }));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="bg-dark-800 border border-dark-700 rounded-2xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-hidden animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-700">
          <h2 className="text-lg font-bold text-dark-100">
            {step === 'choose' ? 'Add New Agent' :
             step === 'template' ? 'Choose a Template' :
             selectedTemplate ? `New ${selectedTemplate.name}` : 'Custom Agent'}
          </h2>
          <button onClick={onClose} className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-auto max-h-[calc(90vh-130px)] p-6">
          {step === 'choose' && (
            <div className="space-y-4">
              <p className="text-sm text-dark-400">How would you like to create your agent?</p>
              <div className="grid grid-cols-2 gap-4">
                <button
                  onClick={() => setStep('template')}
                  className="p-6 bg-dark-700/50 border border-dark-600 rounded-xl hover:border-indigo-500/50 hover:bg-indigo-500/5 transition-all text-left group"
                >
                  <div className="text-3xl mb-3">📋</div>
                  <h3 className="font-semibold text-dark-100 mb-1 group-hover:text-indigo-400 transition-colors">From Template</h3>
                  <p className="text-xs text-dark-400">Choose from pre-configured agent templates for common roles</p>
                </button>
                <button
                  onClick={() => setStep('custom')}
                  className="p-6 bg-dark-700/50 border border-dark-600 rounded-xl hover:border-purple-500/50 hover:bg-purple-500/5 transition-all text-left group"
                >
                  <div className="text-3xl mb-3">⚡</div>
                  <h3 className="font-semibold text-dark-100 mb-1 group-hover:text-purple-400 transition-colors">Custom Agent</h3>
                  <p className="text-xs text-dark-400">Configure everything from scratch with full control</p>
                </button>
              </div>
            </div>
          )}

          {step === 'template' && (
            <div className="space-y-4">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-dark-400" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-dark-700 border border-dark-600 rounded-xl text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                  placeholder="Search templates..."
                  autoFocus
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                {filteredTemplates.map(template => (
                  <button
                    key={template.id}
                    onClick={() => applyTemplate(template)}
                    className="p-4 bg-dark-700/50 border border-dark-600 rounded-xl hover:border-indigo-500/50 hover:bg-dark-700 transition-all text-left group"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-2xl">{template.icon}</span>
                      <div>
                        <h3 className="font-semibold text-dark-100 text-sm group-hover:text-indigo-400 transition-colors">
                          {template.name}
                        </h3>
                        <span className="text-[11px] text-dark-400 capitalize">{template.role}</span>
                      </div>
                    </div>
                    <p className="text-xs text-dark-400 line-clamp-2">{template.description}</p>
                    <div className="flex items-center gap-2 mt-2 text-[11px] text-dark-500">
                      <span>Temp: {template.temperature}</span>
                    </div>
                  </button>
                ))}
              </div>

              <button
                onClick={() => setStep('choose')}
                className="text-sm text-dark-400 hover:text-dark-200 transition-colors"
              >
                ← Back
              </button>
            </div>
          )}

          {step === 'custom' && (
            <div className="space-y-4">
              {selectedTemplate && (
                <div className="flex items-center gap-2 px-3 py-2 bg-indigo-500/10 border border-indigo-500/20 rounded-lg text-xs text-indigo-400">
                  <span>{selectedTemplate.icon}</span>
                  Template: {selectedTemplate.name}
                  <button onClick={() => { setSelectedTemplate(null); setStep('template'); }} className="ml-auto hover:text-indigo-300">
                    Change
                  </button>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2">
                  <label className="block text-xs text-dark-400 mb-1.5">Agent Name *</label>
                  <input
                    type="text" value={form.name}
                    onChange={(e) => updateField('name', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                    placeholder="Give your agent a name"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">Role</label>
                  <input
                    type="text" value={form.role}
                    onChange={(e) => updateField('role', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    placeholder="e.g. developer, analyst"
                  />
                </div>
                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">Icon</label>
                  <input
                    type="text" value={form.icon}
                    onChange={(e) => updateField('icon', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    maxLength={4}
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs text-dark-400 mb-1.5">Description</label>
                  <textarea
                    value={form.description}
                    onChange={(e) => updateField('description', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 resize-none"
                    placeholder="What does this agent do?"
                    rows={2}
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs text-dark-400 mb-1.5">System Instructions</label>
                  <textarea
                    value={form.instructions}
                    onChange={(e) => updateField('instructions', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
                    placeholder="System prompt for the agent..."
                    rows={5}
                  />
                </div>

                <div className="col-span-2 border-t border-dark-700 pt-4">
                  <h4 className="text-xs font-medium text-dark-300 mb-3 flex items-center gap-2">
                    <FolderCode className="w-3.5 h-3.5" /> Project Context
                  </h4>
                </div>

                <div className="col-span-2">
                  <label className="block text-xs text-dark-400 mb-1.5">Working Project</label>
                  <select
                    value={form.project}
                    onChange={(e) => updateField('project', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">No project selected</option>
                    {projects.map(p => (
                      <option key={p.name} value={p.name}>{p.name}</option>
                    ))}
                  </select>
                  <p className="text-[11px] text-dark-500 mt-1">Select the project this agent will work on</p>
                </div>

                <div className="col-span-2">
                  <label className={`flex items-center gap-3 group ${form.isVoice ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={form.isLeader}
                      onChange={(e) => updateField('isLeader', e.target.checked)}
                      disabled={form.isVoice}
                      className="w-4 h-4 rounded border-dark-600 bg-dark-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-dark-800"
                    />
                    <div className="flex items-center gap-2">
                      <Crown className="w-4 h-4 text-amber-400" />
                      <span className="text-sm text-dark-200 group-hover:text-dark-100">Leader Agent</span>
                    </div>
                  </label>
                  <p className="text-[11px] text-dark-500 mt-1 ml-7">
                    {form.isVoice ? 'Locked — Voice agents are always leaders' : 'Leader agents orchestrate and coordinate other agents in the swarm'}
                  </p>
                </div>

                {(!selectedTemplate || selectedTemplate.isLeader || selectedTemplate.isVoice) && (
                <div className="col-span-2">
                  <label className="flex items-center gap-3 cursor-pointer group">
                    <input
                      type="checkbox"
                      checked={form.isVoice}
                      onChange={(e) => {
                        const isVoice = e.target.checked;
                        updateField('isVoice', isVoice);
                        if (isVoice) {
                          updateField('isLeader', true);
                          updateField('provider', 'openai');
                          updateField('model', 'gpt-realtime-1.5');
                        }
                      }}
                      className="w-4 h-4 rounded border-dark-600 bg-dark-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-dark-800"
                    />
                    <div className="flex items-center gap-2">
                      <Mic className="w-4 h-4 text-amber-400" />
                      <span className="text-sm text-dark-200 group-hover:text-dark-100">Voice Agent</span>
                    </div>
                  </label>
                  <p className="text-[11px] text-dark-500 mt-1 ml-7">Speech-to-speech agent using OpenAI Realtime API (forces Leader + OpenAI provider)</p>
                </div>
                )}

                {form.isVoice && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5">Voice</label>
                    <select
                      value={form.voice}
                      onChange={(e) => updateField('voice', e.target.value)}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                    >
                      <option value="alloy">Alloy</option>
                      <option value="ash">Ash</option>
                      <option value="ballad">Ballad</option>
                      <option value="coral">Coral</option>
                      <option value="echo">Echo</option>
                      <option value="sage">Sage</option>
                      <option value="shimmer">Shimmer</option>
                      <option value="verse">Verse</option>
                    </select>
                  </div>
                )}

                <div className="col-span-2 border-t border-dark-700 pt-4">
                  <h4 className="text-xs font-medium text-dark-300 mb-3 flex items-center gap-2">
                    <Cpu className="w-3.5 h-3.5" /> LLM Configuration
                  </h4>
                </div>

                {agents.length > 0 && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5 flex items-center gap-1.5">
                      <Copy className="w-3 h-3" /> Import config from existing agent
                    </label>
                    <select
                      onChange={(e) => {
                        const source = agents.find(a => a.id === e.target.value);
                        if (source) {
                          setForm(prev => ({
                            ...prev,
                            provider: source.provider || prev.provider,
                            model: source.model || prev.model,
                            endpoint: source.endpoint || prev.endpoint,
                            apiKey: source.apiKey || prev.apiKey,
                            temperature: source.temperature ?? prev.temperature,
                            temperatureEnabled: source.temperature != null,
                            maxTokens: source.maxTokens ?? prev.maxTokens,
                            contextLength: source.contextLength ?? prev.contextLength,
                          }));
                        }
                        e.target.value = '';
                      }}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      defaultValue=""
                    >
                      <option value="" disabled>Select an agent to copy its LLM settings...</option>
                      {agents.map(a => (
                        <option key={a.id} value={a.id}>
                          {a.icon} {a.name} — {a.provider}/{a.model}
                        </option>
                      ))}
                    </select>
                    <p className="text-[11px] text-dark-500 mt-1">Copies provider, model, endpoint, API key, temperature, max tokens and context length</p>
                  </div>
                )}

                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">Provider *</label>
                  <select
                    value={form.provider}
                    disabled={form.isVoice}
                    onChange={(e) => {
                      updateField('provider', e.target.value);
                      if (e.target.value === 'claude') {
                        updateField('model', 'claude-sonnet-4-20250514');
                        updateField('endpoint', '');
                      } else if (e.target.value === 'openai') {
                        updateField('model', 'gpt-4o');
                        updateField('endpoint', '');
                      } else if (e.target.value === 'mistral') {
                        updateField('model', 'mistral-large-latest');
                        updateField('endpoint', '');
                      } else if (e.target.value === 'vllm') {
                        updateField('model', '');
                        updateField('endpoint', 'http://localhost:8000');
                        updateField('apiKey', '');
                      } else if (e.target.value === 'claude-paid') {
                        updateField('model', 'claude-sonnet-4-20250514');
                        updateField('endpoint', '');
                        updateField('apiKey', '');
                      } else {
                        updateField('model', 'qwen3-coder-next:q4_K_M');
                        updateField('endpoint', 'https://llm-dev.methodinfo.fr');
                      }
                    }}
                    className={`w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 ${form.isVoice ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <option value="ollama">Ollama</option>
                    <option value="claude">Claude (Anthropic)</option>
                    <option value="openai">OpenAI</option>
                    <option value="mistral">Mistral AI</option>
                    <option value="vllm">vLLM</option>
                    <option value="claude-paid">Claude Paid Plan</option>
                  </select>
                  {form.isVoice && <p className="text-[11px] text-dark-500 mt-1">Locked — Voice agents use OpenAI Realtime</p>}
                </div>

                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">Model *</label>
                  <input
                    type="text" value={form.model}
                    onChange={(e) => updateField('model', e.target.value)}
                    disabled={form.isVoice}
                    className={`w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs ${form.isVoice ? 'opacity-50 cursor-not-allowed' : ''}`}
                  />
                  {form.isVoice && <p className="text-[11px] text-dark-500 mt-1">Locked — gpt-realtime-1.5</p>}
                </div>

                {form.provider === 'ollama' && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5">Endpoint URL</label>
                    <input
                      type="text" value={form.endpoint}
                      onChange={(e) => updateField('endpoint', e.target.value)}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                      placeholder="https://..."
                    />
                  </div>
                )}

                {form.provider === 'claude' && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5">API Key</label>
                    <input
                      type="password" value={form.apiKey}
                      onChange={(e) => updateField('apiKey', e.target.value)}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                      placeholder="sk-ant-..."
                    />
                    <p className="text-[11px] text-dark-500 mt-1">Leave blank to use server default key</p>
                  </div>
                )}

                {form.provider === 'openai' && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5">API Key</label>
                    <input
                      type="password" value={form.apiKey}
                      onChange={(e) => updateField('apiKey', e.target.value)}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                      placeholder="sk-..."
                    />
                    <p className="text-[11px] text-dark-500 mt-1">Leave blank to use server default key</p>
                  </div>
                )}

                {form.provider === 'mistral' && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5">API Key</label>
                    <input
                      type="password" value={form.apiKey}
                      onChange={(e) => updateField('apiKey', e.target.value)}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                      placeholder="sk-..."
                    />
                    <p className="text-[11px] text-dark-500 mt-1">Leave blank to use server default key (MISTRAL_API_KEY)</p>
                  </div>
                )}

                {form.provider === 'claude-paid' && (
                  <div className="col-span-2">
                    <label className="block text-xs text-dark-400 mb-1.5">API Key</label>
                    <input
                      type="password" value={form.apiKey}
                      onChange={(e) => updateField('apiKey', e.target.value)}
                      className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                      placeholder="sk-ant-..."
                    />
                    <p className="text-[11px] text-dark-500 mt-1">Leave blank to use server default key (ANTHROPIC_API_KEY). Routed via coder-service.</p>
                  </div>
                )}

                {form.provider === 'vllm' && (
                  <>
                    <div className="col-span-2">
                      <label className="block text-xs text-dark-400 mb-1.5">Server URL *</label>
                      <input
                        type="text" value={form.endpoint}
                        onChange={(e) => updateField('endpoint', e.target.value)}
                        className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                        placeholder="http://localhost:8000"
                      />
                      <p className="text-[11px] text-dark-500 mt-1">Base URL of your vLLM server (OpenAI-compatible API)</p>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-dark-400 mb-1.5">API Key (optional)</label>
                      <input
                        type="password" value={form.apiKey}
                        onChange={(e) => updateField('apiKey', e.target.value)}
                        className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                        placeholder="token-..."
                      />
                      <p className="text-[11px] text-dark-500 mt-1">Leave blank if your vLLM server doesn't require authentication</p>
                    </div>
                  </>
                )}

                <div>
                  <div className="flex items-center gap-2 mb-1.5">
                    <input
                      type="checkbox" checked={form.temperatureEnabled}
                      onChange={(e) => {
                        updateField('temperatureEnabled', e.target.checked);
                        if (e.target.checked && form.temperature == null) updateField('temperature', 0.7);
                      }}
                      className="accent-indigo-500"
                    />
                    <label className="text-xs text-dark-400">
                      Temperature{form.temperatureEnabled ? `: ${form.temperature}` : ' (disabled — using model default)'}
                    </label>
                  </div>
                  {form.temperatureEnabled && (
                    <input
                      type="range" min="0" max="1" step="0.1" value={form.temperature ?? 0.7}
                      onChange={(e) => updateField('temperature', parseFloat(e.target.value))}
                      className="w-full accent-indigo-500"
                    />
                  )}
                </div>

                <div>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox" checked={form.isReasoning}
                      onChange={(e) => updateField('isReasoning', e.target.checked)}
                      className="accent-indigo-500"
                    />
                    <span className="text-xs text-dark-400">Reasoning model</span>
                  </label>
                  <p className="text-[11px] text-dark-500 mt-1">Uses 'developer' role instead of 'system', disables temperature</p>
                </div>

                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">Max Tokens <span className="text-dark-500">(output)</span></label>
                  <input
                    type="number" value={form.maxTokens}
                    onChange={(e) => updateField('maxTokens', parseInt(e.target.value) || 128000)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">
                    Context Length <span className="text-dark-500">0 = default</span>
                  </label>
                  <input
                    type="number" value={form.contextLength}
                    onChange={(e) => updateField('contextLength', parseInt(e.target.value) || 0)}
                    placeholder="128000"
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  />
                </div>

                <div>
                  <label className="block text-xs text-dark-400 mb-1.5">Color</label>
                  <input
                    type="color" value={form.color}
                    onChange={(e) => updateField('color', e.target.value)}
                    className="h-9 w-full rounded-lg border border-dark-600 cursor-pointer bg-dark-700"
                  />
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button
                  onClick={() => {
                    setSelectedTemplate(null);
                    setStep('choose');
                  }}
                  className="px-4 py-2 text-dark-400 hover:text-dark-200 text-sm transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={handleCreate}
                  disabled={creating || !form.name.trim()}
                  className="flex-1 py-2.5 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white font-medium rounded-xl disabled:opacity-40 transition-all flex items-center justify-center gap-2 shadow-lg shadow-indigo-500/20"
                >
                  {creating ? (
                    <>
                      <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      Creating...
                    </>
                  ) : (
                    'Create Agent'
                  )}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
