import { useState } from 'react';
import { X, Wrench, KeyRound, Globe, Lock } from 'lucide-react';
import { api } from '../../api';
import PluginEditor from '../PluginEditor';
import { AssignedPluginCard, AvailablePluginRow, CategoryFilterPills } from '../plugins/pluginShared';

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
  // Surfaced when an assign/remove API call fails — otherwise the click
  // silently does nothing and the user believes the plugin was attached.
  const [actionError, setActionError] = useState<string | null>(null);

  // Activation modal state: the plugin being activated and the editable form.
  const [activatingPlugin, setActivatingPlugin] = useState<any | null>(null);
  const [activationForm, setActivationForm] = useState<any>(null);
  const [activationSaving, setActivationSaving] = useState(false);
  const [activationError, setActivationError] = useState<string | null>(null);

  const agentPluginIds = agent.skills || [];
  const assignedPlugins = plugins.filter(s => agentPluginIds.includes(s.id));
  const availablePlugins = plugins.filter(s => !agentPluginIds.includes(s.id));

  const categories = ['all', ...new Set<string>(plugins.map(s => s.category).filter(Boolean))];
  const filteredAvailable = categoryFilter === 'all'
    ? availablePlugins
    : availablePlugins.filter(s => s.category === categoryFilter);

  const startActivation = (plugin) => {
    setActivationError(null);
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
    setActivationError(null);
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
      setActivationError(err?.message || "Échec de l'activation du plugin");
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
    setActionError(null);
    try {
      await api.assignPlugin(agent.id, plugin.id);
      onRefresh();
    } catch (err) {
      console.error('Failed to assign plugin:', err);
      setActionError(err?.message || "Échec de l'ajout du plugin");
    }
  };

  const handleRemove = async (pluginId) => {
    setActionError(null);
    try {
      await api.removePlugin(agent.id, pluginId);
      onRefresh();
    } catch (err) {
      console.error('Failed to remove plugin:', err);
      setActionError(err?.message || 'Échec du retrait du plugin');
    }
  };

  return (
    <div className="p-4 space-y-5 overflow-auto">
      {actionError && (
        <p className="text-xs text-red-400 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
          {actionError}
        </p>
      )}
      <div>
        <h3 className="font-medium text-dark-200 text-sm mb-3">
          Assigned Plugins
          <span className="ml-2 text-dark-400 font-normal">({assignedPlugins.length})</span>
        </h3>
        {assignedPlugins.length > 0 ? (
          <div className="space-y-2">
            {assignedPlugins.map(plugin => (
              <AssignedPluginCard
                key={plugin.id}
                plugin={plugin}
                connectorProps={{ agentId: agent.id, onStatusChange: () => onRefresh?.() }}
                onRemove={() => handleRemove(plugin.id)}
                badges={plugin.shared && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                    <Globe className="w-2.5 h-2.5" /> partagé
                  </span>
                )}
                extraActions={(
                  <button
                    onClick={() => startActivation(plugin)}
                    className="p-1.5 text-dark-400 hover:text-amber-400 opacity-0 group-hover:opacity-100 transition-all flex-shrink-0"
                    title="Modifier mes accès"
                  >
                    <KeyRound className="w-3.5 h-3.5" />
                  </button>
                )}
              />
            ))}
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

        <CategoryFilterPills categories={categories} value={categoryFilter} onChange={setCategoryFilter} />

        <div className="space-y-2 mt-3">
          {filteredAvailable.map(plugin => {
            const needsCreds = pluginNeedsCredentials(plugin);
            return (
              <AvailablePluginRow
                key={plugin.id}
                plugin={plugin}
                onAdd={() => handleAssign(plugin)}
                addLabel={needsCreds ? <><KeyRound className="w-3 h-3" /> Activer</> : 'Add'}
                beforeMcpBadges={plugin.shared ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                    <Globe className="w-2.5 h-2.5" /> partagé
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700/60 text-dark-400 border border-dark-600 flex items-center gap-0.5">
                    <Lock className="w-2.5 h-2.5" /> privé
                  </span>
                )}
                afterMcpBadges={needsCreds && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full border bg-amber-500/15 text-amber-400 border-amber-500/30 flex items-center gap-0.5">
                    <KeyRound className="w-2.5 h-2.5" /> auth requise
                  </span>
                )}
              />
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
              {activationError && (
                <p className="mb-3 text-xs text-red-400 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                  {activationError}
                </p>
              )}
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
