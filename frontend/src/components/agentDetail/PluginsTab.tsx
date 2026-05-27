import { useState } from 'react';
import { X, Wrench, KeyRound, Globe, Lock } from 'lucide-react';
import { api } from '../../api';
import PluginEditor from '../PluginEditor';
import OneDriveConnect from '../OneDriveConnect';
import OutlookConnect from '../OutlookConnect';
import GmailConnect from '../GmailConnect';
import GoogleDriveConnect from '../GoogleDriveConnect';
import SlackConnect from '../SlackConnect';
import JiraConnect from '../JiraConnect';
import WordPressConnect from '../WordPressConnect';
import GitHubConnect from '../GitHubConnect';
import S3Connect from '../S3Connect';

// Map MCP server IDs to their dedicated OAuth/API-key connector widget.
// Returning null means the MCP doesn't need an interactive connector here
// (it's wired via global env vars or doesn't expose a setup UI).
const MCP_CONNECTOR_MAP: Record<string, any> = {
  'mcp-onedrive': OneDriveConnect,
  'mcp-gmail': GmailConnect,
  'mcp-outlook': OutlookConnect,
  'mcp-gdrive': GoogleDriveConnect,
  'mcp-slack': SlackConnect,
  'mcp-jira': JiraConnect,
  'mcp-wordpress': WordPressConnect,
  'mcp-github': GitHubConnect,
  'mcp-aws-s3': S3Connect,
};

function getPluginMcpIds(plugin: any): string[] {
  const ids = new Set<string>();
  for (const m of plugin.mcps || []) {
    if (m?.id) ids.add(m.id);
  }
  for (const id of plugin.mcpServerIds || []) {
    if (id) ids.add(id);
  }
  return Array.from(ids);
}

// True if the plugin has at least one MCP that needs a bearer token AND no
// per-MCP key is already stored (the user is expected to provide their own).
function pluginNeedsCredentials(plugin: any): boolean {
  return (plugin.mcps || []).some((m: any) => {
    const auth = m.authMode || (m.hasApiKey || m.apiKey ? 'bearer' : 'none');
    return auth === 'bearer' && !m.hasApiKey;
  });
}

export default function PluginsTab({ agent, plugins, onRefresh }) {
  const [categoryFilter, setCategoryFilter] = useState('all');

  // Activation modal state: the plugin being activated and the editable form.
  const [activatingPlugin, setActivatingPlugin] = useState<any | null>(null);
  const [activationForm, setActivationForm] = useState<any>(null);
  const [activationSaving, setActivationSaving] = useState(false);

  const agentPluginIds = agent.skills || [];
  const assignedPlugins = plugins.filter(s => agentPluginIds.includes(s.id));
  const availablePlugins = plugins.filter(s => !agentPluginIds.includes(s.id));

  const categories = ['all', ...new Set(plugins.map(s => s.category).filter(Boolean))];
  const filteredAvailable = categoryFilter === 'all'
    ? availablePlugins
    : availablePlugins.filter(s => s.category === categoryFilter);

  const startActivation = (plugin) => {
    setActivatingPlugin(plugin);
    setActivationForm({
      name: plugin.name,
      description: plugin.description || '',
      category: plugin.category || 'general',
      icon: plugin.icon || '🔧',
      instructions: plugin.instructions || '',
      userConfig: plugin.userConfig || {},
      mcps: Array.isArray(plugin.mcps) ? plugin.mcps.map((m: any) => ({ ...m })) : [],
      shared: !!plugin.shared,
    });
  };

  const cancelActivation = () => {
    setActivatingPlugin(null);
    setActivationForm(null);
  };

  const confirmActivation = async () => {
    if (!activatingPlugin) return;
    setActivationSaving(true);
    try {
      // 1. Push credential updates first (only userConfig + mcps[].apiKey/authMode/enabled).
      const credentialPayload = {
        userConfig: activationForm.userConfig || {},
        mcps: activationForm.mcps || [],
      };
      await api.updatePlugin(activatingPlugin.id, credentialPayload);
      // 2. Assign the plugin to this agent.
      await api.assignPlugin(agent.id, activatingPlugin.id);
      cancelActivation();
      onRefresh();
    } catch (err) {
      console.error('Failed to activate plugin:', err);
    } finally {
      setActivationSaving(false);
    }
  };

  const handleAssign = async (plugin) => {
    // If the plugin needs credentials we don't yet have, open the activation modal.
    if (pluginNeedsCredentials(plugin)) {
      startActivation(plugin);
      return;
    }
    // Otherwise assign directly — no creds needed.
    await api.assignPlugin(agent.id, plugin.id);
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
              const connectorMcpIds = getPluginMcpIds(plugin).filter(id => MCP_CONNECTOR_MAP[id]);
              return (
                <div key={plugin.id} className="bg-dark-800/50 rounded-lg border border-dark-700/50">
                  <div className="flex items-center gap-3 p-3 group">
                    <span className="text-lg flex-shrink-0">{plugin.icon}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium text-dark-200">{plugin.name}</span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                          {plugin.category}
                        </span>
                        {plugin.shared && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                            <Globe className="w-2.5 h-2.5" /> partagé
                          </span>
                        )}
                        {pluginMcps.length > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                            {pluginMcps.length} MCP
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-dark-400 truncate">{plugin.description}</p>
                    </div>
                    <button
                      onClick={() => startActivation(plugin)}
                      className="p-1.5 text-dark-400 hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="Modifier mes accès"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={() => handleRemove(plugin.id)}
                      className="p-1 text-dark-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                      title="Remove plugin"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {connectorMcpIds.length > 0 && (
                    <div className="px-3 pb-3 space-y-2">
                      {connectorMcpIds.map(mcpId => {
                        const Connector = MCP_CONNECTOR_MAP[mcpId];
                        return (
                          <Connector
                            key={mcpId}
                            agentId={agent.id}
                            onStatusChange={() => onRefresh?.()}
                          />
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="text-center py-4 border border-dashed border-dark-700 rounded-lg">
            <Wrench className="w-5 h-5 mx-auto mb-1 text-dark-500 opacity-40" />
            <p className="text-dark-500 text-xs">No plugins assigned</p>
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
          {filteredAvailable.map(plugin => {
            const needsCreds = pluginNeedsCredentials(plugin);
            return (
            <div key={plugin.id} className="flex items-center gap-3 p-3 bg-dark-800/30 rounded-lg border border-dark-700/30 hover:border-dark-600 transition-colors group">
              <span className="text-lg flex-shrink-0">{plugin.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium text-dark-300">{plugin.name}</span>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full border ${getCategoryClass(plugin.category)}`}>
                    {plugin.category}
                  </span>
                  {plugin.shared ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                      <Globe className="w-2.5 h-2.5" /> partagé
                    </span>
                  ) : (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700/60 text-dark-400 border border-dark-600 flex items-center gap-0.5">
                      <Lock className="w-2.5 h-2.5" /> privé
                    </span>
                  )}
                  {(plugin.mcps || []).length > 0 && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-400 border-emerald-500/30">
                      {(plugin.mcps || []).length} MCP
                    </span>
                  )}
                  {needsCreds && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-500/15 text-amber-400 border-amber-500/30 flex items-center gap-0.5">
                      <KeyRound className="w-2.5 h-2.5" /> auth requise
                    </span>
                  )}
                </div>
                <p className="text-xs text-dark-500 truncate">{plugin.description}</p>
              </div>
              <button
                onClick={() => handleAssign(plugin)}
                className="px-2.5 py-1 bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-400 rounded-md text-xs font-medium transition-colors flex-shrink-0 flex items-center gap-1"
              >
                {needsCreds ? <><KeyRound className="w-3 h-3" /> Activer</> : 'Add'}
              </button>
            </div>
            );
          })}
          {filteredAvailable.length === 0 && (
            <p className="text-center text-dark-500 text-xs py-4">
              {availablePlugins.length === 0 ? 'All plugins assigned' : 'No plugins in this category'}
            </p>
          )}
        </div>
      </div>

      {/* ── Activation modal ──────────────────────────────────────── */}
      {activatingPlugin && activationForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fadeIn p-4">
          <div className="w-full max-w-lg bg-dark-900 rounded-2xl border border-dark-700 shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-dark-700 flex-shrink-0">
              <div className="flex items-center gap-2">
                <KeyRound className="w-4 h-4 text-amber-400" />
                <h3 className="font-semibold text-dark-100 text-sm">Activer ce plugin</h3>
              </div>
              <button
                onClick={cancelActivation}
                className="p-1.5 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-4">
              <PluginEditor
                value={activationForm}
                onChange={setActivationForm}
                onSubmit={confirmActivation}
                onCancel={cancelActivation}
                saving={activationSaving}
                submitLabel="Activer sur cet agent"
                mode="activate"
              />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
