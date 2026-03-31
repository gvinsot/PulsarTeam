import { useState, useEffect, useRef } from 'react';
import { getCommitDiff } from '../api';

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
function CommitSection({ commit, diff, loading, error }) {
  const [expanded, setExpanded] = useState(true);

  return (
    <div className="border border-white/10 rounded-xl overflow-hidden">
      {/* Commit header */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 bg-gray-800/60 hover:bg-gray-800 transition-colors text-left"
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
// All Commits Diff Modal
// ═════════════════════════════════════════════════════════════════════════════
export default function AllCommitsDiffModal({ taskId, commits, onClose, initialHash }) {
  const [diffs, setDiffs] = useState({});      // hash -> diff data
  const [loading, setLoading] = useState({});   // hash -> boolean
  const [errors, setErrors] = useState({});     // hash -> error string
  const modalRef = useRef(null);
  const scrollRef = useRef(null);

  // Fetch all commit diffs on mount
  useEffect(() => {
    if (!commits?.length) return;

    const initLoading = {};
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
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Totals
  const allLoaded = Object.values(loading).every(v => !v);
  const totalAdditions = Object.values(diffs).reduce((s, d) => s + (d?.stats?.additions || 0), 0);
  const totalDeletions = Object.values(diffs).reduce((s, d) => s + (d?.stats?.deletions || 0), 0);
  const totalFiles = Object.values(diffs).reduce((s, d) => s + (d?.files?.length || 0), 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
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
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body — scrollable list of all commits */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3">
          {commits.map((c) => (
            <div key={c.hash} data-hash={c.hash}>
              <CommitSection
                commit={c}
                diff={diffs[c.hash] || null}
                loading={loading[c.hash] || false}
                error={errors[c.hash] || null}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
