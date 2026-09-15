import { useState, useEffect, useCallback } from 'react';
import {
  X,
  Key,
  Copy,
  RefreshCw,
  Trash2,
  Eye,
  EyeOff,
  Shield,
  AlertTriangle,
  BookOpen,
} from 'lucide-react';
import { api } from '../api';
import type {
  ApiKeyInfo,
  LadderApiKeyScope,
  LegacyApiKey,
  ScopedApiKey,
  ShowToastFn,
} from '../types';
import InsertKeysSection from './apiKeys/InsertKeysSection';
import ApiDocsPanel, { type ApiDocsSection } from './apiKeys/ApiDocsPanel';

interface ApiKeyModalProps {
  onClose: () => void;
  showToast?: ShowToastFn;
}

type Tab = 'keys' | 'docs';

/**
 * The two ladder surfaces a personal key can open, and what each one is for.
 *
 * `admin` is a TOOL SET, not a role: a key with that scope is still bounded by
 * what its owner can already administer, and the genuinely instance-wide tools
 * re-check the owner's role server-side. The ladder is one-way — an admin key
 * also opens the management surface, a management key never opens the admin one.
 *
 * Tool lists are deliberately NOT repeated here: the Documentation tab renders
 * the live catalogue each server publishes, which a hand-kept list never was.
 */
const SCOPES: {
  scope: LadderApiKeyScope;
  label: string;
  path: string;
  blurb: string;
}[] = [
  {
    scope: 'management',
    label: 'Management',
    path: '/api/mcp/management',
    blurb:
      'File, move, delegate, run and close tasks on every board you can reach. No agent, board or project mutation.',
  },
  {
    scope: 'admin',
    label: 'Admin',
    path: '/api/mcp/admin',
    blurb:
      'Shape the instance: agents, boards, projects, workflows and shares. Also opens the management surface.',
  },
];

export default function ApiKeyModal({ onClose, showToast }: ApiKeyModalProps) {
  const [tab, setTab] = useState<Tab>('keys');
  /** Where the Documentation tab should scroll when opened from a shortcut. */
  const [docsFocus, setDocsFocus] = useState<ApiDocsSection | null>(null);

  const [keyInfo, setKeyInfo] = useState<ApiKeyInfo | null>(null);
  /** The clear-text legacy key, shown once right after a generate. */
  const [newKey, setNewKey] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  // ── Scoped, per-user keys ────────────────────────────────────────────────
  const [myKeys, setMyKeys] = useState<ScopedApiKey[]>([]);
  /** Clear text of a just-minted ladder key, keyed by scope. Shown once. */
  const [freshScoped, setFreshScoped] = useState<Partial<Record<LadderApiKeyScope, string>>>({});
  const [minting, setMinting] = useState<LadderApiKeyScope | null>(null);

  // ── Legacy keys still outstanding (admin only) ───────────────────────────
  const [legacyKeys, setLegacyKeys] = useState<LegacyApiKey[]>([]);

  const reloadMyKeys = useCallback(async () => {
    setMyKeys((await api.listMyApiKeys()).keys);
  }, []);

  const loadKeyInfo = useCallback(async () => {
    try {
      setLoading(true);
      const [info, mine] = await Promise.all([api.getApiKeyInfo(), api.listMyApiKeys()]);
      setKeyInfo(info.apiKey);
      setMyKeys(mine.keys);
    } catch {
      showToast?.('Failed to load API key info', 'error');
    } finally {
      setLoading(false);
    }

    // Admin-only, and the modal is open to everyone: a 403 here simply means
    // the viewer is not an admin, which is not an error worth reporting.
    try {
      setLegacyKeys((await api.listLegacyApiKeys()).keys);
    } catch {
      setLegacyKeys([]);
    }
  }, [showToast]);

  useEffect(() => {
    loadKeyInfo();
  }, [loadKeyInfo]);

  const openDocs = (section: ApiDocsSection) => {
    setDocsFocus(section);
    setTab('docs');
  };

  const handleGenerate = async () => {
    try {
      const data = await api.generateApiKey();
      setNewKey(data.key);
      setKeyInfo({ id: data.id, prefix: data.prefix, created_at: new Date().toISOString() });
      setShowKey(true);
      await loadKeyInfo();
      showToast?.('Legacy API key generated', 'success');
    } catch {
      showToast?.('Failed to generate API key', 'error');
    }
  };

  const handleRevoke = async () => {
    try {
      await api.revokeApiKey();
      setKeyInfo(null);
      setNewKey(null);
      setLegacyKeys([]);
      showToast?.('Legacy API key revoked', 'success');
    } catch {
      showToast?.('Failed to revoke API key', 'error');
    }
  };

  const handleRevokeLegacy = async () => {
    try {
      const { revoked } = await api.revokeLegacyApiKeys();
      setLegacyKeys([]);
      setKeyInfo(null);
      setNewKey(null);
      showToast?.(`Retired ${revoked} legacy key(s)`, 'success');
    } catch {
      showToast?.('Failed to retire legacy keys', 'error');
    }
  };

  const handleMint = async (scope: LadderApiKeyScope) => {
    try {
      setMinting(scope);
      const created = await api.createMyApiKey(scope);
      // Minting a scope you already hold ROTATES it — the previous key stops
      // working immediately, which is why this says so out loud below.
      setFreshScoped(prev => ({ ...prev, [scope]: created.key }));
      await reloadMyKeys();
      showToast?.(`${scope} key created`, 'success');
    } catch {
      showToast?.('Failed to create API key', 'error');
    } finally {
      setMinting(null);
    }
  };

  const handleRevokeScoped = async (key: ScopedApiKey) => {
    try {
      await api.revokeMyApiKey(key.id);
      setFreshScoped(prev => ({ ...prev, [key.scope]: undefined }));
      await reloadMyKeys();
      showToast?.(`${key.scope} key revoked`, 'success');
    } catch {
      showToast?.('Failed to revoke API key', 'error');
    }
  };

  const handleCopy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      showToast?.('Failed to copy', 'error');
    }
  };

  const mcpEndpoint = `${window.location.origin}/api/swarm/mcp`;
  const hasLegacy = legacyKeys.length > 0 || !!keyInfo;
  const insertKeys = myKeys.filter(k => k.scope === 'insert');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
      <div className="relative bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl w-full max-w-4xl mx-4 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-3 gap-3">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <div>
              <h2 className="text-lg font-bold text-dark-100">API keys & documentation</h2>
              <p className="text-xs text-dark-400">
                Personal keys for the REST and MCP surfaces, and their reference
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-dark-400 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 px-5 border-b border-dark-700" role="tablist">
          {(
            [
              { id: 'keys', label: 'Keys', icon: Key },
              { id: 'docs', label: 'Documentation', icon: BookOpen },
            ] as const
          ).map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              onClick={() => {
                if (id === 'docs') setDocsFocus(null);
                setTab(id);
              }}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm border-b-2 -mb-px transition-colors ${
                tab === id
                  ? 'border-emerald-500 text-dark-100'
                  : 'border-transparent text-dark-400 hover:text-dark-200'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="overflow-y-auto p-5">
          {tab === 'docs' ? (
            <ApiDocsPanel focus={docsFocus} />
          ) : (
            <div className="space-y-6">
              {/* ── The legacy banner ─────────────────────────────────────── */}
              {hasLegacy && (
                <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-4 space-y-2">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium text-amber-300">
                        A legacy instance-wide key is still active
                      </p>
                      <p className="text-xs text-amber-200/80">
                        It belongs to nobody, so everything it reaches runs with no tenant: whoever
                        holds it sees every board, agent and task on the instance. It still opens{' '}
                        <code className="text-amber-100">/api/swarm/*</code> so existing
                        integrations keep working, and it is <strong>refused</strong> on{' '}
                        <code className="text-amber-100">/api/mcp/*</code> and{' '}
                        <code className="text-amber-100">/api/insert/*</code>. Move your
                        integrations to a personal key below, then retire it.
                      </p>
                    </div>
                  </div>
                  {legacyKeys.length > 0 && (
                    <div className="space-y-1.5 pl-6">
                      {legacyKeys.map(k => (
                        <div
                          key={k.id}
                          className="flex items-center gap-3 text-xs text-amber-200/70"
                        >
                          <code className="font-mono">{k.prefix}</code>
                          <span>created {new Date(k.created_at).toLocaleDateString()}</span>
                          <span>
                            {k.last_used_at
                              ? `last used ${new Date(k.last_used_at).toLocaleDateString()}`
                              : 'never used'}
                          </span>
                        </div>
                      ))}
                      <button
                        onClick={handleRevokeLegacy}
                        className="mt-1 flex items-center gap-2 px-3 py-1.5 bg-red-500/10 hover:bg-red-500/20 text-red-300 rounded-lg text-xs transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Retire every legacy key
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* ── Insert keys ───────────────────────────────────────────── */}
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-dark-300">Task insertion</h3>
                  <p className="text-xs text-dark-500 mt-1">
                    The narrowest key: it can only add tasks to the board it was created for, and
                    stops working as soon as you can no longer edit that board.
                  </p>
                </div>
                {loading ? (
                  <div className="text-center py-4 text-dark-400 text-sm">Loading...</div>
                ) : (
                  <InsertKeysSection
                    keys={insertKeys}
                    onChanged={reloadMyKeys}
                    onOpenDocs={() => openDocs('quickstart')}
                    showToast={showToast}
                  />
                )}
              </div>

              {/* ── Ladder keys ───────────────────────────────────────────── */}
              <div className="space-y-3">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-dark-300">MCP keys</h3>
                    <p className="text-xs text-dark-500 mt-1">
                      One key per scope. It names you, and the tools behind it only ever reach what
                      you can already reach. Your role is read fresh on every request, so a change
                      applies immediately.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openDocs('MCP')}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-dark-300 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    Browse the tools
                  </button>
                </div>

                {loading ? (
                  <div className="text-center py-4 text-dark-400 text-sm">Loading...</div>
                ) : (
                  SCOPES.map(({ scope, label, path, blurb }) => {
                    const existing = myKeys.find(k => k.scope === scope);
                    const fresh = freshScoped[scope];
                    return (
                      <div
                        key={scope}
                        className="bg-dark-800/60 border border-dark-700 rounded-lg p-4 space-y-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium text-dark-200">{label}</span>
                              <code className="text-xs text-indigo-300 font-mono">{path}</code>
                            </div>
                            <p className="text-xs text-dark-400 mt-1">{blurb}</p>
                          </div>
                          <button
                            onClick={() => handleMint(scope)}
                            disabled={minting === scope}
                            className="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-dark-700 hover:bg-dark-600 disabled:opacity-50 text-dark-200 rounded-lg text-xs transition-colors"
                          >
                            {existing ? (
                              <RefreshCw className="w-3.5 h-3.5" />
                            ) : (
                              <Key className="w-3.5 h-3.5" />
                            )}
                            {existing ? 'Rotate' : 'Create'}
                          </button>
                        </div>

                        {fresh ? (
                          <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
                            <p className="text-xs text-emerald-400 mb-2 font-medium">
                              Copy this key now — it won't be shown again.
                            </p>
                            <div className="flex items-center gap-2">
                              <code className="flex-1 bg-dark-800 border border-dark-700 rounded px-2 py-1.5 text-xs font-mono text-dark-200 truncate">
                                {fresh}
                              </code>
                              <button
                                onClick={() => handleCopy(fresh)}
                                className={`p-1.5 rounded transition-colors ${
                                  copied ? 'text-emerald-400' : 'text-dark-400 hover:text-dark-100'
                                }`}
                              >
                                <Copy className="w-4 h-4" />
                              </button>
                            </div>
                          </div>
                        ) : existing ? (
                          <div className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2">
                            <Key className="w-3.5 h-3.5 text-dark-400 shrink-0" />
                            <code className="text-xs font-mono text-dark-300">
                              {existing.prefix}
                            </code>
                            <span className="text-xs text-dark-500">
                              {existing.last_used_at
                                ? `last used ${new Date(existing.last_used_at).toLocaleDateString()}`
                                : 'never used'}
                            </span>
                            <button
                              onClick={() => handleRevokeScoped(existing)}
                              className="ml-auto p-1.5 text-dark-400 hover:text-red-400 rounded transition-colors"
                              title="Revoke this key"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ) : (
                          <p className="text-xs text-dark-500">No key yet for this scope.</p>
                        )}
                      </div>
                    );
                  })
                )}
              </div>

              {/* ── The legacy instance-wide key (admin panel) ────────────── */}
              <div className="border-t border-dark-700 pt-4 space-y-3">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-medium text-dark-300">
                      Legacy instance-wide key (admin)
                    </h3>
                    <p className="text-xs text-dark-500 mt-1">
                      Kept only so integrations built against{' '}
                      <code className="text-dark-400">{mcpEndpoint}</code> and{' '}
                      <code className="text-dark-400">/api/swarm/*</code> keep working. It is
                      refused on every personal-key surface.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => openDocs('Legacy')}
                    className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-dark-300 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    Legacy endpoints
                  </button>
                </div>

                {loading ? null : keyInfo ? (
                  <div className="space-y-2">
                    {newKey ? (
                      <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3">
                        <p className="text-xs text-emerald-400 mb-2 font-medium">
                          Copy this key now — it won't be shown again.
                        </p>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 bg-dark-800 border border-dark-700 rounded px-2 py-1.5 text-sm font-mono text-dark-200 truncate">
                            {showKey ? newKey : '••••••••••••••••••••••••'}
                          </code>
                          <button
                            onClick={() => setShowKey(!showKey)}
                            className="p-1.5 text-dark-400 hover:text-dark-100 rounded transition-colors"
                          >
                            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                          </button>
                          <button
                            onClick={() => handleCopy(newKey)}
                            className={`p-1.5 rounded transition-colors ${
                              copied ? 'text-emerald-400' : 'text-dark-400 hover:text-dark-100'
                            }`}
                          >
                            <Copy className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2.5">
                        <Key className="w-4 h-4 text-dark-400" />
                        <code className="text-sm font-mono text-dark-300">{keyInfo.prefix}</code>
                        <span className="text-xs text-dark-500 ml-auto">
                          {new Date(keyInfo.created_at).toLocaleDateString()}
                        </span>
                      </div>
                    )}

                    <div className="flex gap-2">
                      <button
                        onClick={handleGenerate}
                        className="flex items-center gap-2 px-3 py-2 bg-dark-700 hover:bg-dark-600 text-dark-200 rounded-lg text-sm transition-colors"
                      >
                        <RefreshCw className="w-3.5 h-3.5" />
                        Regenerate
                      </button>
                      <button
                        onClick={handleRevoke}
                        className="flex items-center gap-2 px-3 py-2 bg-red-500/10 hover:bg-red-500/20 text-red-400 rounded-lg text-sm transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                        Revoke
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs text-dark-400">
                      No legacy key configured — which is the right state. Prefer a personal key
                      above.
                    </p>
                    <button
                      onClick={handleGenerate}
                      className="flex items-center gap-2 px-3 py-2 bg-dark-700 hover:bg-dark-600 text-dark-300 rounded-lg text-xs transition-colors"
                    >
                      <Key className="w-3.5 h-3.5" />
                      Generate a legacy key anyway
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
