import { useState } from 'react';
import {
  X, ChevronDown, ChevronRight, Save,
  Zap, Wrench, Loader, XCircle, Key, CheckCircle,
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

export default function PluginsTab({ agent, plugins, onRefresh }) {
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [authDraft, setAuthDraft] = useState({});
  const [savingAuth, setSavingAuth] = useState(false);
  const [authSaved, setAuthSaved] = useState(false);
  const [expandedPlugin, setExpandedPlugin] = useState(null);
  const [mcpTestResults, setMcpTestResults] = useState({});
  const [mcpTesting, setMcpTesting] = useState({});

  const agentPluginIds = agent.skills || [];
  const assignedPlugins = plugins.filter(s => agentPluginIds.includes(s.id));
  const availablePlugins = plugins.filter(s => !agentPluginIds.includes(s.id));

  const categories = ['all', ...new Set(plugins.map(s => s.category).filter(Boolean))];
  const filteredAvailable = categoryFilter === 'all'
    ? availablePlugins
    : availablePlugins.filter(s => s.category === categoryFilter);

  const handleAssign = async (pluginId) => {
    await api.assignPlugin(agent.id, pluginId);
    onRefresh();
  };

  const handleRemove = async (pluginId) => {
    await api.removePlugin(agent.id, pluginId);
    onRefresh();
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

  const mcpAuth = agent.mcpAuth || {};
  const hasDraftChanges = Object.keys(authDraft).length > 0;

  // Detect if OneDrive MCP is among the assigned plugins' MCPs
  const ONEDRIVE_MCP_ID = 'mcp-onedrive';
  const hasOneDriveMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === ONEDRIVE_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(ONEDRIVE_MCP_ID)
  );

  // Detect if Gmail MCP is among the assigned plugins' MCPs
  const GMAIL_MCP_ID = 'mcp-gmail';
  const hasGmailMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === GMAIL_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(GMAIL_MCP_ID)
  );

  const OUTLOOK_MCP_ID = 'mcp-outlook';
  const hasOutlookMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === OUTLOOK_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(OUTLOOK_MCP_ID)
  );

  const GDRIVE_MCP_ID = 'mcp-gdrive';
  const hasGdriveMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === GDRIVE_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(GDRIVE_MCP_ID)
  );

  // Detect if Slack MCP is among the assigned plugins' MCPs
  const SLACK_MCP_ID = 'mcp-slack';
  const hasSlackMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === SLACK_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(SLACK_MCP_ID)
  );

  // Detect if Jira MCP is among the assigned plugins' MCPs
  const JIRA_MCP_ID = 'mcp-jira';
  const hasJiraMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === JIRA_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(JIRA_MCP_ID)
  );

  const GITHUB_MCP_ID = 'mcp-github';
  const hasGitHubMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === GITHUB_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(GITHUB_MCP_ID)
  );

  const WORDPRESS_MCP_ID = 'mcp-wordpress';
  const hasWordPressMcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === WORDPRESS_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(WORDPRESS_MCP_ID)
  );

  const S3_MCP_ID = 'mcp-aws-s3';
  const hasS3Mcp = assignedPlugins.some(plugin =>
    (plugin.mcps || []).some(m => m.id === S3_MCP_ID) ||
    (plugin.mcpServerIds || []).includes(S3_MCP_ID)
  );

  const handleSaveAuth = async () => {
    setSavingAuth(true);
    try {
      await api.updateAgent(agent.id, { mcpAuth: authDraft });
      setAuthDraft({});
      setAuthSaved(true);
      setTimeout(() => setAuthSaved(false), 2000);
      onRefresh();
    } catch (err) {
      console.error('Failed to save MCP auth:', err);
    } finally {
      setSavingAuth(false);
    }
  };

  const handleTestMcp = async (mcpId) => {
    setMcpTesting(prev => ({ ...prev, [mcpId]: true }));
    setMcpTestResults(prev => ({ ...prev, [mcpId]: undefined }));
    try {
      // Use draft key if being edited, else the saved per-agent key
      const draftKey = authDraft[mcpId]?.apiKey;
      const savedAuth = mcpAuth[mcpId];
      // We can't send the real saved key (it's masked), so only send draft or nothing
      const testKey = draftKey !== undefined ? draftKey : undefined;
      const result = await api.testMcpServer(mcpId, testKey || undefined);
      setMcpTestResults(prev => ({ ...prev, [mcpId]: result }));
    } catch (err) {
      setMcpTestResults(prev => ({ ...prev, [mcpId]: { success: false, error: err.message } }));
    } finally {
      setMcpTesting(prev => ({ ...prev, [mcpId]: false }));
    }
  };

  return (
    <div className="p-4 space-y-5 overflow-auto">
      <div>
        <h3 className="font-medium text-dark-200 text-sm mb-3">
          Assigned Plugins
          <span className="ml-2 text-dark-400 font-normal">({assignedPlugins.length})</span>
        </h3>
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
                        Per-agent API keys — leave empty to use global plugin config
                      </p>
                      {pluginMcps.map(mcp => {
                        const serverAuth = mcpAuth[mcp.id] || {};
                        const hasKey = serverAuth.hasApiKey;
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
                                title="Remove per-agent key (use global)"
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
            <p className="text-dark-500 text-xs">No plugins assigned</p>
          </div>
        )}
        {hasOneDriveMcp && (
          <div className="mt-3">
            <OneDriveConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasGmailMcp && (
          <div className="mt-3">
            <GmailConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasOutlookMcp && (
          <div className="mt-3">
            <OutlookConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasGdriveMcp && (
          <div className="mt-3">
            <GoogleDriveConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasSlackMcp && (
          <div className="mt-3">
            <SlackConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasJiraMcp && (
          <div className="mt-3">
            <JiraConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasWordPressMcp && (
          <div className="mt-3">
            <WordPressConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasGitHubMcp && (
          <div className="mt-3">
            <GitHubConnect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
        {hasS3Mcp && (
          <div className="mt-3">
            <S3Connect agentId={agent.id} onStatusChange={() => onRefresh?.()} />
          </div>
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className="font-medium text-dark-200 text-sm">
            Available Plugins
            <span className="ml-2 text-dark-400 font-normal">({filteredAvailable.length})</span>
          </h3>
        </div>

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

        <div className="space-y-2 mt-3">
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
                  {plugin.userConfig && Object.keys(plugin.userConfig).length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-500/20 text-amber-400 border-amber-500/30">
                      config utilisateur
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
  );
}
