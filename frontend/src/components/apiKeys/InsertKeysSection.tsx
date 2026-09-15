import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Inbox, Key, Plus, Trash2 } from 'lucide-react';
import { api } from '../../api';
import type { BoardListItem, ScopedApiKey, ScopedApiKeyCreated, ShowToastFn } from '../../types';
import CopyableCode from './CopyableCode';

interface InsertKeysSectionProps {
  /** The caller's insert keys (already filtered by the parent). */
  keys: ScopedApiKey[];
  /** Reload the parent's key list after a mint or a revoke. */
  onChanged: () => Promise<void>;
  /** Jump to the Insert API section of the documentation tab. */
  onOpenDocs: () => void;
  showToast?: ShowToastFn;
}

/**
 * Board-bound insert keys: create tasks on ONE board, nothing else.
 *
 * Unlike the ladder keys above them, a user holds as many as they like — one
 * per integration — and minting never rotates another one. Only boards the
 * user can EDIT are offered, matching the server check at mint time (and on
 * every request the key makes afterwards).
 */
export default function InsertKeysSection({
  keys,
  onChanged,
  onOpenDocs,
  showToast,
}: InsertKeysSectionProps) {
  const [boards, setBoards] = useState<BoardListItem[]>([]);
  const [boardId, setBoardId] = useState('');
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  /** Clear text of the key just minted. Shown once, until the next mint or close. */
  const [fresh, setFresh] = useState<ScopedApiKeyCreated | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getBoards()
      .then(list => {
        if (cancelled) return;
        // share_permission null ⇔ the caller owns the board; a read share cannot insert.
        const editable = list.filter(b => b.share_permission !== 'read');
        setBoards(editable);
        setBoardId(prev => prev || editable[0]?.id || '');
      })
      .catch(() => {
        if (!cancelled) showToast?.('Failed to load boards', 'error');
      });
    return () => {
      cancelled = true;
    };
  }, [showToast]);

  const origin = window.location.origin;

  const freshSnippet = useMemo(() => {
    if (!fresh) return '';
    const body = JSON.stringify({ task: 'Describe the work to do', priority: 'medium' });
    return [
      `curl -X POST '${origin}/api/insert/tasks'`,
      `  -H 'Authorization: Bearer ${fresh.key}'`,
      `  -H 'Content-Type: application/json'`,
      `  -d '${body}'`,
    ].join(' \\\n');
  }, [fresh, origin]);

  const handleCreate = async () => {
    if (!boardId) return;
    try {
      setCreating(true);
      const created = await api.createInsertApiKey(boardId, name.trim() || undefined);
      setFresh(created);
      setName('');
      await onChanged();
      showToast?.('Insert key created', 'success');
    } catch {
      showToast?.('Failed to create insert key', 'error');
    } finally {
      setCreating(false);
    }
  };

  const handleRevoke = async (key: ScopedApiKey) => {
    try {
      await api.revokeMyApiKey(key.id);
      if (fresh?.id === key.id) setFresh(null);
      await onChanged();
      showToast?.('Insert key revoked', 'success');
    } catch {
      showToast?.('Failed to revoke insert key', 'error');
    }
  };

  return (
    <div className="bg-dark-800/60 border border-dark-700 rounded-lg p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Inbox className="w-4 h-4 text-sky-400" />
            <span className="text-sm font-medium text-dark-200">Insert keys</span>
            <code className="text-xs text-indigo-300 font-mono">POST /api/insert/tasks</code>
            <code className="text-xs text-indigo-300 font-mono">/api/mcp/insert</code>
          </div>
          <p className="text-xs text-dark-400 mt-1">
            Create tasks on one board and nothing else — no reading, moving or deleting. Made for
            forms, webhooks, n8n/Zapier and scripts. Create one key per integration so each can be
            revoked on its own.
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

      {/* ── Mint ─────────────────────────────────────────────────────────── */}
      {boards.length === 0 ? (
        <p className="text-xs text-dark-500">
          You need edit access to at least one board to create an insert key.
        </p>
      ) : (
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={200}
            placeholder="Integration name, e.g. Support form"
            className="flex-1 min-w-0 bg-dark-900 border border-dark-700 rounded-lg px-3 py-1.5 text-xs text-dark-200 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
          />
          <select
            value={boardId}
            onChange={e => setBoardId(e.target.value)}
            aria-label="Board"
            className="sm:w-56 bg-dark-900 border border-dark-700 rounded-lg px-2 py-1.5 text-xs text-dark-200 focus:outline-none focus:border-indigo-500"
          >
            {boards.map(b => (
              <option key={b.id} value={b.id}>
                {b.name}
                {b.owner_username ? ` (${b.owner_username})` : ''}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating || !boardId}
            className="flex items-center justify-center gap-1.5 px-3 py-1.5 bg-sky-600 hover:bg-sky-500 disabled:opacity-50 text-white rounded-lg text-xs font-medium transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Create
          </button>
        </div>
      )}

      {fresh && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 space-y-2">
          <p className="text-xs text-emerald-400 font-medium">
            “{fresh.name}” on {fresh.board_name || 'its board'} — copy this key now, it won't be
            shown again.
          </p>
          <CopyableCode code={fresh.key} />
          <CopyableCode label="Try it" code={freshSnippet} />
        </div>
      )}

      {/* ── Existing keys ────────────────────────────────────────────────── */}
      {keys.length > 0 ? (
        <ul className="space-y-1.5">
          {keys.map(k => (
            <li
              key={k.id}
              className="flex items-center gap-3 bg-dark-800 border border-dark-700 rounded-lg px-3 py-2 text-xs"
            >
              <Key className="w-3.5 h-3.5 text-dark-400 shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-dark-200 font-medium truncate">
                    {k.name || 'insert key'}
                  </span>
                  <span className="text-dark-500">→</span>
                  <span className="text-sky-300 truncate">{k.board_name || 'unknown board'}</span>
                </div>
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
        <p className="text-xs text-dark-500">No insert key yet.</p>
      )}
    </div>
  );
}
