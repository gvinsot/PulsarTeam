import { useState, useEffect } from 'react';
import { X, Cpu, Search, FolderCode, Crown, Mic } from 'lucide-react';
import { api } from '../api';

export default function AddAgentModal({ templates, projects, agents = [], onClose, onCreated }) {
  const [step, setStep] = useState('choose'); // choose | template | custom
  const [selectedTemplate, setSelectedTemplate] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [llmConfigs, setLlmConfigs] = useState([]);
  const [form, setForm] = useState({
    name: '',
    role: '',
    description: '',
    instructions: 'You are a helpful AI assistant.',
    llmConfigId: '',
    icon: '🤖',
    color: '#6366f1',
    project: '',
    isLeader: false,
    isVoice: false,
    voice: 'alloy',
  });
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    api.getLlmConfigs().then(setLlmConfigs).catch(() => {});
  }, []);

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
      icon: template.icon,
      color: template.color,
      isLeader: template.isLeader || template.isVoice || false,
      isVoice: template.isVoice || false,
      voice: template.isVoice ? 'alloy' : prev.voice,
    }));
    setSelectedTemplate(template);
    setStep('custom');
  };

  const handleCreate = async () => {
    if (!form.name.trim()) return;
    setCreating(true);
    try {
      const payload = { ...form };
      payload.llmConfigId = payload.llmConfigId || null;
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
                          // Auto-select an LLM config with gpt-realtime model
                          const realtimeConfig = llmConfigs.find(c => c.model && c.model.includes('gpt-realtime'));
                          if (realtimeConfig) {
                            updateField('llmConfigId', realtimeConfig.id);
                          }
                        }
                      }}
                      className="w-4 h-4 rounded border-dark-600 bg-dark-700 text-amber-500 focus:ring-amber-500 focus:ring-offset-dark-800"
                    />
                    <div className="flex items-center gap-2">
                      <Mic className="w-4 h-4 text-amber-400" />
                      <span className="text-sm text-dark-200 group-hover:text-dark-100">Voice Agent</span>
                    </div>
                  </label>
                  <p className="text-[11px] text-dark-500 mt-1 ml-7">Speech-to-speech agent using OpenAI Realtime API (forces Leader mode)</p>
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

                <div className="col-span-2">
                  <label className="block text-xs text-dark-400 mb-1.5">LLM Configuration *</label>
                  <select
                    value={form.llmConfigId}
                    onChange={(e) => updateField('llmConfigId', e.target.value)}
                    className="w-full px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="">-- Select an LLM config --</option>
                    {(form.isVoice
                      ? llmConfigs.filter(c => c.model && c.model.includes('gpt-realtime'))
                      : llmConfigs
                    ).map(c => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.provider}/{c.model})
                      </option>
                    ))}
                  </select>
                  {form.isVoice && !llmConfigs.some(c => c.model && c.model.includes('gpt-realtime')) && (
                    <p className="text-[11px] text-amber-400 mt-1">No realtime LLM config found. Create one with model "gpt-realtime-1.5" in Admin Settings.</p>
                  )}
                  {form.llmConfigId && (() => {
                    const sel = llmConfigs.find(c => c.id === form.llmConfigId);
                    return sel ? (
                      <div className="mt-2 p-2.5 bg-dark-600/50 rounded-lg border border-dark-500/50 text-xs text-dark-400 space-y-0.5">
                        <p><span className="text-dark-300">Provider:</span> {sel.provider}</p>
                        <p><span className="text-dark-300">Model:</span> <span className="font-mono">{sel.model}</span></p>
                        {sel.endpoint && <p><span className="text-dark-300">Endpoint:</span> <span className="font-mono">{sel.endpoint}</span></p>}
                        {sel.isReasoning && <p><span className="text-dark-300">Reasoning:</span> Yes</p>}
                      </div>
                    ) : null;
                  })()}
                  <p className="text-[11px] text-dark-500 mt-1">LLM configurations are managed in Admin Settings</p>
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
