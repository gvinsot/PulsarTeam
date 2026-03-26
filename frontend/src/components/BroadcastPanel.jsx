import { useState, useRef, useEffect, useCallback } from 'react';
import { X, Globe, Send, Loader2, FolderOpen, ChevronDown, ChevronRight, StopCircle, Wrench, Plus, Pencil, Trash2, Zap, MessageSquareOff, ScrollText, Plug, RefreshCw, ListX, Eraser, Search } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { cleanToolSyntax } from './AgentDetail';
import { api } from '../api';
import OneDriveConnect from './OneDriveConnect';
import PluginEditor from './PluginEditor';

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

const statusLabels = {
  connected: 'Connecte',
  connecting: 'Connexion...',
  error: 'Erreur',
  disconnected: 'Deconnecte',
};

export default function BroadcastPanel({ agents, projects = [], skills = [], mcpServers = [], socket, onClose, onRefresh }) {
  const [tab, setTab] = useState('broadcast');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [responses, setResponses] = useState([]);
  const [changingProject, setChangingProject] = useState(false);

  // Plugin sub-tab: 'list' or 'mcp-explorer'
  const [pluginSubTab, setPluginSubTab] = useState('list');

  // Plugin state
  const [editingPlugin, setEditingPlugin] = useState(null);
  const [editForm, setEditForm] = useState({ name: '', description: '', category: '', icon: '', instructions: '', userConfig: {}, mcps: [] });
  const [showCreate, setShowCreate] = useState(false);
  const [newPlugin, setNewPlugin] = useState({ name: '', description: '', category: 'coding', icon: '🔧', instructions: '', userConfig: {}, mcps: [] });

  // MCP Explorer state
  const [expandedMcpExplorer, setExpandedMcpExplorer] = useState(new Set());
  const [connectingMcp, setConnectingMcp] = useState(null);

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
      userConfig: plugin.userConfig || {},
      mcps: Array.isArray(plugin.mcps) ? [...plugin.mcps] : []
    });
    setShowCreate(false);
  };

  const cancelEdit = () => {
    setEditingPlugin(null);
    setEditForm({ name: '', description: '', category: '', icon: '', instructions: '', userConfig: {}, mcps: [] });
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
      setNewPlugin({ name: '', description: '', category: 'coding', icon: '🔧', instructions: '', userConfig: {}, mcps: [] });
      setShowCreate(false);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to create plugin:', err); }
  };

  // ── MCP Explorer handlers ──────────────────────────────────────────

  const handleConnectMcp = async (id) => {
    setConnectingMcp(id);
    try {
      await api.connectMcpServer(id);
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to connect MCP server:', err); }
    finally { setConnectingMcp(null); }
  };

  const toggleMcpExpanded = (id) => {
    setExpandedMcpExplorer(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // Collect all MCPs: standalone servers + embedded in plugins
  const allMcps = (() => {
    const result = [];
    const seenIds = new Set();

    // Standalone MCP servers
    for (const server of mcpServers) {
      seenIds.add(server.id);
      result.push({
        ...server,
        source: 'standalone',
        pluginName: null,
      });
    }

    // Embedded MCPs from plugins
    for (const plugin of skills) {
      for (const mcp of (plugin.mcps || [])) {
        if (mcp.id && seenIds.has(mcp.id)) continue;
        if (mcp.id) seenIds.add(mcp.id);
        // Find matching standalone server for status info
        const matchingServer = mcpServers.find(s =>
          s.url === mcp.url || (mcp.id && s.id === mcp.id)
        );
        result.push({
          ...mcp,
          status: matchingServer?.status || 'disconnected',
          tools: matchingServer?.tools || [],
          source: 'plugin',
          pluginName: plugin.name,
          pluginIcon: plugin.icon,
        });
      }
    }

    return result;
  })();

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

  const handleClearAllTasks = useCallback(async () => {
    if (!agents.length) return;
    try {
      await Promise.all(agents.map(a => api.clearTasks(a.id)));
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to clear tasks:', err); }
  }, [agents, onRefresh]);

  const handleClearAllInProgressTasks = useCallback(async () => {
    if (!agents.length) return;
    try {
      await Promise.all(agents.map(a => api.clearTasksByStatus?.(a.id, 'in_progress')));
      if (onRefresh) onRefresh();
    } catch (err) { console.error('Failed to clear in-progress tasks:', err); }
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
        className={`w-full h-full sm:h-[80vh] sm:max-h-[800px] sm:rounded-2xl bg-dark-900 border-0 sm:border border-dark-700 shadow-2xl flex flex-row overflow-hidden transition-all duration-300 ${
          editingPlugin ? 'sm:w-[1100px]' : 'sm:w-[700px]'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Left panel (main) ── */}
        <div className={`flex flex-col overflow-hidden ${editingPlugin ? 'sm:w-[700px] flex-shrink-0' : 'flex-1'}`}>
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-dark-700 flex-shrink-0">
          <div className="flex items-center gap-2">
            <Globe className="w-4 h-4 text-amber-400" />
            <h3 className="font-semibold text-dark-100 text-sm">Admin Settings</h3>
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
            <div className="flex-1 flex flex-col min-h-0">
              {/* Sub-tab navigation */}
              <div className="flex items-center gap-1 px-5 py-2 border-b border-dark-700/30 flex-shrink-0">
                <button
                  onClick={() => setPluginSubTab('list')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    pluginSubTab === 'list'
                      ? 'bg-indigo-500/15 text-indigo-400'
                      : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800'
                  }`}
                >
                  <Wrench className="w-3 h-3" />
                  Plugins
                  <span className="opacity-60">({skills.length})</span>
                </button>
                <button
                  onClick={() => setPluginSubTab('mcp-explorer')}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
                    pluginSubTab === 'mcp-explorer'
                      ? 'bg-emerald-500/15 text-emerald-400'
                      : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800'
                  }`}
                >
                  <Search className="w-3 h-3" />
                  MCP Explorer
                  <span className="opacity-60">({allMcps.length})</span>
                </button>
              </div>

              {/* ── Plugins List Sub-tab ──────────────────────────── */}
              {pluginSubTab === 'list' && (
                <div className="flex-1 flex flex-col min-h-0 p-5 gap-3">
                  {/* Header */}
                  <div className="flex items-center justify-between flex-shrink-0">
                    <h4 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                      <Wrench className="w-4 h-4 text-indigo-400" />
                      Plugins
                      <span className="text-dark-400 font-normal">({skills.length})</span>
                    </h4>
                    <button
                      onClick={() => { setShowCreate(!showCreate); setEditingPlugin(null); }}
                      className="flex items-center gap-1 px-2.5 py-1 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New Plugin
                    </button>
                  </div>

                  {/* OneDrive OAuth connection */}
                  <OneDriveConnect onStatusChange={() => onRefresh?.()} />

                  {/* Create plugin form */}
                  {showCreate && (
                    <div className="flex-shrink-0">
                      <PluginEditor
                        value={newPlugin}
                        onChange={setNewPlugin}
                        onSubmit={handleCreate}
                        onCancel={() => setShowCreate(false)}
                        saving={false}
                        submitLabel="Creer le plugin"
                      />
                    </div>
                  )}

                  {/* Plugins list (scrollable) */}
                  <div className="flex-1 overflow-auto min-h-0 space-y-1.5">
                    {skills.map(plugin => (
                      <div
                        key={plugin.id}
                        className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors group cursor-pointer ${
                          editingPlugin === plugin.id
                            ? 'bg-indigo-500/10 border-indigo-500/30'
                            : 'bg-dark-800/30 border-dark-700/30 hover:border-dark-600'
                        }`}
                        onClick={() => startEdit(plugin)}
                      >
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
                            {(plugin.mcps || []).length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30 flex items-center gap-0.5">
                                <Plug className="w-2.5 h-2.5" />
                                {(plugin.mcps || []).length} MCP
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-dark-500 truncate">{plugin.description}</p>
                        </div>
                        <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); handleDelete(plugin.id); }} className="p-1.5 text-dark-400 hover:text-red-400 rounded-md hover:bg-dark-700 transition-colors" title="Delete plugin">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                    {skills.length === 0 && (
                      <p className="text-center text-dark-500 text-xs py-8">No plugins created yet</p>
                    )}
                  </div>
                </div>
              )}

              {/* ── MCP Explorer Sub-tab ─────────────────────────── */}
              {pluginSubTab === 'mcp-explorer' && (
                <div className="flex-1 flex flex-col min-h-0 p-5 gap-3">
                  <div className="flex items-center justify-between flex-shrink-0">
                    <h4 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                      <Search className="w-4 h-4 text-emerald-400" />
                      MCP Explorer
                      <span className="text-dark-400 font-normal">({allMcps.length})</span>
                    </h4>
                    <p className="text-[11px] text-dark-500">Vue en lecture seule - editez les MCP depuis leur plugin</p>
                  </div>

                  <div className="flex-1 overflow-auto min-h-0 space-y-2">
                    {allMcps.length === 0 && (
                      <div className="text-center py-12">
                        <Plug className="w-8 h-8 text-dark-600 mx-auto mb-3" />
                        <p className="text-dark-500 text-sm">Aucun serveur MCP configure</p>
                        <p className="text-dark-600 text-xs mt-1">Ajoutez un MCP dans la configuration d'un plugin</p>
                      </div>
                    )}

                    {allMcps.map((mcp) => {
                      const expanded = expandedMcpExplorer.has(mcp.id || mcp.name);
                      const status = mcp.status || 'disconnected';
                      const tools = mcp.tools || [];

                      return (
                        <div key={mcp.id || mcp.name} className="rounded-lg border border-dark-700/30 bg-dark-800/20 hover:border-dark-600 transition-colors">
                          <div
                            className="flex items-center gap-2.5 px-3 py-2.5 cursor-pointer"
                            onClick={() => toggleMcpExpanded(mcp.id || mcp.name)}
                          >
                            <span className="text-base flex-shrink-0">{mcp.icon || '🔌'}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center gap-2">
                                <span className="text-sm font-medium text-dark-200">{mcp.name}</span>
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColors[status] || statusColors.disconnected}`} />
                                <span className={`text-[10px] ${
                                  status === 'connected' ? 'text-emerald-400' :
                                  status === 'error' ? 'text-red-400' :
                                  status === 'connecting' ? 'text-amber-400' :
                                  'text-dark-500'
                                }`}>
                                  {statusLabels[status] || status}
                                </span>
                              </div>
                              <div className="flex items-center gap-2 mt-0.5">
                                <span className="text-[11px] text-dark-500 font-mono truncate">{mcp.url || 'URL non configuree'}</span>
                              </div>
                            </div>
                            <div className="flex items-center gap-2 flex-shrink-0">
                              {mcp.source === 'plugin' && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/30 flex items-center gap-0.5">
                                  {mcp.pluginIcon} {mcp.pluginName}
                                </span>
                              )}
                              {mcp.source === 'standalone' && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-400 border border-dark-600">
                                  standalone
                                </span>
                              )}
                              <span className="text-[10px] text-dark-500">{tools.length} tool{tools.length !== 1 ? 's' : ''}</span>
                              <button
                                onClick={(e) => { e.stopPropagation(); handleConnectMcp(mcp.id); }}
                                disabled={!mcp.id || connectingMcp === mcp.id}
                                className="p-1 text-dark-400 hover:text-emerald-400 rounded transition-colors disabled:opacity-30"
                                title="Reconnecter"
                              >
                                <RefreshCw className={`w-3 h-3 ${connectingMcp === mcp.id ? 'animate-spin' : ''}`} />
                              </button>
                              {expanded ? <ChevronDown className="w-3.5 h-3.5 text-dark-400" /> : <ChevronRight className="w-3.5 h-3.5 text-dark-400" />}
                            </div>
                          </div>

                          {expanded && (
                            <div className="px-3 pb-3 border-t border-dark-700/30 pt-2">
                              {mcp.description && (
                                <p className="text-xs text-dark-400 mb-2">{mcp.description}</p>
                              )}

                              {mcp.error && (
                                <div className="mb-2 px-2 py-1.5 rounded bg-red-500/10 border border-red-500/20">
                                  <p className="text-[11px] text-red-400">Erreur: {mcp.error}</p>
                                </div>
                              )}

                              {mcp.authMode && (
                                <div className="mb-2 flex items-center gap-2">
                                  <span className="text-[11px] text-dark-500">Auth:</span>
                                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${
                                    mcp.authMode === 'bearer'
                                      ? 'bg-amber-500/20 text-amber-400 border-amber-500/30'
                                      : 'bg-dark-600/50 text-dark-400 border-dark-600/30'
                                  }`}>
                                    {mcp.authMode === 'bearer' ? 'Bearer Token' : 'Aucune'}
                                  </span>
                                  {mcp.hasApiKey && (
                                    <span className="text-[10px] text-emerald-400">Cle configuree</span>
                                  )}
                                </div>
                              )}

                              {tools.length > 0 ? (
                                <div>
                                  <p className="text-[11px] text-dark-500 font-medium mb-1.5">Outils disponibles ({tools.length})</p>
                                  <div className="space-y-1">
                                    {tools.map((tool, idx) => (
                                      <div key={idx} className="flex items-start gap-2 px-2 py-1.5 bg-dark-900/50 rounded border border-dark-700/20">
                                        <span className="text-[10px] text-emerald-400 font-mono mt-0.5 flex-shrink-0">{tool.name}</span>
                                        <span className="text-[10px] text-dark-500 flex-1">{tool.description || 'Pas de description'}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <p className="text-[11px] text-dark-500 italic">
                                  {status === 'connected' ? 'Aucun outil expose' : 'Connectez le serveur pour decouvrir les outils'}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
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

                {/* Clear In-Progress Tasks */}
                <div className="p-4 bg-dark-800/30 rounded-xl border border-dark-700/30 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <ListX className="w-4 h-4 text-dark-300" />
                      <span className="text-sm font-medium text-dark-200">Clear In-Progress Tasks</span>
                    </div>
                    <p className="text-xs text-dark-500">Remove in-progress tasks for every agent</p>
                  </div>
                  <ConfirmButton
                    onConfirm={handleClearAllInProgressTasks}
                    disabled={agents.length === 0}
                    icon={ListX}
                    label="Clear"
                    confirmLabel="Confirm?"
                    className="flex items-center gap-1.5 px-4 py-2 bg-dark-700 text-dark-300 hover:text-dark-100 hover:bg-dark-600 rounded-lg transition-colors text-sm font-medium disabled:opacity-40 flex-shrink-0"
                    confirmClassName="flex items-center gap-1.5 px-4 py-2 bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors text-sm font-medium flex-shrink-0 animate-pulse"
                  />
                </div>

                {/* Clear All Tasks */}
                <div className="p-4 bg-dark-800/30 rounded-xl border border-dark-700/30 flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-0.5">
                      <Eraser className="w-4 h-4 text-dark-300" />
                      <span className="text-sm font-medium text-dark-200">Clear All Tasks</span>
                    </div>
                    <p className="text-xs text-dark-500">Delete all tasks for every agent</p>
                  </div>
                  <ConfirmButton
                    onConfirm={handleClearAllTasks}
                    disabled={agents.length === 0}
                    icon={Eraser}
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
        {/* ── Right panel: Plugin editor ── */}
        {editingPlugin && (
          <div className="hidden sm:flex flex-col w-[400px] border-l border-dark-700 bg-dark-850 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-dark-700 flex-shrink-0">
              <div className="flex items-center gap-2">
                <Pencil className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-sm font-semibold text-dark-100">Edit Plugin</span>
              </div>
              <button onClick={cancelEdit} className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto">
              <PluginEditor
                value={editForm}
                onChange={setEditForm}
                onSubmit={saveEdit}
                onCancel={cancelEdit}
                saving={false}
                submitLabel="Sauvegarder"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
