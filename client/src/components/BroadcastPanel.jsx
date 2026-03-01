import { useState, useRef, useEffect } from 'react';
import { X, Radio, Send, Loader2, FolderOpen, ChevronDown, StopCircle, Wrench, Plus, Pencil, Trash2, Check, ChevronRight, MessageSquareOff, ScrollText } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cleanToolSyntax } from './AgentDetail';
import { api } from '../api';

const categoryColors = {
  coding: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
  devops: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
  writing: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
  security: 'bg-red-500/20 text-red-400 border-red-500/30',
  analysis: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
  general: 'bg-dark-500/20 text-dark-300 border-dark-500/30',
};
const getCategoryClass = (cat) => categoryColors[cat] || categoryColors.general;

export default function BroadcastPanel({ agents, projects = [], skills = [], socket, onClose, onRefresh }) {
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [responses, setResponses] = useState([]);
  const [history, setHistory] = useState([]);
  const [changingProject, setChangingProject] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [editingSkill, setEditingSkill] = useState(null); // skill id being edited
  const [editForm, setEditForm] = useState({ name: '', description: '', category: '', icon: '', instructions: '' });
  const [showCreate, setShowCreate] = useState(false);
  const [newSkill, setNewSkill] = useState({ name: '', description: '', category: 'coding', icon: '🔧', instructions: '' });
  const responsesRef = useRef(null);

  useEffect(() => {
    if (responses.length > 0 && responsesRef.current) {
      responsesRef.current.scrollTop = responsesRef.current.scrollHeight;
    }
  }, [responses]);

  useEffect(() => {
    if (!socket) return;

    const handleComplete = (data) => {
      setResponses(data.results || []);
      setSending(false);
    };

    const handleError = (data) => {
      console.error('Broadcast error:', data.error);
      setSending(false);
    };

    socket.on('broadcast:complete', handleComplete);
    socket.on('broadcast:error', handleError);

    return () => {
      socket.off('broadcast:complete', handleComplete);
      socket.off('broadcast:error', handleError);
    };
  }, [socket]);

  const handleBroadcast = () => {
    if (!message.trim() || sending || !socket) return;
    const msg = message.trim();
    setMessage('');
    setSending(true);
    setResponses([]);

    // Store in history
    setHistory(prev => [...prev, { type: 'broadcast', message: msg, timestamp: new Date().toISOString() }]);

    socket.emit('broadcast:message', { message: msg });
  };

  const handleProjectChange = async (project) => {
    setChangingProject(true);
    try {
      await api.updateAllProjects(project);
    } catch (err) {
      console.error('Failed to update projects:', err);
    } finally {
      setChangingProject(false);
    }
  };

  const startEdit = (skill) => {
    setEditingSkill(skill.id);
    setEditForm({
      name: skill.name,
      description: skill.description || '',
      category: skill.category || 'general',
      icon: skill.icon || '🔧',
      instructions: skill.instructions || ''
    });
  };

  const cancelEdit = () => {
    setEditingSkill(null);
    setEditForm({ name: '', description: '', category: '', icon: '', instructions: '' });
  };

  const saveEdit = async () => {
    if (!editingSkill || !editForm.name.trim() || !editForm.instructions.trim()) return;
    try {
      await api.updateSkill(editingSkill, editForm);
      setEditingSkill(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to update skill:', err);
    }
  };

  const handleDelete = async (skillId) => {
    try {
      await api.deleteSkill(skillId);
      if (editingSkill === skillId) setEditingSkill(null);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to delete skill:', err);
    }
  };

  const handleCreate = async () => {
    if (!newSkill.name.trim() || !newSkill.instructions.trim()) return;
    try {
      await api.createSkill(newSkill);
      setNewSkill({ name: '', description: '', category: 'coding', icon: '🔧', instructions: '' });
      setShowCreate(false);
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to create skill:', err);
    }
  };

  const handleClearAllChats = async () => {
    if (!agents.length) return;
    try {
      await Promise.all(agents.map(a => api.clearHistory(a.id)));
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to clear chats:', err);
    }
  };

  const handleClearAllActionLogs = async () => {
    if (!agents.length) return;
    try {
      await Promise.all(agents.map(a => api.clearActionLogs(a.id)));
      if (onRefresh) onRefresh();
    } catch (err) {
      console.error('Failed to clear action logs:', err);
    }
  };

  // Get current project (from first agent or null)
  const currentProject = agents.length > 0 ? agents[0].project : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fadeIn" onClick={onClose}>
      <div className="w-full max-w-3xl max-h-[85vh] overflow-auto bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl mx-4 px-6 py-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Radio className="w-4 h-4 text-amber-400" />
            <h3 className="font-semibold text-dark-100 text-sm">Global Broadcast</h3>
            <span className="text-xs text-dark-400">(tmux-style — sends to all {agents.length} agents)</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Project selector */}
            <div className="relative">
              <div className="flex items-center gap-1 text-xs text-dark-400">
                <FolderOpen className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Project:</span>
              </div>
            </div>
            <div className="relative">
              <select
                value={currentProject || ''}
                onChange={(e) => handleProjectChange(e.target.value || null)}
                disabled={changingProject || agents.length === 0}
                className="appearance-none bg-dark-800 border border-dark-600 rounded-lg px-3 py-1.5 pr-7 text-sm text-dark-200 focus:outline-none focus:border-indigo-500 disabled:opacity-50 cursor-pointer"
              >
                <option value="">No project</option>
                {projects.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
              <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-400 pointer-events-none" />
            </div>
            {/* Skills toggle */}
            <button
              onClick={() => setShowSkills(!showSkills)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium ${
                showSkills
                  ? 'bg-indigo-500/20 text-indigo-400'
                  : 'bg-dark-800 text-dark-400 hover:text-dark-200'
              }`}
              title="Manage skills"
            >
              <Wrench className="w-4 h-4" />
              <span className="hidden sm:inline">Skills</span>
              <span className="text-xs opacity-60">({skills.length})</span>
            </button>
            {/* Clear All Chats */}
            <button
              onClick={handleClearAllChats}
              disabled={agents.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-800 text-dark-400 hover:text-dark-200 hover:bg-dark-700 rounded-lg transition-colors text-sm font-medium disabled:opacity-40"
              title="Clear all agent conversations"
            >
              <MessageSquareOff className="w-4 h-4" />
              <span className="hidden sm:inline">Clear Chats</span>
            </button>
            {/* Clear All Action Logs */}
            <button
              onClick={handleClearAllActionLogs}
              disabled={agents.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-dark-800 text-dark-400 hover:text-dark-200 hover:bg-dark-700 rounded-lg transition-colors text-sm font-medium disabled:opacity-40"
              title="Clear all agent action logs"
            >
              <ScrollText className="w-4 h-4" />
              <span className="hidden sm:inline">Clear Logs</span>
            </button>
            {/* Stop All button - visible when any agent is busy */}
            {agents.some(a => a.status === 'busy') && socket && (
              <button
                onClick={() => agents.filter(a => a.status === 'busy').forEach(a => socket.emit('agent:stop', { agentId: a.id }))}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/20 hover:bg-red-500/30 text-red-400 rounded-lg transition-colors text-sm font-medium"
                title="Stop all running agents"
              >
                <StopCircle className="w-4 h-4" />
                <span className="hidden sm:inline">Stop All</span>
              </button>
            )}
            <button onClick={onClose} className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Skills Management Section */}
        {showSkills && (
          <div className="mb-3 p-3 bg-dark-800/30 rounded-xl border border-dark-700/50 animate-fadeIn">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                <Wrench className="w-4 h-4 text-indigo-400" />
                Skills Marketplace
                <span className="text-dark-400 font-normal">({skills.length})</span>
              </h4>
              <button
                onClick={() => { setShowCreate(!showCreate); setEditingSkill(null); }}
                className="flex items-center gap-1 px-2.5 py-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                New
              </button>
            </div>

            {/* Create form */}
            {showCreate && (
              <div className="p-3 bg-dark-800/50 rounded-lg border border-indigo-500/30 space-y-2 mb-3 animate-fadeIn">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newSkill.icon}
                    onChange={(e) => setNewSkill(s => ({ ...s, icon: e.target.value }))}
                    className="w-12 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-indigo-500"
                    placeholder="🔧"
                  />
                  <input
                    type="text"
                    value={newSkill.name}
                    onChange={(e) => setNewSkill(s => ({ ...s, name: e.target.value }))}
                    className="flex-1 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                    placeholder="Skill name"
                  />
                  <select
                    value={newSkill.category}
                    onChange={(e) => setNewSkill(s => ({ ...s, category: e.target.value }))}
                    className="px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500"
                  >
                    <option value="coding">coding</option>
                    <option value="devops">devops</option>
                    <option value="writing">writing</option>
                    <option value="security">security</option>
                    <option value="analysis">analysis</option>
                    <option value="general">general</option>
                  </select>
                </div>
                <input
                  type="text"
                  value={newSkill.description}
                  onChange={(e) => setNewSkill(s => ({ ...s, description: e.target.value }))}
                  className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                  placeholder="Short description"
                />
                <textarea
                  value={newSkill.instructions}
                  onChange={(e) => setNewSkill(s => ({ ...s, instructions: e.target.value }))}
                  className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
                  placeholder="Skill instructions (injected into agent prompt)..."
                  rows={4}
                />
                <div className="flex gap-2 justify-end">
                  <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">Cancel</button>
                  <button
                    onClick={handleCreate}
                    disabled={!newSkill.name.trim() || !newSkill.instructions.trim()}
                    className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40"
                  >
                    Create
                  </button>
                </div>
              </div>
            )}

            {/* Skills list */}
            <div className="space-y-1.5 max-h-[300px] overflow-auto">
              {skills.map(skill => (
                <div key={skill.id}>
                  {editingSkill === skill.id ? (
                    /* Edit form inline */
                    <div className="p-3 bg-dark-800/50 rounded-lg border border-indigo-500/30 space-y-2 animate-fadeIn">
                      <div className="flex gap-2">
                        <input
                          type="text"
                          value={editForm.icon}
                          onChange={(e) => setEditForm(f => ({ ...f, icon: e.target.value }))}
                          className="w-12 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-indigo-500"
                        />
                        <input
                          type="text"
                          value={editForm.name}
                          onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))}
                          className="flex-1 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                        />
                        <select
                          value={editForm.category}
                          onChange={(e) => setEditForm(f => ({ ...f, category: e.target.value }))}
                          className="px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500"
                        >
                          <option value="coding">coding</option>
                          <option value="devops">devops</option>
                          <option value="writing">writing</option>
                          <option value="security">security</option>
                          <option value="analysis">analysis</option>
                          <option value="general">general</option>
                        </select>
                      </div>
                      <input
                        type="text"
                        value={editForm.description}
                        onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))}
                        className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                        placeholder="Short description"
                      />
                      <textarea
                        value={editForm.instructions}
                        onChange={(e) => setEditForm(f => ({ ...f, instructions: e.target.value }))}
                        className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
                        placeholder="Skill instructions..."
                        rows={5}
                      />
                      <div className="flex gap-2 justify-end">
                        <button onClick={cancelEdit} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">Cancel</button>
                        <button
                          onClick={saveEdit}
                          disabled={!editForm.name.trim() || !editForm.instructions.trim()}
                          className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Display row */
                    <div className="flex items-center gap-3 p-2.5 bg-dark-800/30 rounded-lg border border-dark-700/30 hover:border-dark-600 transition-colors group">
                      <span className="text-base flex-shrink-0">{skill.icon}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-dark-200">{skill.name}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(skill.category)}`}>
                            {skill.category}
                          </span>
                          {skill.builtin && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">builtin</span>
                          )}
                        </div>
                        <p className="text-xs text-dark-500 truncate">{skill.description}</p>
                      </div>
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                        <button
                          onClick={() => startEdit(skill)}
                          className="p-1.5 text-dark-400 hover:text-indigo-400 rounded-md hover:bg-dark-700 transition-colors"
                          title="Edit skill"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => handleDelete(skill.id)}
                          className="p-1.5 text-dark-400 hover:text-red-400 rounded-md hover:bg-dark-700 transition-colors"
                          title="Delete skill"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {skills.length === 0 && (
                <p className="text-center text-dark-500 text-xs py-4">No skills created yet</p>
              )}
            </div>
          </div>
        )}

        {/* Input area */}
        <div className="flex gap-2 mb-3">
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleBroadcast();
              }
            }}
            className="flex-1 px-4 py-2.5 bg-dark-800 border border-amber-500/30 rounded-xl text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-amber-500 resize-none"
            placeholder="Type a message to broadcast to all agents..."
            rows={2}
            disabled={sending}
          />
          <button
            onClick={handleBroadcast}
            disabled={sending || !message.trim() || agents.length === 0}
            className="px-4 py-2 bg-amber-500 hover:bg-amber-600 text-dark-900 font-medium rounded-xl disabled:opacity-40 transition-colors flex items-center gap-2 self-end"
          >
            {sending ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span className="hidden sm:inline">Broadcasting...</span>
              </>
            ) : (
              <>
                <Send className="w-4 h-4" />
                <span className="hidden sm:inline">Broadcast</span>
              </>
            )}
          </button>
        </div>

        {/* Responses */}
        {responses.length > 0 && (
          <div ref={responsesRef} className="space-y-2 max-h-[300px] overflow-auto">
            <p className="text-xs text-dark-400 font-medium">Responses:</p>
            {responses.map((r, i) => (
              <div key={i} className={`p-3 rounded-lg border text-sm ${
                r.error
                  ? 'bg-red-500/5 border-red-500/20'
                  : 'bg-dark-800/50 border-dark-700/50'
              }`}>
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-medium text-dark-200">{r.agentName}</span>
                  {r.error && <span className="text-xs text-red-400">Error</span>}
                </div>
                {r.error ? (
                  <p className="text-xs text-red-400">{r.error}</p>
                ) : (
                  <div className="markdown-content text-xs text-dark-300">
                    <ReactMarkdown>{cleanToolSyntax(r.response)}</ReactMarkdown>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Status */}
        {sending && (
          <div className="flex items-center gap-2 text-xs text-amber-400">
            <Loader2 className="w-3 h-3 animate-spin" />
            Broadcasting to {agents.length} agents... Waiting for responses...
          </div>
        )}

      </div>
    </div>
  );
}
