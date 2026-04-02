import { useState, useEffect, useRef } from 'react';
import { updateTask, deleteTask, getCommitDiff, getBoards } from '../api';
import RealtimeTaskModal from './RealtimeTaskModal';
import AllCommitsDiffModal from './AllCommitsDiffModal';

// ── Source icons ─────────────────────────────────────────────────────────────
const SOURCE_ICONS = { github: '🐙', jira: '🔷', manual: '✏️' };

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

// ═════════════════════════════════════════════════════════════════════════════
// Commit Diff Modal
// ═════════════════════════════════════════════════════════════════════════════
function CommitDiffModal({ taskId, commit, onClose }) {
  const [diff, setDiff] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const modalRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    getCommitDiff(taskId, commit.hash)
      .then(data => { if (!cancelled) setDiff(data); })
      .catch(err => { if (!cancelled) setError(err.message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [taskId, commit.hash]);

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

  const renderPatch = (patch) => {
    if (!patch) return <span className="text-gray-500 italic text-xs">No diff available (binary file?)</span>;
    return patch.split('\\n').map((line, i) => {
      let cls = 'text-gray-300';
      let bg = '';
      if (line.startsWith('+') && !line.startsWith('+++')) {
        cls = 'text-green-400';
        bg = 'bg-green-500/10';
      } else if (line.startsWith('-') && !line.startsWith('---')) {
        cls = 'text-red-400';
        bg = 'bg-red-500/10';
      } else if (line.startsWith('@@')) {
        cls = 'text-cyan-400';
        bg = 'bg-cyan-500/5';
      }
      return (
        <div key={i} className={`${cls} ${bg} px-3 whitespace-pre font-mono text-xs leading-5`}>
          {line}
        </div>
      );
    });
  };

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        ref={modalRef}
        className="bg-gray-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-white/10 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <span
              className="font-mono px-2 py-1 rounded text-white text-sm shrink-0"
              style={{ backgroundColor: commitColor(commit.hash) }}
            >
              {commit.hash?.substring(0, 7)}
            </span>
            <span className="text-white font-medium text-sm truncate">{commit.message}</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors shrink-0 ml-3"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-16">
              <div className="animate-spin rounded-full h-8 w-8 border-2 border-indigo-500 border-t-transparent" />
            </div>
          )}

          {error && (
            <div className="p-6 text-center">
              <p className="text-red-400 text-sm">{error}</p>
            </div>
          )}

          {diff && (
            <div>
              {/* Commit meta */}
              <div className="px-5 py-3 border-b border-white/5 flex flex-wrap gap-4 text-xs text-gray-400">
                <span>Author: <strong className="text-gray-200">{diff.author}</strong></span>
                {diff.date && <span>{new Date(diff.date).toLocaleString()}</span>}
                {diff.stats && (
                  <span>
                    <span className="text-green-400">+{diff.stats.additions}</span>
                    {' / '}
                    <span className="text-red-400">-{diff.stats.deletions}</span>
                    {' in '}
                    {diff.files?.length || 0} file{(diff.files?.length || 0) !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {/* Files */}
              {diff.files?.map((file, idx) => {
                const st = FILE_STATUS[file.status] || FILE_STATUS.modified;
                return (
                  <div key={idx} className="border-b border-white/5 last:border-b-0">
                    {/* File header */}
                    <div className="px-5 py-2 bg-gray-800/50 flex items-center gap-2 sticky top-0 z-10">
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
                    {/* Diff */}
                    <div className="overflow-x-auto">
                      {renderPatch(file.patch)}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// Task Modal
// ═════════════════════════════════════════════════════════════════════════════
export default function TaskModal({ task, onClose, columns, agents, onTaskUpdated }) {
  if (!task) return null;

  const [editTitle, setEditTitle]       = useState(task.title);
  const [editDesc, setEditDesc]         = useState(task.description || '');
  const [editColumn, setEditColumn]     = useState(task.column || task.status);
  const [editAssignee, setEditAssignee] = useState(task.agentId || '');
  const [editType, setEditType]         = useState(task.type || task.taskType || 'task');
  const [editBoardId, setEditBoardId]   = useState(task.boardId || null);
  const [boards, setBoards]             = useState([]);
  const [loadingBoards, setLoadingBoards] = useState(true);
  const [saving, setSaving]             = useState(false);
  const [showRealtime, setShowRealtime] = useState(false);
  const [diffCommit, setDiffCommit]     = useState(null);
  const [showAllCommits, setShowAllCommits] = useState(false);
  const modalRef = useRef(null);

  // Load boards on mount
  useEffect(() => {
    let cancelled = false;
    setLoadingBoards(true);
    getBoards()
      .then(data => {
        if (!cancelled) {
          setBoards(data || []);
          // If task has a boardId, ensure it's still valid
          if (task.boardId && !data?.find(b => b.id === task.boardId)) {
            setEditBoardId(null);
          } else if (!editBoardId && data?.length > 0) {
            // Default to first board if none selected
            setEditBoardId(data[0].id);
          }
        }
      })
      .catch(err => {
        console.error('Failed to load boards:', err);
        if (!cancelled) setBoards([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingBoards(false);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setEditTitle(task.title);
    setEditDesc(task.description || '');
    setEditColumn(task.column || task.status);
    setEditAssignee(task.agentId || '');
    setEditType(task.type || task.taskType || 'task');
    setEditBoardId(task.boardId || null);
  }, [task.id, task.title, task.description, task.column, task.status, task.agentId, task.type, task.taskType, task.boardId]);

  // Get columns for the selected board
  const availableColumns = useMemo(() => {
    if (!editBoardId) return columns || [];
    const board = boards.find(b => b.id === editBoardId);
    if (!board?.workflow?.columns) return columns || [];
    return board.workflow.columns.map(col => ({
      id: col.id,
      title: col.label,
    }));
  }, [editBoardId, boards, columns]);

  const isDirty =
    editTitle !== task.title ||
    editDesc !== (task.description || '') ||
    editColumn !== (task.column || task.status) ||
    editAssignee !== (task.agentId || '') ||
    editType !== (task.type || task.taskType || 'task') ||
    editBoardId !== (task.boardId || null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (modalRef.current && !modalRef.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const updated = await updateTask(task.id, {
        title: editTitle,
        description: editDesc,
        column: editColumn,
        status: editColumn, // Also update status for backward compatibility
        agentId: editAssignee || null,
        type: editType,
        boardId: editBoardId || null,
      });
      onTaskUpdated?.(updated);
      onClose();
    } catch (err) {
      console.error('Failed to update task:', err);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Delete this task?')) return;
    try {
      await deleteTask(task.id);
      onTaskUpdated?.({ ...task, _deleted: true });
      onClose();
    } catch (err) {
      console.error('Failed to delete task:', err);
    }
  };

  const assignedAgent = agents?.find(a => a.id === task.agentId);
  const hasCommits = task.commits?.length > 0;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
        <div
          ref={modalRef}
          className="bg-gray-900 border border-white/10 rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-white/10">
            <span className="text-xs text-gray-500 font-mono">{task.id?.substring(0, 8)}</span>
            <div className="flex items-center gap-1">
              {task.agentId && (
                <button
                  onClick={() => setShowRealtime(true)}
                  className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-indigo-400 transition-colors"
                  title="Watch agent work in real-time"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" strokeWidth={2} viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"/>
                  </svg>
                </button>
              )}
              <button
                onClick={onClose}
                className="p-1.5 rounded-lg hover:bg-white/10 text-gray-400 hover:text-white transition-colors"
              >
                ✕
              </button>
            </div>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
            {/* Title */}
            <input
              className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-white text-lg font-semibold focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
            />

            {/* ── Metadata fields ──────────────────────────────── */}
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                {/* Source (read-only) */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Source</label>
                  <div className="px-3 py-1.5 bg-gray-800/60 rounded text-sm text-gray-300 capitalize">
                    {SOURCE_ICONS[task.source] || '📝'} {task.source || 'manual'}
                  </div>
                </div>
                {/* Project (read-only) */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Project</label>
                  <div className="px-3 py-1.5 bg-gray-800/60 rounded text-sm text-gray-300 truncate">
                    {task.project || '—'}
                  </div>
                </div>
                {/* Type */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Type</label>
                  <select
                    className="w-full bg-gray-800 border border-white/10 rounded px-3 py-2.5 text-base sm:px-2 sm:py-1.5 sm:text-sm text-white focus:outline-none"
                    value={editType}
                    onChange={e => setEditType(e.target.value)}
                  >
                    {['task', 'bug', 'feature', 'epic', 'story', 'subtask'].map(t => (
                      <option key={t} value={t}>{t}</option>
                    ))}
                  </select>
                </div>
                {/* Assignee */}
                <div>
                  <label className="block text-xs text-gray-500 mb-1">Assignee</label>
                  <select
                    className="w-full bg-gray-800 border border-white/10 rounded px-3 py-2.5 text-base sm:px-2 sm:py-1.5 sm:text-sm text-white focus:outline-none"
                    value={editAssignee}
                    onChange={e => setEditAssignee(e.target.value)}
                  >
                    <option value="">Unassigned</option>
                    {agents?.map(a => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Board Selection */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Board</label>
                {loadingBoards ? (
                  <div className="px-3 py-2.5 bg-gray-800/60 rounded text-sm text-gray-400 flex items-center gap-2">
                    <div className="animate-spin rounded-full h-4 w-4 border-2 border-gray-500 border-t-transparent" />
                    Loading...
                  </div>
                ) : (
                  <select
                    className="w-full bg-gray-800 border border-white/10 rounded px-3 py-2.5 text-base sm:px-2 sm:py-1.5 sm:text-sm text-white focus:outline-none"
                    value={editBoardId || ''}
                    onChange={e => setEditBoardId(e.target.value || null)}
                  >
                    {boards.map(b => (
                      <option key={b.id} value={b.id}>{b.name}</option>
                    ))}
                  </select>
                )}
              </div>

              {/* Status / Column */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">Status (Column)</label>
                <select
                  className="w-full bg-gray-800 border border-white/10 rounded px-3 py-2.5 text-base sm:px-2 sm:py-1.5 sm:text-sm text-white focus:outline-none"
                  value={editColumn}
                  onChange={e => setEditColumn(e.target.value)}
                >
                  {availableColumns.map(col => (
                    <option key={col.id} value={col.id}>{col.title}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs text-gray-500 mb-1">Description</label>
              <textarea
                className="w-full bg-gray-800 border border-white/10 rounded-lg px-3 py-2 text-sm text-gray-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 min-h-[120px] resize-y"
                value={editDesc}
                onChange={e => setEditDesc(e.target.value)}
                rows={6}
              />
            </div>

            {/* ── Commits (full-width, below description) ────────── */}
            {hasCommits && (
              <div className="p-3 bg-gray-800/40 rounded-lg border border-white/5">
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-xs font-semibold text-gray-400 uppercase tracking-wider">
                    Commits ({task.commits.length})
                  </h4>
                  <button
                    onClick={() => setShowAllCommits(true)}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
                  >
                    View all diffs
                  </button>
                </div>
                <div className="space-y-1.5 max-h-60 overflow-y-auto pr-1">
                  {task.commits.map((c, i) => (
                    <button
                      key={i}
                      onClick={() => setDiffCommit(c)}
                      className="w-full flex items-start gap-2 text-xs group text-left rounded-md px-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer"
                    >
                      <span
                        className="font-mono px-1.5 py-0.5 rounded text-white shrink-0 group-hover:ring-2 ring-white/30 transition-all"
                        style={{ backgroundColor: commitColor(c.hash) }}
                      >
                        {c.hash?.substring(0, 7)}
                      </span>
                      <span className="text-gray-300 leading-snug break-all group-hover:text-white transition-colors">
                        {c.message}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-3 border-t border-white/10">
            <button
              onClick={handleDelete}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              Delete
            </button>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 rounded-lg text-sm text-gray-400 hover:bg-white/10 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!isDirty || saving}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Commit diff overlay (single) */}
      {diffCommit && (
        <CommitDiffModal taskId={task.id} commit={diffCommit} onClose={() => setDiffCommit(null)} />
      )}

      {/* All commits diff overlay */}
      {showAllCommits && hasCommits && (
        <AllCommitsDiffModal
          taskId={task.id}
          commits={task.commits}
          onClose={() => setShowAllCommits(false)}
        />
      )}

      {/* Realtime overlay */}
      {showRealtime && (
        <RealtimeTaskModal task={task} onClose={() => setShowRealtime(false)} />
      )}
    </>
  );
}