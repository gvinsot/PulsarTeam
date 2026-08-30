import {
  Calendar,
  GitCommit,
  X,
  MessageSquare,
  Edit3,
  User,
  XCircle,
  Pause,
  ArrowRight,
} from 'lucide-react';
import { MODE_LABELS, timeAgo, formatDate } from './taskConstants';
import type { TaskCommit, TaskHistoryEntry } from '../../types';

interface TaskTimelineProps {
  /** `Task.history` — always an array on a GET /tasks row, but the caller reads
   *  it off a `task:updated` frame, where the key can be missing or null. */
  history?: TaskHistoryEntry[] | null;
  /** `Task.commits`, with the same frame caveat as `history`. */
  commits?: TaskCommit[] | null;
  createdAt?: string | null;
  onOpenEntry: (entry: TaskHistoryEntry) => void;
  /** A commit hash, or null for the "View all diffs" button. */
  onOpenCommit: (hash: string | null) => void;
  onRemoveCommit: (hash: string) => void | Promise<void>;
}

// Merged history + commit timeline extracted from TaskDetailModal.
// `onOpenCommit` receives a commit hash, or null for the "View all diffs"
// button; `onRemoveCommit` wraps the unlink API call + refresh; `onOpenEntry`
// opens the HistoryDetailModal for a history entry.
export default function TaskTimeline({
  history,
  commits,
  createdAt,
  onOpenEntry,
  onOpenCommit,
  onRemoveCommit,
}: TaskTimelineProps) {
  // `as const` on the two discriminants: without it both widen to `string` and
  // the `item.kind === 'commit'` test below stops narrowing the merged array.
  const historyItems = (history || []).map((h, i) => ({
    kind: 'history' as const,
    at: h.at,
    h,
    key: `h-${i}`,
  }));
  const commitItems = (commits || []).map((c, i) => ({
    kind: 'commit' as const,
    at: c.date,
    c,
    key: `c-${c.hash || i}`,
  }));
  const timeline = [...historyItems, ...commitItems].sort((a, b) => {
    const ta = a.at ? new Date(a.at).getTime() : 0;
    const tb = b.at ? new Date(b.at).getTime() : 0;
    return ta - tb;
  });
  if (timeline.length === 0) {
    return createdAt ? (
      <div className="flex items-center justify-between py-1">
        <div className="flex items-center gap-2 text-xs text-dark-400">
          <Calendar className="w-3.5 h-3.5" />
          Created
        </div>
        <span className="text-xs text-dark-300" title={formatDate(createdAt) ?? undefined}>
          {timeAgo(createdAt)}
        </span>
      </div>
    ) : null;
  }
  return (
    <div className="space-y-0">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-wider text-dark-500 font-semibold">
          History
        </div>
        {commits && commits.length > 0 && (
          <button
            onClick={() => onOpenCommit(null)}
            className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
          >
            View all diffs ({commits.length})
          </button>
        )}
      </div>
      <div className="relative pl-4 border-l border-dark-700 space-y-1.5">
        {timeline.map(item =>
          item.kind === 'commit' ? (
            <div key={item.key} className="relative group">
              <div className="w-full flex items-start gap-2 rounded-md px-1 py-0.5 -ml-1 hover:bg-dark-800/60 transition-colors">
                <div className="absolute -left-[17px] top-1.5 w-2 h-2 rounded-full bg-amber-500 ring-2 ring-dark-900 group-hover:ring-amber-500/30 transition-colors" />
                <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
                  <button
                    onClick={() => onOpenCommit(item.c.hash)}
                    className="flex items-center gap-1.5 text-xs min-w-0 text-left cursor-pointer"
                    title="View commit diff"
                  >
                    <GitCommit className="w-2.5 h-2.5 text-amber-400 flex-shrink-0" />
                    <code className="text-amber-300 font-mono hover:text-amber-200 transition-colors flex-shrink-0">
                      {item.c.hash?.slice(0, 7)}
                    </code>
                    {item.c.pushed === false && (
                      <span
                        className="px-1 py-px rounded text-[9px] font-medium bg-orange-500/15 text-orange-400 border border-orange-500/30 flex-shrink-0"
                        title="This commit exists only in the agent's local clone — it has not been pushed to any remote yet"
                      >
                        not pushed
                      </span>
                    )}
                    {item.c.message && (
                      <span className="text-dark-300 truncate">{item.c.message}</span>
                    )}
                  </button>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    <button
                      onClick={() => onRemoveCommit(item.c.hash)}
                      className="p-0.5 rounded text-dark-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                      title="Remove commit link"
                    >
                      <X className="w-3 h-3" />
                    </button>
                    {item.c.date && (
                      <span
                        className="text-[10px] text-dark-500"
                        title={formatDate(item.c.date) ?? undefined}
                      >
                        {timeAgo(item.c.date)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div key={item.key} className="relative">
              <button
                className="w-full flex items-start gap-2 text-left rounded-md px-1 py-0.5 -ml-1 hover:bg-dark-800/60 transition-colors cursor-pointer group"
                onClick={() => onOpenEntry(item.h)}
              >
                <div className="absolute -left-[17px] top-1.5 w-2 h-2 rounded-full bg-dark-600 ring-2 ring-dark-900 group-hover:bg-indigo-500 group-hover:ring-indigo-500/30 transition-colors" />
                <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
                  <div className="flex items-center gap-1.5 text-xs min-w-0">
                    {item.h.type === 'execution' ? (
                      <>
                        <MessageSquare className="w-2.5 h-2.5 text-blue-400 flex-shrink-0" />
                        <span
                          className={`font-medium ${item.h.success ? 'text-blue-300' : 'text-red-300'}`}
                        >
                          {MODE_LABELS[item.h.mode || 'execute'] || 'Execution'}{' '}
                          {item.h.success ? '✓' : '✗'}
                        </span>
                        <span className="text-dark-500 truncate">by {item.h.by}</span>
                        {item.h.messages && item.h.messages.length > 0 && (
                          <span className="text-[10px] text-dark-500">
                            — {item.h.messages.length} msg{item.h.messages.length > 1 ? 's' : ''}
                          </span>
                        )}
                      </>
                    ) : item.h.type === 'edit' ? (
                      <>
                        <Edit3 className="w-2.5 h-2.5 text-amber-400 flex-shrink-0" />
                        <span className="text-dark-200 font-medium">
                          edited{' '}
                          {item.h.field ||
                            // `fields` is a string[] of field NAMES (a copy of the
                            // producer's `editedFields`, see TaskHistoryEntry.fields),
                            // so the names themselves are all there is to show.
                            (item.h.fields?.length ? item.h.fields.join(', ') : 'task')}
                        </span>
                        {item.h.by && (
                          <span className="text-dark-500 truncate">by {item.h.by}</span>
                        )}
                      </>
                    ) : item.h.type === 'reassign' ? (
                      <>
                        <User className="w-2.5 h-2.5 text-indigo-400 flex-shrink-0" />
                        <span className="text-dark-200 font-medium">reassigned</span>
                        {item.h.by && (
                          <span className="text-dark-500 truncate">by {item.h.by}</span>
                        )}
                      </>
                    ) : item.h.type === 'error' ? (
                      <>
                        <XCircle className="w-2.5 h-2.5 text-red-400 flex-shrink-0" />
                        <span className="text-red-300 font-medium">error</span>
                        {item.h.from && (
                          <span className="text-dark-500 truncate">in {item.h.from}</span>
                        )}
                        {item.h.by && (
                          <span className="text-dark-500 truncate">by {item.h.by}</span>
                        )}
                        {item.h.error && (
                          <span className="text-red-400/70 truncate" title={item.h.error}>
                            {item.h.error.slice(0, 80)}
                          </span>
                        )}
                      </>
                    ) : item.h.type === 'stopped' ? (
                      <>
                        <Pause className="w-2.5 h-2.5 text-yellow-400 flex-shrink-0" />
                        <span className="text-yellow-300 font-medium">stopped</span>
                        {item.h.by && (
                          <span className="text-dark-500 truncate">by {item.h.by}</span>
                        )}
                      </>
                    ) : (
                      <>
                        {item.h.from && (
                          <>
                            <span className="text-dark-500">{item.h.from}</span>
                            <ArrowRight className="w-2.5 h-2.5 text-dark-600 flex-shrink-0" />
                          </>
                        )}
                        <span className="text-dark-200 font-medium">{item.h.status}</span>
                        {item.h.by && (
                          <span className="text-dark-500 truncate">by {item.h.by}</span>
                        )}
                      </>
                    )}
                  </div>
                  <span
                    className="text-[10px] text-dark-500 flex-shrink-0"
                    title={formatDate(item.h.at) ?? undefined}
                  >
                    {timeAgo(item.h.at)}
                  </span>
                </div>
              </button>
            </div>
          )
        )}
      </div>
    </div>
  );
}
