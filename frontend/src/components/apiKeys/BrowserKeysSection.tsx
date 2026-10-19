import { useMemo, useState } from 'react';
import { BookOpen, Globe, Key, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import type { ScopedApiKey, ScopedApiKeyCreated, ShowToastFn } from '../../types';
import CopyableCode from './CopyableCode';

interface BrowserKeysSectionProps {
  /** The caller's browser keys (already filtered by the parent). */
  keys: ScopedApiKey[];
  /** Reload the parent's key list after a mint or a revoke. */
  onChanged: () => Promise<void>;
  /** Jump to the MCP section of the documentation tab. */
  onOpenDocs: () => void;
  onCreated?: (key: ScopedApiKeyCreated) => void;
  showToast?: ShowToastFn;
}

/**
 * Browser keys: the web browser MCP (search, crawl, extract, FlareSolverr
 * fallback) for another service to call, and nothing of the tenant.
 *
 * Like insert keys a user holds as many as they like — one per consuming
 * service — and minting never rotates another one.
 */
export default function BrowserKeysSection({
  keys,
  onChanged,
  onOpenDocs,
  onCreated,
  showToast,
}: BrowserKeysSectionProps) {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  /** Clear text of the key just minted. Shown once, until the next mint or close. */
  const [fresh, setFresh] = useState<ScopedApiKeyCreated | null>(null);

  const origin = window.location.origin;

  const freshSnippet = useMemo(() => {
    if (!fresh) return '';
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'search_web', arguments: { query: 'PulsarTeam' } },
    });
    return [
      `curl -X POST '${origin}/api/mcp/browser'`,
      `  -H 'Authorization: Bearer ${fresh.key}'`,
      `  -H 'Content-Type: application/json'`,
      `  -H 'Accept: application/json, text/event-stream'`,
      `  -d '${body}'`,
    ].join(' \\\n');
  }, [fresh, origin]);

  const handleCreate = async () => {
    try {
      setCreating(true);
      const created = await api.createBrowserApiKey(name.trim() || undefined);
      setFresh(created);
      onCreated?.(created);
      setName('');
      await onChanged();
      showToast?.('Browser key created', 'success');
    } catch {
      showToast?.('Failed to create browser key', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ScopedApiKey) => {
    try {
      await api.revokeMyApiKey(key.id);
      if (fresh?.id === key.id) setFresh(null);
      await onChanged();
      showToast?.('Browser key revoked', 'success');
    } catch {
      showToast?.('Failed to revoke browser key', 'error');
    }
  };

  return (
    <div className="bg-dark-800/60 border border-dark-700 rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Globe className="w-4 h-4 text-violet-400" />
            <span className="text-sm font-medium text-dark-200">Browser keys</span>
            <code className="text-xs text-indigo-300 font-mono">/api/mcp/browser</code>
          </div>
          <p className="text-xs text-dark-400 mt-1">
            Web search, page crawling and extraction — the browser tools agents use, with the
            FlareSolverr fallback for pages behind an anti-bot challenge — for another service to
            call. Opens nothing else: no task, board or agent. Create one key per service so each
            can be revoked on its own.
          </p>
        </div>
        <button
          type="button"
          onClick={onOpenDocs}
          className="shrink-0 flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-dark-300 hover:text-dark-100 hover:bg-dark-700 rounded-lg transition-colors"
        >
          <BookOpen className="w-3.5 h-3.5" />
          Docs
        </button>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          maxLength={200}
          placeholder="Service name, e.g. News digest"
          className="flex-1 min-w-0 bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-dark-200 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
        />
        <button
          type="button"
          onClick={handleCreate}
          disabled={creating}
          className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
        >
          <Plus className="w-3.5 h-3.5" />
          Create
        </button>
      </div>

      <p className="text-[11px] text-dark-500">
        Only public URLs are fetched: private, loopback and internal addresses are refused.
      </p>

      {fresh && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
          <p className="text-xs text-emerald-400 font-medium">
            “{fresh.name}” — copy this key now, it won't be shown again.
          </p>
          <CopyableCode code={fresh.key} />
          <CopyableCode
            label="Claude Code"
            code={`claude mcp add --transport http --scope user pulsar-browser '${origin}/api/mcp/browser' --header 'Authorization: Bearer ${fresh.key}'`}
          />
          <CopyableCode label="Try it" code={freshSnippet} />
        </div>
      )}

      {keys.length > 0 ? (
        <ul className="space-y-1.5">
          {keys.map(k => (
            <li
              key={k.id}
              className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs"
            >
              <Key className="w-3.5 h-3.5 text-dark-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <span className="text-dark-200 font-medium truncate">
                  {k.name || 'browser key'}
                </span>
                <div className="flex items-center gap-3 text-dark-500 mt-0.5">
                  <code className="font-mono">{k.prefix}</code>
                  <span>
                    {k.last_used_at
                      ? `last used ${new Date(k.last_used_at).toLocaleDateString()}`
                      : 'never used'}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => handleRevoke(k)}
                className="p-1.5 text-dark-400 hover:text-red-400 rounded transition-colors"
                title="Revoke this key"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-dark-500">No browser key yet.</p>
      )}
    </div>
  );
}
