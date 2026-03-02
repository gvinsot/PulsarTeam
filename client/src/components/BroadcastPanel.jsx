import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Globe, Send, Loader2, FolderOpen, ChevronDown, StopCircle, Wrench, Plus, Pencil, Trash2, Check, Zap, MessageSquareOff, ScrollText, Plug, RefreshCw } from 'lucide-react';
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

const TABS = [
  { id: 'broadcast', label: 'Global', icon: Globe },
  { id: 'plugins', label: 'Plugins', icon: Wrench },
  { id: 'actions', label: 'Actions', icon: Zap },
];

// Inline confirm button — first click shows "Are you sure?", second click executes
function ConfirmButton({ onConfirm, disabled, icon: Icon, label, confirmLabel = 'Are you sure?', className, confirmClassName }) {
  const [confirming, setConfirming] = useState(false);
  const timerRef = useRef(null);

  useEffect(() => () => clearTimeout(timerRef.current), []);

  const handleClick = () => {
    if (confirming) {
      clearTimeout(timerRef.current);
      setConfirming(false);
      onConfirm();
    } else {
      setConfirming(true);
      timerRef.current = setTimeout(() => setConfirming(false), 3000);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={disabled}
      className={confirming ? confirmClassName : className}
    >
      <Icon className="w-4 h-4" />
      {confirming ? confirmLabel : label}
    </button>
  );
}

const statusColors = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-500 animate-pulse',
  error: 'bg-red-500',
  disconnected: 'bg-dark-500',
};

export default function BroadcastPanel({ agents, projects = [], skills = [], mcpServers = [], socket, onClose, onRefresh }) {
  const [tab, setTab] = useState('broadcast');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [responses, setResponses] = useState([]);
  const [changingProject, setChangingProject] = useState(false);

  // Plugin state
  const [editingPlugin, setEditingPlugin] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', category: '', icon: '', instructions: '', mcpServerIds: [] });
  const [showCreate, setShowCreate] = useState(false);
  const [newPlugin, setNewPlugin] = useState({ name: '', description: '', category: 'coding', icon: '🔧', instructions: '', mcpServerIds: [] });

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
      console.error('Global error:', data.error);
      setSending(false);
    };

    socket.on('broadcast:complete', handleComplete);
    socket.on('broadcast:error', handleError);

    return () => {
      socket.off('broadcast:complete', handleComplete);
      socket.off('broadcast:error', handleError);
    };
  }, [socket]);

  // ── Broadcast handlers ──────────────────────────────────────────────

  const handleBroadcast = () => {
    if (!message.trim() || sending || !socket) return;
    const msg = message.trim();
    setMessage('');
    setSending(true);
    setResponses([]);
    socket.emit('broadcast:message', { message: msg });
  };

  const handleProjectChange = async (project) => {
    setChangingProject(true);
    try { await api.updateAllProjects(project); }
    catch (err) { console.error('Failed to update projects:', err); }
    finally { setChangingProject(false); }
  };

  // ── Plugin handlers ─────────────────────────────────────────────────

  const startEdit = (plugin) => {
    setEditingPlugin(plugin.id);
    setEditForm({
      name: plugin.name,
      description: plugin.description || '',
      category: plugin.category || 'general',
      icon: plugin.icon || '🔧',
      instructions: plugin.instructions || '',
      mcpServerIds: Array.isArray(plugin.mcpServerIds) ? [...plugin.mcpServerIds] : []
    });
  };

  const cancelEdit = () => {
    setEditingPlugin(null);
    setEditForm({ name: '', description: '', category: '', icon: '', instructions: '', mcpServerIds: [] });
  };

  const saveEdit = async () => {
    if (!editingPlugin || !editForm.name.trim() || !editForm.instructions.trim()) return;
    try {
      await api.updatePlugin(editingPlugin, editForm);
      setEditingPlugin(null);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to update plugin:', err); }
  };

  const handleDelete = async (pluginId) => {
    try {
      await api.deletePlugin(pluginId);
      if (editingPlugin === pluginId) setEditingPlugin(null);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to delete plugin:', err); }
  };

  const handleCreate = async () => {
    if (!newPlugin.name.trim() || !newPlugin.instructions.trim()) return;
    try {
      await api.createPlugin(newPlugin);
      setNewPlugin({ name: '', description: '', category: 'coding', icon: '🔧', instructions: '', mcpServerIds: [] });
      setShowCreate(false);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to create plugin:', err); }
  };

  const toggleMcpInEdit = (mcpId) => {
    setEditForm(f => ({
      ...f,
      mcpServerIds: f.mcpServerIds.includes(mcpId)
        ? f.mcpServerIds.filter(id => id !== mcpId)
        : [...f.mcpServerIds, mcpId]
    }));
  };

  const toggleMcpInCreate = (mcpId) => {
    setNewPlugin(p => ({
      ...p,
      mcpServerIds: p.mcpServerIds.includes(mcpId)
        ? p.mcpServerIds.filter(id => id !== mcpId)
        : [...p.mcpServerIds, mcpId]
    }));
  };

  // ── MCP handlers ──────────────────────────────────────────────────

  const [showMcpCreate, setShowMcpCreate] = useState(false);
  const [newMcp, setNewMcp] = useState({ name: '', url: '', description: '', icon: '🔌', apiKey: '' });
  const [editingMcp, setEditingMcp] = useState(null);
  const [editMcpForm, setEditMcpForm] = useState({ name: '', url: '', description: '', icon: '', apiKey: '' });
  const [connectingMcp, setConnectingMcp] = useState(null);

  const handleCreateMcp = async () => {
    if (!newMcp.name.trim() || !newMcp.url.trim()) return;
    try {
      await api.createMcpServer(newMcp);
      setNewMcp({ name: '', url: '', description: '', icon: '🔌', apiKey: '' });
      setShowMcpCreate(false);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to create MCP server:', err); }
  };

  const startMcpEdit = (server) => {
    setEditingMcp(server.id);
    setEditMcpForm({ name: server.name, url: server.url, description: server.description || '', icon: server.icon || '🔌', apiKey: '' });
    // apiKey starts empty in edit form — user types new key to change, leave blank to keep existing
  };

  const saveMcpEdit = async () => {
    if (!editingMcp || !editMcpForm.name.trim() || !editMcpForm.url.trim()) return;
    try {
      const payload = { ...editMcpForm };
      // Only send apiKey if user typed a new one (blank = keep existing)
      if (!payload.apiKey) delete payload.apiKey;
      await api.updateMcpServer(editingMcp, payload);
      setEditingMcp(null);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to update MCP server:', err); }
  };

  const handleDeleteMcp = async (id) => {
    try {
      await api.deleteMcpServer(id);
      if (editingMcp === id) setEditingMcp(null);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to delete MCP server:', err); }
  };

  const handleConnectMcp = async (id) => {
    setConnectingMcp(id);
    try {
      await api.connectMcpServer(id);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to connect MCP server:', err); }
    finally { setConnectingMcp(null); }
  };

  // ── Actions handlers ────────────────────────────────────────────────

  const handleClearAllChats = useCallback(async () => {
    if (!agents.length) return;
    try {
      await Promise.all(agents.map(a => api.clearHistory(a.id)));
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to clear chats:', err); }
  }, [agents, onRefresh]);

  const handleClearAllActionLogs = useCallback(async () => {
    if (!agents.length) return;
    try {
      await Promise.all(agents.map(a => api.clearActionLogs(a.id)));
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to clear action logs:', err); }
  }, [agents, onRefresh]);

  const handleStopAll = useCallback(() => {
    if (!socket) return;
    agents.filter(a => a.status === 'busy').forEach(a => socket.emit('agent:stop', { agentId: a.id }));
  }, [agents, socket]);

  const currentProject = agents.length > 0 ? agents[0].project : null;
  const busyCount = agents.filter(a => a.status === 'busy').length;

  // ── Render ──────────────────────────────────────────────────────────

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm animate-fadeIn" onClick={onClose}>
      <div
        className="w-full h-full sm:w-[700px] sm:h-[80vh] sm:max-h-[800px] sm:rounded-2xl bg-dark-900 border-0 sm:border border-dark-700 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-dark-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-amber-400" />
            <h3 className="font-semibold text-dark-100 text-sm">Control Panel</h3>
            <span className="text-xs text-dark-400">({agents.length} agents)</span>
          </div>
          <button onClick={onClose} className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* ── Tabs ───────────────────────────────────────────────── */}
        <div className="flex gap-1 px-5 py-2.5 border-b border-dark-700/50 flex-shrink-0">
          {TABS.map(t => {
            const Icon = t.icon;
            const active = tab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  active
                    ? 'bg-amber-500/15 text-amber-400'
                    : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
                {t.id === 'plugins' && <span className="text-xs opacity-60">({skills.length})</span>}
                {t.id === 'actions' && busyCount > 0 && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                )}
              </button>
            );
          })}
        </div>

        {/* ── Tab Content (fills remaining space) ────────────────── */}
        <div className="flex-1 overflow-hidden flex flex-col min-h-0">

          {/* ── BROADCAST TAB ──────────────────────────────────── */}
          {tab === 'broadcast' && (
            <div className="flex-1 flex flex-col min-h-0 p-5 gap-3">
              {/* Project selector */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <FolderOpen className="w-3.5 h-3.5 text-dark-400" />
                <span className="text-xs text-dark-400">Assign all agents to :</span>
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
              </div>

              {/* Responses (scrollable, takes available space) */}
              <div ref={responsesRef} className="flex-1 overflow-auto min-h-0 space-y-2">
                {responses.length > 0 && (
                  <>
                    <p className="text-xs text-dark-400 font-medium sticky top-0 bg-dark-900 py-1">Responses:</p>
                    {responses.map((r, i) => (
                      <div key={i} className={`p-3 rounded-lg border text-sm ${
                        r.error ? 'bg-red-500/5 border-red-500/20' : 'bg-dark-800/50 border-dark-700/50'
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
                  </>
                )}
                {responses.length === 0 && !sending && (
                  <div className="flex-1 flex items-center justify-center h-full">
                    <p className="text-dark-500 text-sm">Send a message to all agents at once</p>
                  </div>
                )}
                {sending && (
                  <div className="flex items-center justify-center gap-2 text-xs text-amber-400 py-8">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Broadcasting to {agents.length} agents...
                  </div>
                )}
              </div>

              {/* Input (pinned to bottom) */}
              <div className="flex gap-2 flex-shrink-0">
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
                  {sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                  <span className="hidden sm:inline">{sending ? 'Sending...' : 'Global'}</span>
                </button>
              </div>
            </div>
          )}

          {/* ── PLUGINS TAB ────────────────────────────────────── */}
          {tab === 'plugins' && (
            <div className="flex-1 flex flex-col min-h-0 p-5 gap-3">
              {/* Header */}
              <div className="flex items-center justify-between flex-shrink-0">
                <h4 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                  <Wrench className="w-4 h-4 text-indigo-400" />
                  Plugins
                  <span className="text-dark-400 font-normal">({skills.length})</span>
                </h4>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => { setShowMcpCreate(!showMcpCreate); setEditingMcp(null); setShowCreate(false); }}
                    className="flex items-center gap-1 px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs transition-colors"
                  >
                    <Plug className="w-3 h-3" />
                    New MCP
                  </button>
                  <button
                    onClick={() => { setShowCreate(!showCreate); setEditingPlugin(null); setShowMcpCreate(false); }}
                    className="flex items-center gap-1 px-2.5 py-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    New Plugin
                  </button>
                </div>
              </div>

              {/* Create MCP server form */}
              {showMcpCreate && (
                <div className="p-3 bg-dark-800/50 rounded-lg border border-emerald-500/30 space-y-2 flex-shrink-0 animate-fadeIn">
                  <p className="text-xs font-medium text-emerald-400 flex items-center gap-1"><Plug className="w-3 h-3" /> New MCP Server</p>
                  <div className="flex gap-2">
                    <input type="text" value={newMcp.icon} onChange={(e) => setNewMcp(s => ({ ...s, icon: e.target.value }))} className="w-12 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-emerald-500" placeholder="🔌" />
                    <input type="text" value={newMcp.name} onChange={(e) => setNewMcp(s => ({ ...s, name: e.target.value }))} className="flex-1 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-emerald-500" placeholder="Server name" />
                  </div>
                  <input type="text" value={newMcp.url} onChange={(e) => setNewMcp(s => ({ ...s, url: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-emerald-500 font-mono" placeholder="http://host:port/path" />
                  <input type="text" value={newMcp.description} onChange={(e) => setNewMcp(s => ({ ...s, description: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-emerald-500" placeholder="Short description" />
                  <input type="password" value={newMcp.apiKey} onChange={(e) => setNewMcp(s => ({ ...s, apiKey: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-emerald-500 font-mono" placeholder="API Key (optional)" autoComplete="off" />
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowMcpCreate(false)} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">Cancel</button>
                    <button onClick={handleCreateMcp} disabled={!newMcp.name.trim() || !newMcp.url.trim()} className="px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm disabled:opacity-40">Create</button>
                  </div>
                </div>
              )}

              {/* Create plugin form */}
              {showCreate && (
                <div className="p-3 bg-dark-800/50 rounded-lg border border-indigo-500/30 space-y-2 flex-shrink-0 animate-fadeIn">
                  <div className="flex gap-2">
                    <input type="text" value={newPlugin.icon} onChange={(e) => setNewPlugin(s => ({ ...s, icon: e.target.value }))} className="w-12 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-indigo-500" placeholder="🔧" />
                    <input type="text" value={newPlugin.name} onChange={(e) => setNewPlugin(s => ({ ...s, name: e.target.value }))} className="flex-1 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500" placeholder="Plugin name" />
                    <select value={newPlugin.category} onChange={(e) => setNewPlugin(s => ({ ...s, category: e.target.value }))} className="px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500">
                      <option value="coding">coding</option>
                      <option value="devops">devops</option>
                      <option value="writing">writing</option>
                      <option value="security">security</option>
                      <option value="analysis">analysis</option>
                      <option value="general">general</option>
                    </select>
                  </div>
                  <input type="text" value={newPlugin.description} onChange={(e) => setNewPlugin(s => ({ ...s, description: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500" placeholder="Short description" />
                  <textarea value={newPlugin.instructions} onChange={(e) => setNewPlugin(s => ({ ...s, instructions: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none" placeholder="Plugin instructions (injected into agent prompt)..." rows={4} />
                  {/* MCP server association */}
                  {mcpServers.length > 0 && (
                    <div>
                      <p className="text-xs text-dark-400 mb-1.5 flex items-center gap-1"><Plug className="w-3 h-3" /> Associated MCP Servers</p>
                      <div className="space-y-1">
                        {mcpServers.map(server => (
                          <label key={server.id} className="flex items-center gap-2 px-2 py-1.5 bg-dark-800/30 rounded border border-dark-700/30 cursor-pointer hover:border-dark-600 transition-colors">
                            <input type="checkbox" checked={newPlugin.mcpServerIds.includes(server.id)} onChange={() => toggleMcpInCreate(server.id)} className="rounded border-dark-600 bg-dark-800 text-emerald-500 focus:ring-emerald-500/30" />
                            <span className="text-xs flex-shrink-0">{server.icon || '🔌'}</span>
                            <span className="text-xs text-dark-300">{server.name}</span>
                            <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColors[server.status] || statusColors.disconnected}`} />
                            <span className="text-[10px] text-dark-500 ml-auto">{server.tools?.length || 0} tools</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">Cancel</button>
                    <button onClick={handleCreate} disabled={!newPlugin.name.trim() || !newPlugin.instructions.trim()} className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40">Create</button>
                  </div>
                </div>
              )}

              {/* Plugins list (scrollable) */}
              <div className="flex-1 overflow-auto min-h-0 space-y-1.5">
                {skills.map(plugin => (
                  <div key={plugin.id}>
                    {editingPlugin === plugin.id ? (
                      <div className="p-3 bg-dark-800/50 rounded-lg border border-indigo-500/30 space-y-2 animate-fadeIn">
                        <div className="flex gap-2">
                          <input type="text" value={editForm.icon} onChange={(e) => setEditForm(f => ({ ...f, icon: e.target.value }))} className="w-12 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-indigo-500" />
                          <input type="text" value={editForm.name} onChange={(e) => setEditForm(f => ({ ...f, name: e.target.value }))} className="flex-1 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500" />
                          <select value={editForm.category} onChange={(e) => setEditForm(f => ({ ...f, category: e.target.value }))} className="px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500">
                            <option value="coding">coding</option>
                            <option value="devops">devops</option>
                            <option value="writing">writing</option>
                            <option value="security">security</option>
                            <option value="analysis">analysis</option>
                            <option value="general">general</option>
                          </select>
                        </div>
                        <input type="text" value={editForm.description} onChange={(e) => setEditForm(f => ({ ...f, description: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500" placeholder="Short description" />
                        <textarea value={editForm.instructions} onChange={(e) => setEditForm(f => ({ ...f, instructions: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none" placeholder="Plugin instructions..." rows={5} />
                        {/* MCP server association */}
                        {mcpServers.length > 0 && (
                          <div>
                            <p className="text-xs text-dark-400 mb-1.5 flex items-center gap-1"><Plug className="w-3 h-3" /> Associated MCP Servers</p>
                            <div className="space-y-1">
                              {mcpServers.map(server => (
                                <label key={server.id} className="flex items-center gap-2 px-2 py-1.5 bg-dark-800/30 rounded border border-dark-700/30 cursor-pointer hover:border-dark-600 transition-colors">
                                  <input type="checkbox" checked={editForm.mcpServerIds.includes(server.id)} onChange={() => toggleMcpInEdit(server.id)} className="rounded border-dark-600 bg-dark-800 text-emerald-500 focus:ring-emerald-500/30" />
                                  <span className="text-xs flex-shrink-0">{server.icon || '🔌'}</span>
                                  <span className="text-xs text-dark-300">{server.name}</span>
                                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColors[server.status] || statusColors.disconnected}`} />
                                  <span className="text-[10px] text-dark-500 ml-auto">{server.tools?.length || 0} tools</span>
                                </label>
                              ))}
                            </div>
                          </div>
                        )}
                        <div className="flex gap-2 justify-end">
                          <button onClick={cancelEdit} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">Cancel</button>
                          <button onClick={saveEdit} disabled={!editForm.name.trim() || !editForm.instructions.trim()} className="flex items-center gap-1 px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40">
                            <Check className="w-3.5 h-3.5" /> Save
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 p-2.5 bg-dark-800/30 rounded-lg border border-dark-700/30 hover:border-dark-600 transition-colors group">
                        <span className="text-base flex-shrink-0">{plugin.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-dark-200">{plugin.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                              {plugin.category}
                            </span>
                            {plugin.builtin && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">builtin</span>
                            )}
                            {(plugin.mcpServerIds || []).length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                                {plugin.mcpServerIds.length} MCP
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-dark-500 truncate">{plugin.description}</p>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <button onClick={() => startEdit(plugin)} className="p-1.5 text-dark-400 hover:text-indigo-400 rounded-md hover:bg-dark-700 transition-colors" title="Edit plugin">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => handleDelete(plugin.id)} className="p-1.5 text-dark-400 hover:text-red-400 rounded-md hover:bg-dark-700 transition-colors" title="Delete plugin">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {skills.length === 0 && (
                  <p className="text-center text-dark-500 text-xs py-8">No plugins created yet</p>
                )}

                {/* MCP Servers section */}
                {mcpServers.length > 0 && (
                  <div className="mt-4 pt-4 border-t border-dark-700/50">
                    <p className="text-xs font-medium text-dark-400 mb-2 flex items-center gap-1.5">
                      <Plug className="w-3.5 h-3.5 text-emerald-400" />
                      MCP Servers ({mcpServers.length})
                    </p>
                    <div className="space-y-1.5">
                      {mcpServers.map(server => (
                        <div key={server.id}>
                          {editingMcp === server.id ? (
                            <div className="p-3 bg-dark-800/50 rounded-lg border border-emerald-500/30 space-y-2 animate-fadeIn">
                              <div className="flex gap-2">
                                <input type="text" value={editMcpForm.icon} onChange={(e) => setEditMcpForm(f => ({ ...f, icon: e.target.value }))} className="w-12 px-2 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-emerald-500" />
                                <input type="text" value={editMcpForm.name} onChange={(e) => setEditMcpForm(f => ({ ...f, name: e.target.value }))} className="flex-1 px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-emerald-500" />
                              </div>
                              <input type="text" value={editMcpForm.url} onChange={(e) => setEditMcpForm(f => ({ ...f, url: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 font-mono focus:outline-none focus:border-emerald-500" placeholder="http://host:port/path" />
                              <input type="text" value={editMcpForm.description} onChange={(e) => setEditMcpForm(f => ({ ...f, description: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-emerald-500" placeholder="Short description" />
                              <input type="password" value={editMcpForm.apiKey} onChange={(e) => setEditMcpForm(f => ({ ...f, apiKey: e.target.value }))} className="w-full px-3 py-1.5 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-emerald-500 font-mono" placeholder={server.hasApiKey ? 'Leave blank to keep, or type new key' : 'API Key (optional)'} autoComplete="off" />
                              <div className="flex gap-2 justify-end">
                                <button onClick={() => setEditingMcp(null)} className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-sm">Cancel</button>
                                <button onClick={saveMcpEdit} disabled={!editMcpForm.name.trim() || !editMcpForm.url.trim()} className="flex items-center gap-1 px-3 py-1.5 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-sm disabled:opacity-40">
                                  <Check className="w-3.5 h-3.5" /> Save
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="p-2 bg-dark-800/20 rounded-lg border border-dark-700/20 hover:border-dark-600 transition-colors group">
                              <div className="flex items-center gap-2">
                                <span className="text-sm flex-shrink-0">{server.icon || '🔌'}</span>
                                <span className="text-xs font-medium text-dark-300">{server.name}</span>
                                <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${statusColors[server.status] || statusColors.disconnected}`} />
                                <span className="text-[10px] text-dark-500">{server.status}</span>
                                <span className="text-[10px] text-dark-500 ml-auto">{server.tools?.length || 0} tools</span>
                                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                  <button onClick={() => handleConnectMcp(server.id)} disabled={connectingMcp === server.id} className="p-1 text-dark-400 hover:text-emerald-400 rounded transition-colors" title="Reconnect">
                                    <RefreshCw className={`w-3 h-3 ${connectingMcp === server.id ? 'animate-spin' : ''}`} />
                                  </button>
                                  <button onClick={() => startMcpEdit(server)} className="p-1 text-dark-400 hover:text-emerald-400 rounded transition-colors" title="Edit">
                                    <Pencil className="w-3 h-3" />
                                  </button>
                                  <button onClick={() => handleDeleteMcp(server.id)} className="p-1 text-dark-400 hover:text-red-400 rounded transition-colors" title="Delete">
                                    <Trash2 className="w-3 h-3" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── ACTIONS TAB ────────────────────────────────────── */}
          {tab === 'actions' && (
            <div className="flex-1 p-5 space-y-3 overflow-auto">
              <p className="text-xs text-dark-400 mb-1">Bulk actions applied to all {agents.length} agents</p>

              <div className="space-y-2">
                {/* Clear All Chats */}
                <div className="p-4 bg-dark-800/30 rounded-xl border border-dark-700/30 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <MessageSquareOff className="w-4 h-4 text-dark-300" />
                      <span className="text-sm font-medium text-dark-200">Clear All Chats</span>
                    </div>
                    <p className="text-xs text-dark-500">Delete conversation history for every agent</p>
                  </div>
                  <ConfirmButton
                    onConfirm={handleClearAllChats}
                    disabled={agents.length === 0}
                    icon={MessageSquareOff}
                    label="Clear"
                    confirmLabel="Confirm?"
                    className="flex items-center gap-1.5 px-4 py-2 bg-dark-700 text-dark-300 hover:text-dark-100 hover:bg-dark-600 rounded-lg transition-colors text-sm font-medium disabled:opacity-40 flex-shrink-0"
                    confirmClassName="flex items-center gap-1.5 px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors text-sm font-medium flex-shrink-0 animate-pulse"
                  />
                </div>

                {/* Clear All Action Logs */}
                <div className="p-4 bg-dark-800/30 rounded-xl border border-dark-700/30 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <ScrollText className="w-4 h-4 text-dark-300" />
                      <span className="text-sm font-medium text-dark-200">Clear All Logs</span>
                    </div>
                    <p className="text-xs text-dark-500">Delete action logs for every agent</p>
                  </div>
                  <ConfirmButton
                    onConfirm={handleClearAllActionLogs}
                    disabled={agents.length === 0}
                    icon={ScrollText}
                    label="Clear"
                    confirmLabel="Confirm?"
                    className="flex items-center gap-1.5 px-4 py-2 bg-dark-700 text-dark-300 hover:text-dark-100 hover:bg-dark-600 rounded-lg transition-colors text-sm font-medium disabled:opacity-40 flex-shrink-0"
                    confirmClassName="flex items-center gap-1.5 px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors text-sm font-medium flex-shrink-0 animate-pulse"
                  />
                </div>

                {/* Stop All Agents */}
                <div className="p-4 bg-dark-800/30 rounded-xl border border-dark-700/30 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <StopCircle className="w-4 h-4 text-dark-300" />
                      <span className="text-sm font-medium text-dark-200">Stop All Agents</span>
                    </div>
                    <p className="text-xs text-dark-500">
                      {busyCount > 0
                        ? `Interrupt ${busyCount} running agent${busyCount > 1 ? 's' : ''}`
                        : 'No agents currently running'}
                    </p>
                  </div>
                  <ConfirmButton
                    onConfirm={handleStopAll}
                    disabled={busyCount === 0 || !socket}
                    icon={StopCircle}
                    label="Stop All"
                    confirmLabel="Confirm?"
                    className="flex items-center gap-1.5 px-4 py-2 bg-dark-700 text-dark-300 hover:text-dark-100 hover:bg-dark-600 rounded-lg transition-colors text-sm font-medium disabled:opacity-40 flex-shrink-0"
                    confirmClassName="flex items-center gap-1.5 px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors text-sm font-medium flex-shrink-0 animate-pulse"
                  />
                </div>
              </div>
            </div>
          )}

        </div>
      </div>
    </div>
  );
}