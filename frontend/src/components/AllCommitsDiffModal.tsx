import { useState, useEffect, useRef } from 'react';
import { getCommitDiff, api } from '../api';

// ── Commit colours (deterministic per hash prefix) ───────────────────────────
const COMMIT_COLORS = [
  '#6366f1', '#8b5cf6', '#a855f7', '#d946ef',
  '#ec4899', '#f43f5e', '#ef4444', '#f97316',
  '#eab308', '#22c55e', '#14b8a6', '#06b6d4',
  '#3b82f6', '#2563eb',
];
function commitColor(hash) {
  const idx = parseInt((hash || '').substring(0, 6), 16) || 0;
  return COMMIT_COLORS[idx % COMMIT_COLORS.length];
}

// ── Status badge for file changes ────────────────────────────────────────────
const FILE_STATUS = {
  added:    { label: 'A', bg: 'bg-green-500/20', text: 'text-green-400' },
  removed:  { label: 'D', bg: 'bg-red-500/20',   text: 'text-red-400' },
  modified: { label: 'M', bg: 'bg-yellow-500/20', text: 'text-yellow-400' },
  renamed:  { label: 'R', bg: 'bg-blue-500/20',   text: 'text-blue-400' },
  copied:   { label: 'C', bg: 'bg-purple-500/20', text: 'text-purple-400' },
};

function renderPatch(patch) {
  if (!patch) return <span className="text-gray-500 italic text-xs">No diff available (binary file?)</span>;
  return patch.split('\n').map((line, i) => {
    let cls = 'text-gray-300';
    let bg = '';
    if (line.startsWith('+') && !line.startsWith('+++')) {
      cls = 'text-green-400'; bg = 'bg-green-500/10';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      cls = 'text-red-400'; bg = 'bg-red-500/10';
    } else if (line.startsWith('@@')) {
      cls = 'text-cyan-400'; bg = 'bg-cyan-500/5';
    }
    return (
      <div key={i} className={`${cls} ${bg} px-3 whitespace-pre font-mono text-xs leading-5`}>
        {line}
      </div>
    );
  });
}

// ═════════════════════════════════════════════════════════════════════════════
// Single commit section (collapsible)
// ═════════════════════════════════════════════════════════════════════════════
function CommitSection({ commit, diff, loading, error, selected, onToggleSelect, showSelect }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className={`border rounded-xl overflow-hidden transition-colors ${selected ? 'border-red-500/50 ring-1 ring-red-500/20' : 'border-white/10'}`}>
      {/* Commit header */}
      <div className="flex items-center bg-gray-800/60">
        {showSelect && (
          <button
            onClick={() => onToggleSelect(commit.hash)}
            className="pl-3 pr-1 py-3 flex items-center"
            title={selected ? 'Deselect commit' : 'Select commit for revert'}
          >
            <div className={`w-4 h-4 rounded border-2 flex items-center justify-center transition-colors ${
              selected
                ? 'bg-red-500 border-red-500'
                : 'border-gray-500 hover:border-red-400'
            }`}>
              {selected && (
                <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" strokeWidth={3} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              )}
            </div>
          </button>
        )}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex-1 flex items-center gap-3 px-4 py-3 hover:bg-gray-800 transition-colors text-left"
        >
          <svg
            className={`w-4 h-4 text-gray-400 shrink-0 transition-transform ${expanded ? 'rotate-90' : ''}`}
            fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          <span
            className="font-mono px-2 py-0.5 rounded text-white text-xs shrink-0"
            style={{ backgroundColor: commitColor(commit.hash) }}
          >
            {commit.hash?.substring(0, 7)}
          </span>
          <span className="text-white font-medium text-sm truncate flex-1">{commit.message}</span>
          {diff?.stats && (
            <span className="text-xs text-gray-400 shrink-0">
              <span className="text-green-400">+{diff.stats.additions}</span>
              {' / '}
              <span className="text-red-400">-{diff.stats.deletions}</span>
              {' in '}
              {diff.files?.length || 0} file{(diff.files?.length || 0) !== 1 ? 's' : ''}
            </span>
          )}
        </button>
      </div>

      {/* Expanded content */}
      {expanded && (
        <div>
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-6 w-6 border-2 border-indigo-500 border-t-transparent" />
            </div>
          )}

          {error && (
            <div className="px-4 py-3 text-red-400 text-sm">{error}</div>
          )}

          {diff && (
            <>
              {/* Commit meta */}
              <div className="px-4 py-2 border-b border-white/5 flex flex-wrap gap-4 text-xs text-gray-400">
                <span>Author: <strong className="text-gray-200">{diff.author}</strong></span>
                {diff.date && <span>{new Date(diff.date).toLocaleString()}</span>}
              </div>

              {/* Files */}
              {diff.files?.map((file, idx) => {
                const st = FILE_STATUS[file.status] || FILE_STATUS.modified;
                return (
                  <div key={idx} className="border-b border-white/5 last:border-b-0">
                    <div className="px-4 py-2 bg-gray-800/30 flex items-center gap-2 sticky top-0 z-10">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${st.bg} ${st.text}`}>
                        {st.label}
                      </span>
                      <span className="text-sm text-gray-200 font-mono truncate">{file.filename}</span>
                      <span className="ml-auto text-xs text-gray-500 shrink-0">
                        <span className="text-green-400">+{file.additions}</span>
                        {' '}
                        <span className="text-red-400">-{file.deletions}</span>
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      {renderPatch(file.patch)}
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Revert Confirmation Modal
// ═════════════════════════════════════════════════════════════════════════════
function RevertConfirmModal({ selectedCommits, commits, onConfirm, onCancel, reverting }) {
  const selected = commits.filter(c => selectedCommits.has(c.hash));
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-gray-900 border border-red-500/30 rounded-2xl shadow-2xl w-full max-w-md p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-full bg-red-500/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-red-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 010 10H3m0-10l4-4m-4 4l4 4" />
            </svg>
          </div>
          <div>
            <h3 className="text-white font-semibold">Revert {selected.length} commit{selected.length > 1 ? 's' : ''}?</h3>
            <p className="text-gray-400 text-xs mt-0.5">An agent will be asked to revert the selected commits using <code className="text-gray-300">git revert</code>.</p>
          </div>
        </div>

        <div className="space-y-1.5 mb-5 max-h-40 overflow-y-auto">
          {selected.map(c => (
            <div key={c.hash} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-gray-800/60 border border-white/5">
              <code className="text-xs text-amber-300 font-mono shrink-0">{c.hash?.slice(0, 7)}</code>
              <span className="text-xs text-gray-300 truncate">{c.message}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            disabled={reverting}
            className="px-4 py-2 text-sm text-gray-300 hover:text-white bg-gray-800 border border-white/10 hover:border-white/20 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={reverting}
            className="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors flex items-center gap-2 disabled:opacity-50"
          >
            {reverting ? (
              <>
                <div className="animate-spin rounded-full h-3.5 w-3.5 border-2 border-white/30 border-t-white" />
                Creating task...
              </>
            ) : (
              <>
                <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 010 10H3m0-10l4-4m-4 4l4 4" />
                </svg>
                Revert commits
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// All Commits Diff Modal
// ═════════════════════════════════════════════════════════════════════════════

// Shape of GET /api/tasks/:id/commits/:hash/diff (see api/src/routes/tasks.ts)
interface CommitDiffFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes?: number;
  patch?: string;
}
interface CommitDiff {
  sha?: string;
  message?: string;
  author?: string;
  date?: string;
  stats?: { additions: number; deletions: number; total?: number };
  files?: CommitDiffFile[];
}

export default function AllCommitsDiffModal({ taskId, commits, onClose, initialHash, agentId, project }) {
  const [diffs, setDiffs] = useState<Record<string, CommitDiff>>({});      // hash -> diff data
  const [loading, setLoading] = useState<Record<string, boolean>>({});   // hash -> boolean
  const [errors, setErrors] = useState<Record<string, string>>({});     // hash -> error string
  const [revertMode, setRevertMode] = useState(false);
  const [selectedCommits, setSelectedCommits] = useState(new Set());
  const [showConfirm, setShowConfirm] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [revertSuccess, setRevertSuccess] = useState(null); // null | { taskId }
  const modalRef = useRef(null);
  const scrollRef = useRef(null);

  // Fetch all commit diffs on mount
  useEffect(() => {
    if (!commits?.length) return;

    const initLoading: Record<string, boolean> = {};
    commits.forEach(c => { initLoading[c.hash] = true; });
    setLoading(initLoading);

    commits.forEach(c => {
      getCommitDiff(taskId, c.hash)
        .then(data => {
          setDiffs(prev => ({ ...prev, [c.hash]: data }));
        })
        .catch(err => {
          setErrors(prev => ({ ...prev, [c.hash]: err.message }));
        })
        .finally(() => {
          setLoading(prev => ({ ...prev, [c.hash]: false }));
        });
    });
  }, [taskId, commits]);

  // Scroll to initial commit if specified
  useEffect(() => {
    if (initialHash && scrollRef.current) {
      const el = scrollRef.current.querySelector(`[data-hash="${initialHash}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [initialHash, diffs]);

  // Close on outside click / Escape
  useEffect(() => {
    function handleClick(e) {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    }
    function handleKey(e) {
      if (e.key === 'Escape') {
        if (showConfirm) { setShowConfirm(false); return; }
        if (revertMode) { setRevertMode(false); setSelectedCommits(new Set()); return; }
        onClose();
      }
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, revertMode, showConfirm]);

  function toggleSelect(hash) {
    setSelectedCommits(prev => {
      const next = new Set(prev);
      if (next.has(hash)) next.delete(hash);
      else next.add(hash);
      return next;
    });
  }

  function selectAll() {
    if (selectedCommits.size === commits.length) {
      setSelectedCommits(new Set());
    } else {
      setSelectedCommits(new Set(commits.map(c => c.hash)));
    }
  }

  async function handleRevert() {
    if (!agentId || selectedCommits.size === 0) return;
    setReverting(true);
    try {
      const selected = commits.filter(c => selectedCommits.has(c.hash));
      const hashList = selected.map(c => `${c.hash.slice(0, 7)} (${c.message || 'no message'})`).join('\n- ');
      const taskText = `[REVERT] Revert the following commit${selected.length > 1 ? 's' : ''} using \`git revert --no-edit\`:\n- ${hashList}\n\nFull commit hashes: ${selected.map(c => c.hash).join(', ')}\n\nAfter reverting, push the changes to the remote repository.`;
      const result = await api.addTask(agentId, taskText);
      setRevertSuccess({ taskId: result.id || result.taskId });
      setShowConfirm(false);
    } catch (err) {
      alert('Failed to create revert task: ' + err.message);
    } finally {
      setReverting(false);
    }
  }

  // Totals
  const allLoaded = Object.values(loading).every(v => !v);
  const totalAdditions = Object.values(diffs).reduce((s, d) => s + (d?.stats?.additions || 0), 0);
  const totalDeletions = Object.values(diffs).reduce((s, d) => s + (d?.stats?.deletions || 0), 0);
  const totalFiles = Object.values(diffs).reduce((s, d) => s + (d?.files?.length || 0), 0);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        ref={modalRef}
        className="bg-gray-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-5xl max-h-[92vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-amber-400" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="4" />
              <path strokeLinecap="round" d="M12 2v6m0 8v6" />
            </svg>
            <h3 className="text-white font-semibold text-base">
              All Commits ({commits.length})
            </h3>
            {allLoaded && (
              <span className="text-xs text-gray-400 ml-2">
                <span className="text-green-400">+{totalAdditions}</span>
                {' / '}
                <span className="text-red-400">-{totalDeletions}</span>
                {' across '}
                {totalFiles} file{totalFiles !== 1 ? 's' : ''}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* Revert button */}
            {agentId && !revertSuccess && (
              revertMode ? (
                <div className="flex items-center gap-2">
                  <button
                    onClick={selectAll}
                    className="text-xs text-gray-400 hover:text-white transition-colors px-2 py-1"
                  >
                    {selectedCommits.size === commits.length ? 'Deselect all' : 'Select all'}
                  </button>
                  <button
                    onClick={() => { setRevertMode(false); setSelectedCommits(new Set()); }}
                    className="px-3 py-1.5 text-xs text-gray-300 hover:text-white bg-gray-800 border border-white/10 hover:border-white/20 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={() => setShowConfirm(true)}
                    disabled={selectedCommits.size === 0}
                    className="px-3 py-1.5 text-xs text-white bg-red-600 hover:bg-red-500 rounded-lg transition-colors flex items-center gap-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 010 10H3m0-10l4-4m-4 4l4 4" />
                    </svg>
                    Revert ({selectedCommits.size})
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setRevertMode(true)}
                  className="px-3 py-1.5 text-xs text-red-400 hover:text-red-300 bg-red-500/10 hover:bg-red-500/20 border border-red-500/20 hover:border-red-500/40 rounded-lg transition-colors flex items-center gap-1.5"
                  title="Select commits to revert"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M3 10h10a5 5 0 010 10H3m0-10l4-4m-4 4l4 4" />
                  </svg>
                  Revert
                </button>
              )
            )}
            {/* Close button */}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Success banner */}
        {revertSuccess && (
          <div className="mx-5 mt-3 px-4 py-3 rounded-xl bg-green-500/10 border border-green-500/30 flex items-center gap-3">
            <svg className="w-5 h-5 text-green-400 shrink-0" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm text-green-300">
              Revert task created successfully. The agent will process it shortly.
            </span>
          </div>
        )}

        {/* Body — scrollable list of all commits */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {commits.map((c) => (
            <div key={c.hash} data-hash={c.hash}>
              <CommitSection
                commit={c}
                diff={diffs[c.hash] || null}
                loading={loading[c.hash] || false}
                error={errors[c.hash] || null}
                selected={selectedCommits.has(c.hash)}
                onToggleSelect={toggleSelect}
                showSelect={revertMode}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Revert confirmation overlay */}
      {showConfirm && (
        <RevertConfirmModal
          selectedCommits={selectedCommits}
          commits={commits}
          onConfirm={handleRevert}
          onCancel={() => setShowConfirm(false)}
          reverting={reverting}
        />
      )}
    </div>
  );
}
