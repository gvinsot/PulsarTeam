import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2, RotateCw, Save } from 'lucide-react';

function createEmptyMcp() {
  return {
    id: undefined,
    name: '',
    url: '',
    description: '',
    icon: '🔌',
    enabled: true,
    apiKey: '',
    userConfig: {},
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

export default function PluginEditor({ value, onChange, onSubmit, onCancel, saving, submitLabel = 'Save Plugin' }) {
  const [expandedMcps, setExpandedMcps] = useState(() => new Set((value.mcps || []).map((_, i) => i)));
  const userConfigText = useMemo(() => stringifyKeyValue(value.userConfig || {}), [value.userConfig]);

  const update = (patch) => onChange({ ...value, ...patch });

  const updateMcp = (index, patch) => {
    const mcps = [...(value.mcps || [])];
    mcps[index] = { ...mcps[index], ...patch };
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

      <div>
        <label className="block text-xs text-dark-400 mb-1.5">User-specific configuration</label>
        <textarea
          value={userConfigText}
          onChange={(e) => update({ userConfig: parseKeyValueText(e.target.value) })}
          className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500 font-mono resize-none"
          placeholder={'oauth_client_id=...\\noauth_scopes=...\\ntenant=...'}
          rows={4}
        />
        <p className="text-[11px] text-dark-500 mt-1">Configuration propre à l’utilisateur, stockée avec le plugin. Format clé=valeur.</p>
      </div>

      <div className="border-t border-dark-700 pt-4">
        <div className="flex items-center justify-between mb-3">
          <div>
            <h4 className="text-sm font-medium text-dark-200">MCP intégrés</h4>
            <p className="text-[11px] text-dark-500">Créez et configurez les MCP directement dans le plugin.</p>
          </div>
          <button
            onClick={addMcp}
            className="px-3 py-1.5 bg-indigo-500 hover:bg-indigo-600 text-white rounded-lg text-xs transition-colors flex items-center gap-1"
          >
            <Plus className="w-3.5 h-3.5" />
            Ajouter un MCP
          </button>
        </div>

        <div className="space-y-3">
          {(value.mcps || []).map((mcp, index) => {
            const expanded = expandedMcps.has(index);
            const userConfigValue = stringifyKeyValue(mcp.userConfig || {});
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
                    <div className="text-sm text-dark-200 truncate">{mcp.name || `MCP ${index + 1}`}</div>
                    <div className="text-[11px] text-dark-500 truncate">{mcp.url || 'URL non configurée'}</div>
                  </div>
                  <button
                    onClick={() => removeMcp(index)}
                    className="p-1 text-dark-500 hover:text-red-400 transition-colors"
                    title="Supprimer ce MCP"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>

                {expanded && (
                  <div className="px-3 pb-3 grid grid-cols-2 gap-3 border-t border-dark-700/50 pt-3">
                    <div>
                      <label className="block text-xs text-dark-400 mb-1.5">Nom</label>
                      <input
                        type="text"
                        value={mcp.name}
                        onChange={(e) => updateMcp(index, { name: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-dark-400 mb-1.5">Icône</label>
                      <input
                        type="text"
                        value={mcp.icon}
                        onChange={(e) => updateMcp(index, { icon: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-dark-400 mb-1.5">URL</label>
                      <input
                        type="text"
                        value={mcp.url}
                        onChange={(e) => updateMcp(index, { url: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                        placeholder="https://..."
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-dark-400 mb-1.5">Description</label>
                      <input
                        type="text"
                        value={mcp.description}
                        onChange={(e) => updateMcp(index, { description: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-dark-400 mb-1.5">API key / OAuth token</label>
                      <input
                        type="password"
                        value={mcp.apiKey === '••••••••' ? '' : (mcp.apiKey || '')}
                        onChange={(e) => updateMcp(index, { apiKey: e.target.value })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono text-xs"
                        placeholder="Bearer token, API key, secret..."
                      />
                      <p className="text-[11px] text-dark-500 mt-1">Pour OAuth/MCP, collez ici le secret ou token utilisateur si nécessaire.</p>
                    </div>
                    <div className="col-span-2">
                      <label className="flex items-center gap-2 text-sm text-dark-200">
                        <input
                          type="checkbox"
                          checked={mcp.enabled !== false}
                          onChange={(e) => updateMcp(index, { enabled: e.target.checked })}
                          className="w-4 h-4 rounded border-dark-600 bg-dark-700"
                        />
                        MCP activé
                      </label>
                    </div>
                    <div className="col-span-2">
                      <label className="block text-xs text-dark-400 mb-1.5">Configuration utilisateur du MCP</label>
                      <textarea
                        value={userConfigValue}
                        onChange={(e) => updateMcp(index, { userConfig: parseKeyValueText(e.target.value) })}
                        className="w-full px-3 py-2 bg-dark-800 border border-dark-600 rounded-lg text-sm text-dark-100 focus:outline-none focus:border-indigo-500 font-mono resize-none"
                        placeholder={'oauth_provider=google\\naccount_email=user@example.com'}
                        rows={4}
                      />
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {(value.mcps || []).length === 0 && (
            <div className="text-center py-6 border border-dashed border-dark-700 rounded-lg text-dark-500 text-xs">
              Aucun MCP configuré pour ce plugin.
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
          {submitLabel}
        </button>
      </div>
    </div>
  );
}