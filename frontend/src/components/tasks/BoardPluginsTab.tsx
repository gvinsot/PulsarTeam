import { useState, useEffect, useCallback } from 'react';
import {
  X, ChevronDown, ChevronRight, Save,
  Zap, Wrench, Loader, XCircle, Key, CheckCircle, Puzzle,
} from 'lucide-react';
import { api } from '../../api';
import OneDriveConnect from '../OneDriveConnect';
import OutlookConnect from '../OutlookConnect';
import GmailConnect from '../GmailConnect';
import GoogleDriveConnect from '../GoogleDriveConnect';
import SlackConnect from '../SlackConnect';
import JiraConnect from '../JiraConnect';
import WordPressConnect from '../WordPressConnect';
import GitHubConnect from '../GitHubConnect';
import S3Connect from '../S3Connect';

export default function BoardPluginsTab({ board, onClose }) {
  const [plugins, setPlugins] = useState([]);
  const [boardPlugins, setBoardPlugins] = useState([]);
  const [mcpAuth, setMcpAuth] = useState({});
  const [loading, setLoading] = useState(true);
  const [authDraft, setAuthDraft] = useState({});
  const [savingAuth, setSavingAuth] = useState(false);
  const [authSaved, setAuthSaved] = useState(false);
  const [expandedPlugin, setExpandedPlugin] = useState(null);
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [mcpTestResults, setMcpTestResults] = useState({});
  const [mcpTesting, setMcpTesting] = useState({});

  const loadData = useCallback(async () => {
    try {
      const [allPlugins, boardData] = await Promise.all([
        api.getPlugins(),
        api.getBoardPlugins(board.id),
      ]);
      setPlugins(allPlugins);
      setBoardPlugins(boardData.plugins || []);
      setMcpAuth(boardData.mcpAuth || {});
    } catch (err) {
      console.error('Failed to load board plugins:', err);
    } finally {
      setLoading(false);
    }
  }, [board.id]);

  useEffect(() => { loadData(); }, [loadData]);

  const assignedPlugins = plugins.filter(p => boardPlugins.includes(p.id));
  const availablePlugins = plugins.filter(p => !boardPlugins.includes(p.id));
  const categories = ['all', ...new Set(plugins.map(s => s.category).filter(Boolean))];
  const filteredAvailable = categoryFilter === 'all'
    ? availablePlugins
    : availablePlugins.filter(s => s.category === categoryFilter);

  const handleAssign = async (pluginId) => {
    await api.assignBoardPlugin(board.id, pluginId);
    setBoardPlugins(prev => [...prev, pluginId]);
  };

  const handleRemove = async (pluginId) => {
    await api.removeBoardPlugin(board.id, pluginId);
    setBoardPlugins(prev => prev.filter(id => id !== pluginId));
  };

  const ONEDRIVE_MCP_ID = 'mcp-onedrive';
  const OUTLOOK_MCP_ID = 'mcp-outlook';
  const GMAIL_MCP_ID = 'mcp-gmail';
  const GDRIVE_MCP_ID = 'mcp-gdrive';
  const SLACK_MCP_ID = 'mcp-slack';
  const JIRA_MCP_ID = 'mcp-jira';
  const WORDPRESS_MCP_ID = 'mcp-wordpress';
  const GITHUB_MCP_ID = 'mcp-github';
  const S3_MCP_ID = 'mcp-aws-s3';

  const hasMcp = (mcpId) => assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === mcpId) ||
    (plugin.mcpServerIds || []).includes(mcpId)
  );

  const hasDraftChanges = Object.keys(authDraft).length > 0;

  const handleSaveAuth = async () => {
    setSavingAuth(true);
    try {
      const merged = { ...mcpAuth, ...authDraft };
      await api.updateBoardMcpAuth(board.id, merged);
      setMcpAuth(merged);
      setAuthDraft({});
      setAuthSaved(true);
      setTimeout(() => setAuthSaved(false), 2000);
    } catch (err) {
      console.error('Failed to save board MCP auth:', err);
    } finally {
      setSavingAuth(false);
    }
  };

  const handleTestMcp = async (mcpId) => {
    setMcpTesting(prev => ({ ...prev, [mcpId]: true }));
    setMcpTestResults(prev => ({ ...prev, [mcpId]: undefined }));
    try {
      const draftKey = authDraft[mcpId]?.apiKey;
      const result = await api.testMcpServer(mcpId, draftKey || undefined);
      setMcpTestResults(prev => ({ ...prev, [mcpId]: result }));
    } catch (err) {
      setMcpTestResults(prev => ({ ...prev, [mcpId]: { success: false, error: err.message } }));
    } finally {
      setMcpTesting(prev => ({ ...prev, [mcpId]: false }));
    }
  };

  const categoryColors = {
    coding: 'bg-blue-500/20 text-blue-400 border-blue-500/30',
    devops: 'bg-orange-500/20 text-orange-400 border-orange-500/30',
    writing: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    security: 'bg-red-500/20 text-red-400 border-red-500/30',
    analysis: 'bg-purple-500/20 text-purple-400 border-purple-500/30',
    general: 'bg-dark-500/20 text-dark-300 border-dark-500/30',
  };
  const getCategoryClass = (cat) => categoryColors[cat] || categoryColors.general;

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
        <div className="bg-dark-800 rounded-xl border border-dark-700 p-8">
          <Loader className="w-6 h-6 text-indigo-400 animate-spin mx-auto" />
          <p className="text-dark-400 text-sm mt-3">Loading board plugins...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={onClose}>
      <div
        className="bg-dark-800 rounded-xl border border-dark-700 shadow-2xl w-full max-w-2xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Puzzle className="w-5 h-5 text-indigo-400" />
            <h2 className="text-lg font-semibold text-dark-100">Board Plugins</h2>
            <span className="text-xs text-dark-500">{board.name}</span>
          </div>
          <button onClick={onClose} className="p-1 text-dark-400 hover:text-dark-200 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4 space-y-5">
          {/* Assigned plugins */}
          <div>
            <h3 className="font-medium text-dark-200 text-sm mb-3">
              Board Plugins
              <span className="ml-2 text-dark-400 font-normal">({assignedPlugins.length})</span>
            </h3>
            <p className="text-[11px] text-dark-500 mb-3">
              Plugins assigned here are available to all agents working on this board. Agent-level auth takes priority over board-level auth.
            </p>
            {assignedPlugins.length > 0 ? (
              <div className="space-y-2">
                {assignedPlugins.map(plugin => {
                  const pluginMcps = (plugin.mcps || []).filter(m => m.id);
                  const isExpanded = expandedPlugin === plugin.id;
                  return (
                    <div key={plugin.id} className="bg-dark-800/50 rounded-lg border border-dark-700/50">
                      <div className="flex items-center gap-3 p-3 group">
                        {pluginMcps.length > 0 && (
                          <button onClick={() => setExpandedPlugin(isExpanded ? null : plugin.id)} className="p-0.5 text-dark-500 hover:text-dark-300 transition-colors flex-shrink-0">
                            {isExpanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                          </button>
                        )}
                        <span className="text-lg flex-shrink-0">{plugin.icon}</span>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-sm font-medium text-dark-200">{plugin.name}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                              {plugin.category}
                            </span>
                            {pluginMcps.length > 0 && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                                {pluginMcps.length} MCP
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-dark-400 truncate">{plugin.description}</p>
                        </div>
                        <button
                          onClick={() => handleRemove(plugin.id)}
                          className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                          title="Remove plugin"
                        >
                          <X className="w-4 h-4" />
                        </button>
                      </div>
                      {isExpanded && pluginMcps.length > 0 && (
                        <div className="px-3 pb-3 pt-0 space-y-1.5 border-t border-dark-700/30 mt-0">
                          <p className="text-[10px] text-dark-500 pt-2 flex items-center gap-1.5">
                            <Key className="w-3 h-3 text-amber-400" />
                            Board-level API keys — shared by all agents on this board
                          </p>
                          {pluginMcps.map(mcp => {
                            const serverAuth = mcpAuth[mcp.id] || {};
                            const hasKey = serverAuth.hasApiKey || !!serverAuth.apiKey;
                            const draftValue = authDraft[mcp.id]?.apiKey;
                            const isDirty = draftValue !== undefined;
                            return (
                              <div key={mcp.id} className="flex items-center gap-2.5 pl-2">
                                <span className="text-sm flex-shrink-0">{mcp.icon || '🔌'}</span>
                                <span className="text-xs text-dark-300 min-w-0 truncate flex-1">{mcp.name}</span>
                                {hasKey && !isDirty && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30 flex-shrink-0">
                                    key set
                                  </span>
                                )}
                                {!hasKey && !isDirty && (
                                  <span className="text-[9px] px-1.5 py-0.5 rounded-full border bg-dark-700 text-dark-500 border-dark-600 flex-shrink-0">
                                    global
                                  </span>
                                )}
                                <input
                                  type="password"
                                  value={draftValue ?? ''}
                                  onChange={(e) => setAuthDraft(prev => ({
                                    ...prev,
                                    [mcp.id]: { apiKey: e.target.value }
                                  }))}
                                  placeholder={hasKey ? '••••••••' : 'API key'}
                                  className="w-36 px-2 py-1 bg-dark-900 border border-dark-600 rounded text-[11px] text-dark-100 placeholder-dark-600 focus:outline-none focus:border-indigo-500 font-mono flex-shrink-0"
                                />
                                <button
                                  onClick={() => handleTestMcp(mcp.id)}
                                  disabled={mcpTesting[mcp.id]}
                                  className={`p-1 transition-colors flex-shrink-0 ${
                                    mcpTestResults[mcp.id]?.success === true ? 'text-emerald-400' :
                                    mcpTestResults[mcp.id]?.success === false ? 'text-red-400' :
                                    'text-dark-500 hover:text-amber-400'
                                  }`}
                                  title={mcpTestResults[mcp.id]?.success === false ? mcpTestResults[mcp.id].error : 'Test connection'}
                                >
                                  {mcpTesting[mcp.id] ? <Loader className="w-3 h-3 animate-spin" /> :
                                   mcpTestResults[mcp.id]?.success === true ? <CheckCircle className="w-3 h-3" /> :
                                   mcpTestResults[mcp.id]?.success === false ? <XCircle className="w-3 h-3" /> :
                                   <Zap className="w-3 h-3" />}
                                </button>
                                {hasKey && !isDirty && (
                                  <button
                                    onClick={() => setAuthDraft(prev => ({ ...prev, [mcp.id]: { apiKey: '' } }))}
                                    className="p-0.5 text-dark-500 hover:text-red-400 transition-colors flex-shrink-0"
                                    title="Remove board key"
                                  >
                                    <XCircle className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
                {hasDraftChanges && (
                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={handleSaveAuth}
                      disabled={savingAuth}
                      className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs font-medium disabled:opacity-40 transition-colors flex items-center gap-1.5"
                    >
                      {savingAuth ? <Loader className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                      Save Keys
                    </button>
                    <button
                      onClick={() => setAuthDraft({})}
                      className="px-3 py-1.5 text-dark-400 hover:text-dark-200 text-xs"
                    >
                      Cancel
                    </button>
                    {authSaved && <span className="text-xs text-emerald-400">Saved!</span>}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-center py-4 border border-dashed border-dark-700 rounded-lg">
                <Wrench className="w-5 h-5 mx-auto mb-1 text-dark-500 opacity-40" />
                <p className="text-dark-500 text-xs">No plugins assigned to this board</p>
              </div>
            )}

            {/* OAuth connect widgets for board-level auth */}
            {hasMcp(ONEDRIVE_MCP_ID) && (
              <div className="mt-3">
                <OneDriveConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(GMAIL_MCP_ID) && (
              <div className="mt-3">
                <GmailConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(OUTLOOK_MCP_ID) && (
              <div className="mt-3">
                <OutlookConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(GDRIVE_MCP_ID) && (
              <div className="mt-3">
                <GoogleDriveConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(SLACK_MCP_ID) && (
              <div className="mt-3">
                <SlackConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(JIRA_MCP_ID) && (
              <div className="mt-3">
                <JiraConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(WORDPRESS_MCP_ID) && (
              <div className="mt-3">
                <WordPressConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(GITHUB_MCP_ID) && (
              <div className="mt-3">
                <GitHubConnect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
            {hasMcp(S3_MCP_ID) && (
              <div className="mt-3">
                <S3Connect boardId={board.id} onStatusChange={() => loadData()} />
              </div>
            )}
          </div>

          {/* Available plugins */}
          <div>
            <h3 className="font-medium text-dark-200 text-sm mb-3">
              Available Plugins
              <span className="ml-2 text-dark-400 font-normal">({filteredAvailable.length})</span>
            </h3>

            <div className="flex flex-wrap gap-1.5 mb-3">
              {categories.map(cat => (
                <button
                  key={cat}
                  onClick={() => setCategoryFilter(cat)}
                  className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition-colors border ${
                    categoryFilter === cat
                      ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                      : 'bg-dark-800 text-dark-400 border-dark-700 hover:text-dark-200'
                  }`}
                >
                  {cat === 'all' ? 'All' : cat}
                </button>
              ))}
            </div>

            <div className="space-y-2">
              {filteredAvailable.map(plugin => (
                <div key={plugin.id} className="flex items-center gap-3 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30 hover:border-dark-600 transition-colors group">
                  <span className="text-lg flex-shrink-0">{plugin.icon}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-dark-300">{plugin.name}</span>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                        {plugin.category}
                      </span>
                      {(plugin.mcps || []).length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                          {(plugin.mcps || []).length} MCP
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-dark-500 truncate">{plugin.description}</p>
                  </div>
                  <button
                    onClick={() => handleAssign(plugin.id)}
                    className="px-2.5 py-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded-md text-xs font-medium transition-colors flex-shrink-0"
                  >
                    Add
                  </button>
                </div>
              ))}
              {filteredAvailable.length === 0 && (
                <p className="text-center text-dark-500 text-xs py-4">
                  {availablePlugins.length === 0 ? 'All plugins assigned' : 'No plugins in this category'}
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
