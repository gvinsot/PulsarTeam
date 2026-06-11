import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, RotateCw, Save, Shield, ShieldOff, Zap, CheckCircle, XCircle, Loader, Globe, Lock, KeyRound, Info } from 'lucide-react';
import { api } from '../api';

function createEmptyMcp() {
  return {
    id: undefined,
    name: '',
    url: '',
    description: '',
    icon: '🔌',
    enabled: true,
    authMode: 'none',
    apiKey: '',
  };
}

function parseKeyValueText(text) {
  const lines = text.split(/\r?\n/);
  const obj = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx === -1) {
      obj[trimmed] = '';
    } else {
      obj[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
  }
  return obj;
}

function stringifyKeyValue(obj) {
  return Object.entries(obj || {}).map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
}

/**
 * PluginEditor renders one of two distinct experiences based on `mode`:
 *
 *  - mode="configure"  → full plugin authoring UI (name, description, instructions,
 *                        MCP server URL/auth, sharing toggle, user-specific config).
 *                        Use this for plugin owners and admins.
 *
 *  - mode="activate"   → minimal activation UI: the plugin is presented as a read-only
 *                        card and the user can only set the OAuth/API-key credentials
 *                        needed to use the plugin. Use this when a user is enabling a
 *                        plugin they do not own (shared plugins, built-ins).
 *
 * The legacy `readOnly` prop is still accepted and treated as `mode="activate"`.
 */
export default function PluginEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  saving,
  submitLabel,
  readOnly = false,
  mode,
}) {
  const resolvedMode = mode || (readOnly ? 'activate' : 'configure');
  const isActivate = resolvedMode === 'activate';
  const effectiveSubmitLabel = submitLabel || (isActivate ? 'Activer le plugin' : 'Save Plugin');

  const [expandedMcps, setExpandedMcps] = useState(() => new Set((value.mcps || []).map((_, i) => i)));
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState({});
  // Keep the raw textarea text in local state so typed newlines survive;
  // only reset it when the config changes from outside (e.g. another plugin).
  const [userConfigText, setUserConfigText] = useState(() => stringifyKeyValue(value.userConfig || {}));
  useEffect(() => {
    const canonical = stringifyKeyValue(value.userConfig || {});
    setUserConfigText(prev => (stringifyKeyValue(parseKeyValueText(prev)) === canonical ? prev : canonical));
  }, [value.userConfig]);

  const update = (patch) => onChange({ ...value, ...patch });

  const testMcp = async (mcp) => {
    if (!mcp.id) return;
    setTesting(prev => ({ ...prev, [mcp.id]: true }));
    setTestResults(prev => ({ ...prev, [mcp.id]: undefined }));
    try {
      // Send the key only if it's a real value (not the masked placeholder)
      const key = mcp.apiKey && mcp.apiKey !== '••••••••' ? mcp.apiKey : undefined;
      const result = await api.testMcpServer(mcp.id, key);
      setTestResults(prev => ({ ...prev, [mcp.id]: result }));
    } catch (err) {
      setTestResults(prev => ({ ...prev, [mcp.id]: { success: false, error: err.message } }));
    } finally {
      setTesting(prev => ({ ...prev, [mcp.id]: false }));
    }
  };

  const updateMcp = (index, patch) => {
    const mcps = [...(value.mcps || [])];
    mcps[index] = { ...mcps[index], ...patch };
    // If authMode changed to 'none', clear apiKey
    if (patch.authMode === 'none') {
      mcps[index].apiKey = '';
    }
    update({ mcps });
  };

  const removeMcp = (index) => {
    const mcps = [...(value.mcps || [])];
    mcps.splice(index, 1);
    update({ mcps });
  };

  const addMcp = () => {
    update({ mcps: [...(value.mcps || []), createEmptyMcp()] });
    setExpandedMcps(prev => new Set(prev).add((value.mcps || []).length));
  };

  // ─────────────────────────────────────────────────────────────────
  // ACTIVATION MODE — minimal UI, only auth credentials are editable
  // ─────────────────────────────────────────────────────────────────
  if (isActivate) {
    const mcps = value.mcps || [];
    const authMcps = mcps.filter((m) => {
      const am = m.authMode || (m.hasApiKey || m.apiKey ? 'bearer' : 'none');
      return am === 'bearer';
    });
    const canSubmit = !saving;

    return (
      <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 space-y-4 animate-fadeIn">
        {/* Plugin summary card (read-only) */}
        <div className="flex items-start gap-3 p-3 rounded-lg bg-dark-900/40 border border-dark-700/40">
          <span className="text-2xl flex-shrink-0">{value.icon || '🔧'}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-dark-100">{value.name || 'Plugin sans nom'}</span>
              {value.category && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-700 text-dark-300 border border-dark-600">
                  {value.category}
                </span>
              )}
              {value.shared && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                  <Globe className="w-2.5 h-2.5" /> partagé
                </span>
              )}
            </div>
            {value.description && (
              <p className="text-xs text-dark-400 mt-0.5">{value.description}</p>
            )}
          </div>
        </div>

        {/* Information banner */}
        <div className="flex items-start gap-2 p-2.5 rounded-lg bg-indigo-500/5 border border-indigo-500/20 text-[11px] text-dark-300">
          <Info className="w-3.5 h-3.5 text-indigo-400 flex-shrink-0 mt-0.5" />
          <span>
            Vous activez un plugin créé par quelqu'un d'autre.
            Seuls vos accès (clés d'API, OAuth) peuvent être configurés ici — la configuration du plugin
            elle-même (instructions, URL du MCP, etc.) est gérée par son propriétaire.
          </span>
        </div>

        {/* Credentials per MCP — the ONLY editable thing in activate mode */}
        {authMcps.length === 0 && mcps.length === 0 && (
          <div className="text-center py-6 border border-dashed border-dark-700 rounded-lg text-dark-500 text-xs">
            Ce plugin n'a pas de MCP associé.
          </div>
        )}

        {authMcps.length === 0 && mcps.length > 0 && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-emerald-500/5 border border-emerald-500/20 text-xs text-emerald-300">
            <CheckCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">Aucune authentification requise.</p>
              <p className="text-[11px] text-dark-400 mt-0.5">
                Les {mcps.length} serveur(s) MCP de ce plugin ne nécessitent pas de clé d'API.
                Cliquez sur « Activer » pour l'utiliser.
              </p>
            </div>
          </div>
        )}

        {authMcps.length > 0 && (
          <div>
            <div className="flex items-center gap-2 mb-2">
              <KeyRound className="w-3.5 h-3.5 text-amber-400" />
              <h4 className="text-sm font-medium text-dark-200">Vos accès</h4>
              <span className="text-[11px] text-dark-500">({authMcps.length} requis)</span>
            </div>
            <div className="space-y-2">
              {authMcps.map((mcp) => {
                const index = mcps.indexOf(mcp);
                return (
                  <div key={mcp.id || index} className="rounded-lg border border-dark-700/50 bg-dark-900/30 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{mcp.icon || '🔌'}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-dark-200 font-medium truncate">{mcp.name || 'MCP'}</p>
                        {mcp.description && (
                          <p className="text-[11px] text-dark-500 truncate">{mcp.description}</p>
                        )}
                      </div>
                      <button
                        onClick={() => testMcp(mcp)}
                        disabled={!mcp.id || testing[mcp.id]}
                        className="p-1 text-dark-500 hover:text-amber-400 transition-colors disabled:opacity-30"
                        title="Tester la connexion"
                      >
                        {testing[mcp.id] ? <Loader className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    <div>
                      <label className="block text-[11px] text-dark-400 mb-1">Clé d'API / Bearer token</label>
                      <input
                        type="password"
                        value={mcp.apiKey === '••••••••' ? '' : (mcp.apiKey || '')}
                        onChange={(e) => updateMcp(index, { apiKey: e.target.value, authMode: 'bearer' })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                        placeholder={mcp.hasApiKey ? 'Une clé est déjà configurée — laissez vide pour conserver' : 'Saisir votre clé d\'API'}
                        autoComplete="off"
                      />
                    </div>

                    {testResults[mcp.id] && (
                      <div className={`p-2 rounded text-[11px] border ${
                        testResults[mcp.id].success
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : 'bg-red-500/10 border-red-500/30 text-red-400'
                      }`}>
                        <div className="flex items-center gap-1.5 font-medium">
                          {testResults[mcp.id].success
                            ? <><CheckCircle className="w-3 h-3" /> Connexion réussie</>
                            : <><XCircle className="w-3 h-3" /> Échec — {testResults[mcp.id].error}</>
                          }
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        <div className="flex gap-2 justify-end">
          <button onClick={onCancel} className="px-3 py-2 text-dark-400 hover:text-dark-200 text-sm">Annuler</button>
          <button
            onClick={onSubmit}
            disabled={!canSubmit}
            className="px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40 flex items-center gap-2"
          >
            {saving ? <RotateCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {effectiveSubmitLabel}
          </button>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // CONFIGURE MODE — full plugin authoring UI
  // ─────────────────────────────────────────────────────────────────
  return (
    <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 space-y-4 animate-fadeIn">
      <div className="flex gap-2">
        <input
          type="text"
          value={value.icon}
          onChange={(e) => update({ icon: e.target.value })}
          className="w-12 px-2 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-indigo-500"
          placeholder="🔧"
        />
        <input
          type="text"
          value={value.name}
          onChange={(e) => update({ name: e.target.value })}
          className="flex-1 px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
          placeholder="Plugin name"
        />
        <select
          value={value.category}
          onChange={(e) => update({ category: e.target.value })}
          className="px-2 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500"
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
        value={value.description}
        onChange={(e) => update({ description: e.target.value })}
        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
        placeholder="Short description"
      />

      <div>
        <label className="block text-xs text-dark-400 mb-1.5">Plugin instructions</label>
        <textarea
          value={value.instructions}
          onChange={(e) => update({ instructions: e.target.value })}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
          placeholder="Plugin instructions injected into the agent prompt..."
          rows={5}
        />
      </div>

      {/* Sharing toggle */}
      <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-dark-800/40 border border-dark-700/50">
        <button
          type="button"
          onClick={() => update({ shared: !value.shared })}
          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-md text-xs font-medium border transition-colors ${
            value.shared
              ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
              : 'bg-dark-700/50 text-dark-300 border-dark-600 hover:border-dark-500'
          }`}
          title={value.shared ? 'Partagé avec tous les utilisateurs' : 'Visible uniquement par vous'}
        >
          {value.shared ? <Globe className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
          {value.shared ? 'Partagé' : 'Privé'}
        </button>
        <span className="text-[11px] text-dark-500">
          {value.shared
            ? 'Tous les utilisateurs voient ce plugin et peuvent l’activer sur leurs agents.'
            : 'Visible uniquement par vous. Activez le partage pour le rendre disponible aux autres utilisateurs.'}
        </span>
      </div>

      <div>
        <label className="block text-xs text-dark-400 mb-1.5">User-specific configuration</label>
        <textarea
          value={userConfigText}
          onChange={(e) => {
            setUserConfigText(e.target.value);
            update({ userConfig: parseKeyValueText(e.target.value) });
          }}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
          placeholder={'oauth_client_id=...\noauth_scopes=...\ntenant=...'}
          rows={4}
        />
        <p className="text-[11px] text-dark-500 mt-1">Configuration propre a l'utilisateur, stockee avec le plugin. Format cle=valeur.</p>
      </div>

      <div className="border-t border-dark-700 pt-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="text-sm font-medium text-dark-200">MCP associe</h4>
            <p className="text-[11px] text-dark-500">Configurez le serveur MCP dedie a ce plugin (URL, authentification).</p>
          </div>
          {(value.mcps || []).length === 0 && (
            <button
              onClick={addMcp}
              className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors flex items-center gap-1"
            >
              <Plus className="w-3.5 h-3.5" />
              Ajouter un MCP
            </button>
          )}
        </div>

        <div className="space-y-3">
          {(value.mcps || []).map((mcp, index) => {
            const expanded = expandedMcps.has(index);
            const authMode = mcp.authMode || (mcp.hasApiKey || mcp.apiKey ? 'bearer' : 'none');
            return (
              <div key={mcp.id || index} className="rounded-lg border border-dark-700/50 bg-dark-900/30">
                <div className="flex items-center gap-2 px-3 py-2">
                  <button
                    onClick={() => {
                      const next = new Set(expandedMcps);
                      if (expanded) next.delete(index); else next.add(index);
                      setExpandedMcps(next);
                    }}
                    className="text-dark-400 hover:text-dark-200"
                  >
                    {expanded ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  <span className="text-lg">{mcp.icon || '🔌'}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-dark-200 truncate">{mcp.name || `MCP ${index + 1}`}</span>
                      {authMode === 'bearer' ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30 flex items-center gap-0.5">
                          <Shield className="w-2.5 h-2.5" /> Bearer
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-dark-600/50 text-dark-400 border border-dark-600/30 flex items-center gap-0.5">
                          <ShieldOff className="w-2.5 h-2.5" /> No auth
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-dark-500 truncate font-mono">{mcp.url || 'URL non configuree'}</div>
                  </div>
                  <button
                    onClick={() => testMcp(mcp)}
                    disabled={!mcp.id || testing[mcp.id]}
                    className="p-1 text-dark-500 hover:text-amber-400 transition-colors disabled:opacity-30"
                    title="Tester la connexion MCP"
                  >
                    {testing[mcp.id] ? <Loader className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
                  </button>
                  <button
                    onClick={() => removeMcp(index)}
                    className="p-1 text-dark-500 hover:text-red-400 transition-colors"
                    title="Supprimer ce MCP"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {expanded && (
                  <div className="px-3 pb-3 space-y-3 border-t border-dark-700/50 pt-3">
                    {/* Name & Icon */}
                    <div className="grid grid-cols-[1fr_80px] gap-3">
                      <div>
                        <label className="block text-xs text-dark-400 mb-1.5">Nom</label>
                        <input
                          type="text"
                          value={mcp.name}
                          onChange={(e) => updateMcp(index, { name: e.target.value })}
                          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                          placeholder="Nom du serveur MCP"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-dark-400 mb-1.5">Icone</label>
                        <input
                          type="text"
                          value={mcp.icon}
                          onChange={(e) => updateMcp(index, { icon: e.target.value })}
                          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 text-center focus:outline-none focus:border-indigo-500"
                        />
                      </div>
                    </div>

                    {/* URL */}
                    <div>
                      <label className="block text-xs text-dark-400 mb-1.5">URL du serveur MCP</label>
                      <input
                        type="text"
                        value={mcp.url}
                        onChange={(e) => updateMcp(index, { url: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                        placeholder="https://mcp-server.example.com/sse"
                      />
                    </div>

                    {/* Description */}
                    <div>
                      <label className="block text-xs text-dark-400 mb-1.5">Description</label>
                      <input
                        type="text"
                        value={mcp.description}
                        onChange={(e) => updateMcp(index, { description: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                        placeholder="Description du serveur MCP"
                      />
                    </div>

                    {/* Auth mode */}
                    <div>
                      <label className="block text-xs text-dark-400 mb-1.5">Mode d'authentification</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateMcp(index, { authMode: 'none' })}
                          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm border transition-colors ${
                            authMode === 'none'
                              ? 'bg-dark-700 border-indigo-500 text-dark-100'
                              : 'bg-dark-800 border-dark-600 text-dark-400 hover:border-dark-500'
                          }`}
                        >
                          <ShieldOff className="w-4 h-4" />
                          Pas d'authentification
                        </button>
                        <button
                          onClick={() => updateMcp(index, { authMode: 'bearer' })}
                          className={`flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm border transition-colors ${
                            authMode === 'bearer'
                              ? 'bg-amber-500/10 border-amber-500 text-amber-400'
                              : 'bg-dark-800 border-dark-600 text-dark-400 hover:border-dark-500'
                          }`}
                        >
                          <Shield className="w-4 h-4" />
                          Bearer Token
                        </button>
                      </div>
                      <p className="text-[11px] text-dark-500 mt-1.5">
                        Le mode d'authentification est figé par le propriétaire du plugin.
                        Les utilisateurs qui activent ce plugin saisiront leur propre clé.
                      </p>
                    </div>

                    {/* API Key (optional default — owner can leave empty so users provide their own) */}
                    {authMode === 'bearer' && (
                      <div>
                        <label className="block text-xs text-dark-400 mb-1.5">
                          Clé d'API par défaut <span className="text-dark-500">(optionnel)</span>
                        </label>
                        <input
                          type="password"
                          value={mcp.apiKey === '••••••••' ? '' : (mcp.apiKey || '')}
                          onChange={(e) => updateMcp(index, { apiKey: e.target.value })}
                          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                          placeholder={mcp.hasApiKey ? 'Laisser vide pour conserver, ou saisir une nouvelle cle' : 'Laisser vide — chaque utilisateur saisira la sienne'}
                          autoComplete="off"
                        />
                        <p className="text-[11px] text-dark-500 mt-1">
                          Si une clé est saisie ici, elle sert de valeur par défaut pour les utilisateurs qui activent le plugin.
                          Sinon, chacun saisit sa propre clé au moment de l'activation.
                        </p>
                      </div>
                    )}

                    {/* Enabled toggle */}
                    <div>
                      <label className="flex items-center gap-2 text-sm text-dark-200">
                        <input
                          type="checkbox"
                          checked={mcp.enabled !== false}
                          onChange={(e) => updateMcp(index, { enabled: e.target.checked })}
                          className="w-4 h-4 rounded border-dark-600 bg-dark-700"
                        />
                        MCP active
                      </label>
                    </div>

                    {/* Test result */}
                    {testResults[mcp.id] && (
                      <div className={`p-2.5 rounded-lg border text-xs ${
                        testResults[mcp.id].success
                          ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                          : 'bg-red-500/10 border-red-500/30 text-red-400'
                      }`}>
                        <div className="flex items-center gap-1.5 font-medium">
                          {testResults[mcp.id].success
                            ? <><CheckCircle className="w-3.5 h-3.5" /> Connexion reussie — {testResults[mcp.id].toolCount} tool(s)</>
                            : <><XCircle className="w-3.5 h-3.5" /> Echec de connexion</>
                          }
                        </div>
                        {testResults[mcp.id].success && testResults[mcp.id].tools?.length > 0 && (
                          <div className="mt-1.5 text-[11px] text-dark-400 space-y-0.5">
                            {testResults[mcp.id].tools.map(t => (
                              <div key={t.name} className="flex gap-2">
                                <span className="text-dark-300 font-mono">{t.name}</span>
                                {t.description && <span className="truncate">{t.description}</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {testResults[mcp.id].error && (
                          <p className="mt-1 text-[11px] font-mono break-all">{testResults[mcp.id].error}</p>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {(value.mcps || []).length === 0 && (
            <div className="text-center py-6 border border-dashed border-dark-700 rounded-lg text-dark-500 text-xs">
              Aucun MCP configure pour ce plugin.
            </div>
          )}
        </div>
      </div>

      <div className="flex gap-2 justify-end">
        <button onClick={onCancel} className="px-3 py-2 text-dark-400 hover:text-dark-200 text-sm">Annuler</button>
        <button
          onClick={onSubmit}
          disabled={saving || !value.name.trim() || !value.instructions.trim()}
          className="px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40 flex items-center gap-2"
        >
          {saving ? <RotateCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {effectiveSubmitLabel}
        </button>
      </div>
    </div>
  );
}
