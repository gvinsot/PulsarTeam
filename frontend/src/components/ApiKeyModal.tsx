import { useState, useEffect, useCallback } from 'react';
import { X, Key, Copy, RefreshCw, Trash2, Shield, BookOpen } from 'lucide-react';
import { api } from '../api';
import type { LadderApiKeyScope, ScopedApiKey, ScopedApiKeyCreated, ShowToastFn } from '../types';
import InsertKeysSection from './apiKeys/InsertKeysSection';
import BrowserKeysSection from './apiKeys/BrowserKeysSection';
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

  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  // ── Scoped, per-user keys ────────────────────────────────────────────────
  const [myKeys, setMyKeys] = useState<ScopedApiKey[]>([]);
  /** Clear text of a just-minted ladder key, keyed by scope. Shown once. */
  const [freshScoped, setFreshScoped] = useState<Partial<Record<LadderApiKeyScope, string>>>({});
  const [freshInsert, setFreshInsert] = useState<ScopedApiKeyCreated | null>(null);
  const [freshBrowser, setFreshBrowser] = useState<ScopedApiKeyCreated | null>(null);
  const [minting, setMinting] = useState<LadderApiKeyScope | null>(null);

  const reloadMyKeys = useCallback(async () => {
    setMyKeys((await api.listMyApiKeys()).keys);
  }, []);

  const loadKeyInfo = useCallback(async () => {
    try {
      setLoading(true);
      setMyKeys((await api.listMyApiKeys()).keys);
    } catch {
      showToast?.('Failed to load API key info', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    loadKeyInfo();
  }, [loadKeyInfo]);

  const openDocs = (section: ApiDocsSection) => {
    setDocsFocus(section);
    setTab('docs');
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

  const insertKeys = myKeys.filter(k => k.scope === 'insert');
  const browserKeys = myKeys.filter(k => k.scope === 'browser');

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
            <ApiDocsPanel
              focus={docsFocus}
              freshKeys={{
                ...freshScoped,
                insert: myKeys.some(k => k.id === freshInsert?.id) ? freshInsert?.key : undefined,
                browser: myKeys.some(k => k.id === freshBrowser?.id)
                  ? freshBrowser?.key
                  : undefined,
              }}
            />
          ) : (
            <div className="space-y-6">
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
                    onCreated={setFreshInsert}
                    keys={insertKeys}
                    onChanged={reloadMyKeys}
                    onOpenDocs={() => openDocs('quickstart')}
                    showToast={showToast}
                  />
                )}
              </div>

              {/* ── Browser keys ──────────────────────────────────────────── */}
              <div className="space-y-3">
                <div>
                  <h3 className="text-sm font-medium text-dark-300">Web browser</h3>
                  <p className="text-xs text-dark-500 mt-1">
                    Let another service search and read the web through this instance. The key
                    reaches no task, board or agent of yours.
                  </p>
                </div>
                {loading ? (
                  <div className="text-center py-4 text-dark-400 text-sm">Loading...</div>
                ) : (
                  <BrowserKeysSection
                    onCreated={setFreshBrowser}
                    keys={browserKeys}
                    onChanged={reloadMyKeys}
                    onOpenDocs={() => openDocs('MCP')}
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
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
