import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, RotateCw, Save, Shield, ShieldOff, Zap, CheckCircle, XCircle, Loader } from 'lucide-react';
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
  const lines = text.split('\\n');
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
  return Object.entries(obj || {}).map(([k, v]) => `${k}=${v ?? ''}`).join('\\n');
}

export default function PluginEditor({ value, onChange, onSubmit, onCancel, saving, submitLabel = 'Save Plugin', readOnly = false }) {
  const [expandedMcps, setExpandedMcps] = useState(() => new Set((value.mcps || []).map((_, i) => i)));
  const [testResults, setTestResults] = useState({});
  const [testing, setTesting] = useState({});
  const userConfigText = useMemo(() => stringifyKeyValue(value.userConfig || {}), [value.userConfig]);

  const update = (patch) => onChange({ ...value, ...patch });

  const testMcp = async (mcp) => {
    if (!mcp.id) return;
    setTesting(prev => ({ ...prev, [mcp.id]: true }));
    setTestResults(prev => ({ ...prev, [mcp.id]: undefined }));
    try {
      const result = await api.testMcpServer(mcp.id);
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

  return (
    <div className="p-3 bg-dark-800/50 rounded-lg border border-dark-700/50 space-y-4 animate-fadeIn">
      <div className="flex gap-2">
        <input
          type="text"
          value={value.icon}
          onChange={(e) => update({ icon: e.target.value })}
          className="w-12 px-2 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-center focus:outline-none focus:border-indigo-500"
          placeholder="🔧"
          disabled={readOnly}
        />
        <input
          type="text"
          value={value.name}
          onChange={(e) => update({ name: e.target.value })}
          className="flex-1 px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
          placeholder="Plugin name"
          disabled={readOnly}
        />
        <select
          value={value.category}
          onChange={(e) => update({ category: e.target.value })}
          className="px-2 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500"
          disabled={readOnly}
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
        disabled={readOnly}
      />

      <div>
        <label className="block text-xs text-dark-400 mb-1.5">Plugin instructions</label>
        <textarea
          value={value.instructions}
          onChange={(e) => update({ instructions: e.target.value })}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
          placeholder="Plugin instructions injected into the agent prompt..."
          rows={5}
          disabled={readOnly}
        />
      </div>

      <div>
        <label className="block text-xs text-dark-400 mb-1.5">User-specific configuration</label>
        <textarea
          value={userConfigText}
          onChange={(e) => update({ userConfig: parseKeyValueText(e.target.value) })}
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
          {(value.mcps || []).length === 0 && !readOnly && (
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
                    className={`p-1 text-dark-500 hover:text-red-400 transition-colors ${readOnly ? 'hidden' : ''}`}
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
                          disabled={readOnly}
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-dark-400 mb-1.5">Icone</label>
                        <input
                          type="text"
                          value={mcp.icon}
                          onChange={(e) => updateMcp(index, { icon: e.target.value })}
                          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 text-center focus:outline-none focus:border-indigo-500"
                          disabled={readOnly}
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
                        disabled={readOnly}
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
                        disabled={readOnly}
                      />
                    </div>

                    {/* Auth mode */}
                    <div>
                      <label className="block text-xs text-dark-400 mb-1.5">Mode d'authentification</label>
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateMcp(index, { authMode: 'none' })}
                          disabled={readOnly}
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
                          disabled={readOnly}
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
                    </div>

                    {/* API Key (only shown when authMode is bearer) */}
                    {authMode === 'bearer' && (
                      <div>
                        <label className="block text-xs text-dark-400 mb-1.5">Cle d'API / Token</label>
                        <input
                          type="password"
                          value={mcp.apiKey === '••••••••' ? '' : (mcp.apiKey || '')}
                          onChange={(e) => updateMcp(index, { apiKey: e.target.value })}
                          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                          placeholder={mcp.hasApiKey ? 'Laisser vide pour conserver, ou saisir une nouvelle cle' : 'Saisir la cle d\'API ou le bearer token'}
                          autoComplete="off"
                          disabled={readOnly}
                        />
                        <p className="text-[11px] text-dark-500 mt-1">
                          Le token sera envoye dans le header <code className="text-dark-400">Authorization: Bearer &lt;token&gt;</code>
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
                          disabled={readOnly}
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
        <button onClick={onCancel} className="px-3 py-2 text-dark-400 hover:text-dark-200 text-sm">{readOnly ? 'Fermer' : 'Annuler'}</button>
        <button
          onClick={onSubmit}
          disabled={saving || (!readOnly && (!value.name.trim() || !value.instructions.trim()))}
          className="px-3 py-2 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-sm disabled:opacity-40 flex items-center gap-2"
        >
          {saving ? <RotateCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {readOnly ? 'Save config' : submitLabel}
        </button>
      </div>
    </div>
  );
}
