import { useState, useRef, useEffect, type ReactNode } from 'react';
import {
  Trash2, X, AlertTriangle, Edit3, Save, Check, Tag,
  ChevronDown, Zap, User, GitBranch, Cloud, Repeat, FolderKanban, Loader2, Layers,
  ArrowRight, Hand, Square, Play,
} from 'lucide-react';
import { api, updateTask as updateTaskById } from '../../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AllCommitsDiffModal from '../AllCommitsDiffModal';
import HistoryDetailModal from './HistoryDetailModal';
import { SOURCE_META, TASK_TYPES, TASK_TYPE_MAP, buildRecurrence, recurrenceLabel, timeAgo, formatDate } from './taskConstants';
import RecurrenceFields from './RecurrenceFields';
import EditableSelectRow from './EditableSelectRow';
import TaskTimeline from './TaskTimeline';
import { useBoardRepos, useBoardStorages } from '../../hooks/useBoardResources';

export default function TaskDetailModal({ task, agents, onClose, onRefresh, onDelete, onStop, onResume, onClearStopped, statusOptions, onNavigateToAgent, boards, activeBoardId }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const [editTitle, setEditTitle] = useState(task.title || '');
  const [saving, setSaving] = useState(false);
  const [mutationError, setMutationError] = useState(null);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editingRecurrence, setEditingRecurrence] = useState(false);
  const [savingRecurrence, setSavingRecurrence] = useState(false);
  const [recEnabled, setRecEnabled] = useState(!!task.recurrence?.enabled);
  const [recPeriod, setRecPeriod] = useState(task.recurrence?.period || 'daily');
  const [recCustomInterval, setRecCustomInterval] = useState(task.recurrence?.intervalMinutes || 60);
  const [recRetentionDays, setRecRetentionDays] = useState(task.recurrence?.historyRetentionDays || 0);
  const [editingBoard, setEditingBoard] = useState(false);
  const [boardMoveTarget, setBoardMoveTarget] = useState(null);
  const [movingBoard, setMovingBoard] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refining, setRefining] = useState(false);
  const [showAllCommits, setShowAllCommits] = useState(false);
  const [clickedCommitHash, setClickedCommitHash] = useState(null);
  const [historyDetail, setHistoryDetail] = useState(null);
  const statusRef = useRef(null);
  const textareaRef = useRef(null);
  const refineRef = useRef(null);

  // Repos via the board's GitHub plugin so the user can re-target the task,
  // storage roots via the board's OneDrive plugin
  const { repos: availableRepos, error: repoLoadError } = useBoardRepos(task.boardId);
  const { storages: availableStorages, error: storageLoadError, loading: storageLoading } = useBoardStorages(task.boardId);

  // Focus textarea when entering edit mode
  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(editText.length, editText.length);
    }
  }, [editing]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e) => {
      if (statusRef.current && !statusRef.current.contains(e.target)) setStatusOpen(false);
      if (refineRef.current && !refineRef.current.contains(e.target)) setRefineOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (editing) { setEditing(false); setEditText(task.text); setEditTitle(task.title || ''); }
        else onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editing, task.text, onClose]);

  const handleSave = async () => {
    const trimmedText = editText.trim();
    const trimmedTitle = editTitle.trim();
    const textChanged = trimmedText && trimmedText !== task.text;
    const titleChanged = trimmedTitle !== (task.title || '');
    if (!textChanged && !titleChanged) { setEditing(false); return; }
    setSaving(true);
    setMutationError(null);
    try {
      // Use the board-level PUT /tasks/:id route (description→text, title) rather
      // than the agent-scoped PATCH, which 404s with "Agent not found" whenever
      // task.agentId doesn't map to a live agent (board-only/unassigned tasks, or
      // a disabled/deleted agent). The board route gates on boardId instead.
      const body: { description?: string; title?: string } = {};
      if (textChanged) body.description = trimmedText;
      if (titleChanged) body.title = trimmedTitle;
      await updateTaskById(task.id, body);
      await onRefresh();
      setEditing(false);
    } catch (err) {
      setMutationError(err?.message || 'Failed to save task');
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (newStatus) => {
    setStatusOpen(false);
    if (newStatus === task.status) return;
    try {
      await updateTaskById(task.id, { column: newStatus });
      onRefresh();
    } catch (err) {
      console.error('[TasksBoard] Status change failed:', err.message);
    }
  };

  // onSave wrappers for the EditableSelectRow rows. Each owns its no-op
  // guard and refresh semantics (repo/storage await the refresh, type and
  // assignee fire it un-awaited — preserved deliberately). Errors are
  // surfaced via mutationError and rethrown so the row stays in edit mode.
  const saveRepo = async (newFullName) => {
    if ((newFullName || null) === (task.repoFullName || null)) return;
    setMutationError(null);
    try {
      const provider = newFullName
        ? (availableRepos.find(r => r.fullName === newFullName)?.provider || 'github')
        : 'github';
      await updateTaskById(task.id, { repoFullName: newFullName || null, repoProvider: provider });
      await onRefresh();
    } catch (err) {
      setMutationError(err?.message || 'Failed to change repo');
      throw err;
    }
  };

  const saveSecondaryRepos = async (next: Array<{ provider?: string; fullName: string }>) => {
    setMutationError(null);
    try {
      await updateTaskById(task.id, { secondaryRepos: next });
      await onRefresh();
    } catch (err) {
      setMutationError(err?.message || 'Failed to change secondary repos');
      throw err;
    }
  };

  const saveStorage = async (newPath) => {
    if ((newPath || null) === (task.storagePath || null)) return;
    setMutationError(null);
    try {
      const provider = newPath
        ? (availableStorages.find(s => s.path === newPath)?.provider || 'onedrive')
        : 'onedrive';
      await updateTaskById(task.id, { storagePath: newPath || null, storageProvider: provider });
      await onRefresh();
    } catch (err) {
      setMutationError(err?.message || 'Failed to change storage');
      throw err;
    }
  };

  const saveType = async (newType) => {
    // Note: selecting None while the type is already empty still hits the
    // API (null !== '') — existing behavior, kept as-is.
    if (newType === (task.taskType || '')) return;
    setMutationError(null);
    try {
      await updateTaskById(task.id, { taskType: newType || '' });
      onRefresh?.();
    } catch (err) {
      setMutationError(err?.message || 'Failed to change type');
      throw err;
    }
  };

  const saveAssignee = async (targetId) => {
    if (targetId === (task.assignee || '')) return;
    setMutationError(null);
    try {
      await updateTaskById(task.id, { agentId: targetId || null });
      onRefresh?.();
    } catch (err) {
      setMutationError(err?.message || 'Failed to reassign task');
      throw err;
    }
  };

  const handleRecurrenceSave = async () => {
    setSavingRecurrence(true);
    setMutationError(null);
    try {
      const recurrence = recEnabled
        ? buildRecurrence(recPeriod, recCustomInterval, recRetentionDays)
        : { enabled: false };
      await updateTaskById(task.id, { recurrence });
      await onRefresh();
      setEditingRecurrence(false);
    } catch (err) {
      setMutationError(err?.message || 'Failed to update recurrence');
    } finally {
      setSavingRecurrence(false);
    }
  };

  const handleRecurrenceCancel = () => {
    setRecEnabled(!!task.recurrence?.enabled);
    setRecPeriod(task.recurrence?.period || 'daily');
    setRecCustomInterval(task.recurrence?.intervalMinutes || 60);
    setRecRetentionDays(task.recurrence?.historyRetentionDays || 0);
    setEditingRecurrence(false);
  };

  const handleDelete = async () => {
    await onDelete(task);
    onClose();
  };

  const handleBoardMoveConfirm = async () => {
    if (!boardMoveTarget) return;
    setMovingBoard(true);
    try {
      const destBoard = (boards || []).find(b => b.id === boardMoveTarget);
      const firstCol = destBoard?.workflow?.columns?.[0]?.id || 'todo';
      await updateTaskById(task.id, { boardId: boardMoveTarget, column: firstCol });
      setBoardMoveTarget(null);
      setEditingBoard(false);
      onRefresh?.();
      onClose();
    } catch (err) {
      console.error('Board move failed:', err);
    } finally {
      setMovingBoard(false);
    }
  };

  const currentBoard = boards?.find(b => b.id === (task.boardId || activeBoardId));

  const isError = task.status === 'error';
  const isStopped = task.executionStatus === 'stopped';
  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;

  const handleStop = async () => {
    if (!onStop) return;
    await onStop(task);
  };

  const handleResume = () => {
    if (!onResume) return;
    onResume(task);
  };

  const handleClearStopped = async () => {
    if (!onClearStopped) return;
    await onClearStopped(task);
    onRefresh?.();
  };
  const currentStatus = (statusOptions || []).find(s => s.value === task.status) || (statusOptions || [])[0] || { value: task.status, label: task.status, dot: 'bg-dark-500', text: 'text-dark-300' };
  const lastStatusId = (statusOptions || [])[(statusOptions || []).length - 1]?.value;

  return (
    <>
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
    >
      <div className="w-[80vw] max-w-5xl h-[80vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            {/* Status badge / selector */}
            <div className="relative" ref={statusRef}>
              <button
                onClick={() => !task.actionRunning && setStatusOpen(o => !o)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                  border transition-colors hover:opacity-80
                  ${task.actionRunning ? 'opacity-50 cursor-not-allowed' : ''}
                  ${isError
                    ? 'bg-red-500/15 text-red-300 border-red-500/30'
                    : task.status === lastStatusId
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : 'bg-dark-700 text-dark-300 border-dark-600'
                  }`}
                title={task.actionRunning ? 'Stop the agent first to change status' : undefined}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${currentStatus.dot}`} />
                {currentStatus.label}
                {task.actionRunning
                  ? <Loader2 className="w-3 h-3 animate-spin text-cyan-400" />
                  : <ChevronDown className="w-3 h-3 opacity-60" />}
              </button>
              {statusOpen && (
                <div className="absolute left-0 top-8 z-50 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1 min-w-[140px]">
                  {(statusOptions || []).map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => handleStatusChange(opt.value)}
                      className={`w-full text-left px-3 py-1.5 text-xs hover:bg-dark-700 transition-colors
                        flex items-center gap-2 ${opt.text}
                        ${opt.value === task.status ? 'bg-dark-700/50' : ''}`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${opt.dot}`} />
                      {opt.label}
                      {opt.value === task.status && <Check className="w-3 h-3 ml-auto opacity-60" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <span className="text-xs text-dark-500 font-mono">{task.id?.slice(0, 8)}</span>
          </div>
          <div className="flex items-center gap-2">
            {task.actionRunning && onStop && (
              <button
                onClick={handleStop}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                  text-red-300 bg-red-500/15 hover:bg-red-500/25 border border-red-500/40
                  hover:border-red-500/60 transition-colors"
                title="Stop the agent working on this task"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
                Stop
              </button>
            )}
            {!task.actionRunning && task.assignee && onResume && (
              <button
                onClick={handleResume}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                  text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40
                  hover:border-emerald-500/60 transition-colors"
                title={isStopped ? 'Resume this stopped task' : isError ? 'Re-run this task' : 'Start this task now'}
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                {isStopped ? 'Resume' : isError ? 'Retry' : 'Start'}
              </button>
            )}
            {!task.actionRunning && !task.assignee && isStopped && onClearStopped && (
              <button
                onClick={handleClearStopped}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                  text-yellow-300 bg-yellow-500/15 hover:bg-yellow-500/25 border border-yellow-500/40
                  hover:border-yellow-500/60 transition-colors"
                title="Clear the stopped state so this task can be picked up again"
              >
                <Play className="w-3.5 h-3.5" />
                Clear stopped
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">

          {/* Task text — editable */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-semibold text-dark-400 uppercase tracking-wide">Task</span>
              {!editing && (
                <div className="flex items-center gap-2">
                  <div className="relative" ref={refineRef}>
                    <button
                      onClick={() => setRefineOpen(o => !o)}
                      disabled={refining}
                      className={`flex items-center gap-1 text-xs transition-colors
                        ${refining
                          ? 'text-amber-300'
                          : 'text-dark-500 hover:text-amber-400'
                        }`}
                    >
                      {refining
                        ? <><svg className="w-3 h-3 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
                          </svg>Improving…</>
                        : <><Zap className="w-3 h-3" />Improve description with AI</>
                      }
                    </button>
                    {refineOpen && !refining && (
                      <div className="absolute right-0 top-6 z-50 bg-dark-800 border border-dark-600
                        rounded-xl shadow-2xl shadow-black/40 py-1 min-w-[180px]">
                        <div className="px-3 py-1.5 text-xs text-dark-400 font-semibold border-b border-dark-700 mb-1">
                          Choose idle agent
                        </div>
                        {(agents || []).filter(a => a.enabled !== false && a.status === 'idle').length === 0 && (
                          <div className="px-3 py-2 text-xs text-dark-500 italic">No idle agents available</div>
                        )}
                        {(agents || []).filter(a => a.enabled !== false && a.status === 'idle').map(a => (
                          <button
                            key={a.id}
                            onClick={async () => {
                              setRefineOpen(false);
                              setRefining(true);
                              try {
                                const result = await api.refineTask(task.agentId, task.id, a.id);
                                if (result?.text) onRefresh?.();
                              } catch (err) {
                                console.error('Refine failed:', err);
                              } finally {
                                setRefining(false);
                              }
                            }}
                            className="w-full text-left px-3 py-1.5 text-xs text-dark-200
                              hover:bg-dark-700 hover:text-dark-100 transition-colors flex items-center gap-2"
                          >
                            {a.icon} {a.name}
                            <span className="text-dark-500 ml-auto text-[10px]">{a.role}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => { setEditText(task.text); setEditTitle(task.title || ''); setEditing(true); }}
                    className="flex items-center gap-1 text-xs text-dark-500 hover:text-indigo-400 transition-colors"
                  >
                    <Edit3 className="w-3 h-3" />
                    Edit
                  </button>
                </div>
              )}
            </div>
            {editing ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={editTitle}
                  onChange={e => setEditTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-dark-800 border border-indigo-500/50 rounded-lg text-sm
                    text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500"
                  placeholder="Title (optional — displayed on card instead of description)"
                />
                <textarea
                  ref={textareaRef}
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  rows={15}
                  className="w-full h-full min-h-[300px] px-3 py-2.5 bg-dark-800 border border-indigo-500/50 rounded-lg text-sm
                    text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500
                    resize-y leading-relaxed font-mono"
                  placeholder="Task description (supports Markdown)..."
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setEditing(false); setEditText(task.text); setEditTitle(task.title || ''); }}
                    className="px-3 py-1.5 text-xs text-dark-400 hover:text-dark-200 bg-dark-800
                      border border-dark-600 rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleSave}
                    disabled={saving || !editText.trim()}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white
                      bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 rounded-lg transition-colors"
                  >
                    <Save className="w-3 h-3" />
                    {saving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={`text-sm leading-relaxed cursor-text
                  ${isError ? 'text-red-300' : 'text-dark-200'}`}
                onClick={() => { setEditText(task.text); setEditTitle(task.title || ''); setEditing(true); }}
                title="Click to edit"
              >
                {task.title && (
                  <p className="text-base font-semibold text-dark-100 mb-2">{task.title}</p>
                )}
                <ReactMarkdown
                  remarkPlugins={[remarkGfm]}
                  className="prose prose-invert prose-sm max-w-none break-words"
                  components={{
                    pre: ({ children }) => <pre className="bg-dark-900 rounded-lg p-3 overflow-x-auto my-2 border border-dark-600">{children}</pre>,
                    code: ({ children }: { children?: ReactNode }) => !String(children).includes('\n')
                      ? <code className="bg-dark-700 px-1.5 py-0.5 rounded text-purple-300 text-xs">{children}</code>
                      : <code className="text-green-300 text-xs">{children}</code>,
                    a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:text-blue-300 underline">{children}</a>,
                    table: ({ children }) => <table className="border-collapse border border-dark-600 my-2 w-full text-xs">{children}</table>,
                    th: ({ children }) => <th className="border border-dark-600 px-2 py-1 bg-dark-700 text-left">{children}</th>,
                    td: ({ children }) => <td className="border border-dark-600 px-2 py-1">{children}</td>,
                    ul: ({ children }) => <ul className="list-disc list-inside space-y-1">{children}</ul>,
                    ol: ({ children }) => <ol className="list-decimal list-inside space-y-1">{children}</ol>,
                    h1: ({ children }) => <h1 className="text-lg font-bold text-dark-100 mt-3 mb-1">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-base font-bold text-dark-100 mt-3 mb-1">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-sm font-bold text-dark-100 mt-2 mb-1">{children}</h3>,
                    blockquote: ({ children }) => <blockquote className="border-l-2 border-purple-500 pl-3 my-2 text-dark-400 italic">{children}</blockquote>,
                    p: ({ children }) => <p className="my-1">{children}</p>,
                    hr: () => <hr className="border-dark-600 my-3" />,
                    li: ({ children }) => <li className="text-dark-200">{children}</li>,
                  }}
                >
                  {task.text}
                </ReactMarkdown>
              </div>
            )}
          </div>

          {/* Error message */}
          {isError && task.error && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-red-500/10 border border-red-500/20">
              <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-semibold text-red-400 mb-0.5">Error</p>
                <p className="text-xs text-red-300/80 leading-relaxed">{task.error}</p>
              </div>
            </div>
          )}

          {/* Metadata */}
          <div className="space-y-2.5">
            <span className="text-xs font-semibold text-dark-400 uppercase tracking-wide">Details</span>

            {mutationError && (
              <p className="flex items-center gap-2 text-xs text-red-400 px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg">
                <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
                {mutationError}
              </p>
            )}

            {/* Source */}
            {sourceMeta && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Tag className="w-3.5 h-3.5" />
                  Source
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ring-1 ${sourceMeta.cls}`}>
                  {sourceMeta.label(task.source)}
                </span>
              </div>
            )}

            {/* Recurrence */}
            <div className="py-2 border-b border-dark-800">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Repeat className="w-3.5 h-3.5" />
                  Recurring
                </div>
                {editingRecurrence ? (
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={handleRecurrenceSave}
                      disabled={savingRecurrence}
                      className="px-2 py-0.5 text-[11px] font-medium text-white bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 rounded transition-colors flex items-center gap-1"
                      title="Save recurrence"
                    >
                      <Save className="w-3 h-3" />
                      {savingRecurrence ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      onClick={handleRecurrenceCancel}
                      disabled={savingRecurrence}
                      className="p-0.5 rounded text-dark-500 hover:text-dark-300 hover:bg-dark-700 transition-colors"
                      title="Cancel"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    {task.recurrence?.enabled ? (
                      <>
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium ring-1 bg-teal-500/10 text-teal-400 ring-teal-500/20">
                          {recurrenceLabel(task.recurrence)}
                        </span>
                        {task.recurrence.historyRetentionDays > 0 && (
                          <span
                            className="text-[10px] px-2 py-0.5 rounded-full font-medium ring-1 bg-dark-700/40 text-dark-300 ring-dark-600"
                            title="History/commits older than this are dropped at each reset"
                          >
                            Purge {task.recurrence.historyRetentionDays}d
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="text-xs text-dark-500 italic">None</span>
                    )}
                    <button
                      onClick={() => {
                        setRecEnabled(!!task.recurrence?.enabled);
                        setRecPeriod(task.recurrence?.period || 'daily');
                        setRecCustomInterval(task.recurrence?.intervalMinutes || 60);
                        setRecRetentionDays(task.recurrence?.historyRetentionDays || 0);
                        setEditingRecurrence(true);
                      }}
                      className="p-0.5 rounded text-dark-500 hover:text-teal-400 hover:bg-dark-700 transition-colors"
                      title="Edit recurrence"
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
              {editingRecurrence && (
                <div className="mt-3 p-3 border border-dark-700 rounded-lg space-y-3 bg-dark-800/40">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={recEnabled}
                      onChange={e => setRecEnabled(e.target.checked)}
                      className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-800 text-teal-500 focus:ring-teal-500 focus:ring-offset-0"
                    />
                    <span className="text-xs font-semibold text-dark-300 uppercase tracking-wide">Enable recurrence</span>
                  </label>
                  {recEnabled && (
                    <RecurrenceFields
                      period={recPeriod}
                      onPeriodChange={setRecPeriod}
                      customInterval={recCustomInterval}
                      onCustomIntervalChange={setRecCustomInterval}
                      retentionDays={recRetentionDays}
                      onRetentionDaysChange={setRecRetentionDays}
                      focusClass="focus:border-teal-500"
                    />
                  )}
                </div>
              )}
            </div>

            {/* Manual toggle */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <Hand className="w-3.5 h-3.5" />
                Manual
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-[10px] text-dark-500">{task.isManual ? 'Not processed by agents' : 'Processed by agents'}</span>
                <button
                  onClick={async () => {
                    const newVal = !task.isManual;
                    try {
                      await updateTaskById(task.id, { isManual: newVal });
                      onRefresh?.();
                    } catch (err) {
                      console.error('Failed to toggle manual:', err);
                    }
                  }}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors
                    ${task.isManual ? 'bg-orange-500' : 'bg-dark-600'}`}
                >
                  <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform
                    ${task.isManual ? 'translate-x-4' : 'translate-x-1'}`} />
                </button>
              </label>
            </div>

            {/* Project (read-only — derived from the board) */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <Tag className="w-3.5 h-3.5" />
                Project
              </div>
              {task.project ? (
                <span className="text-xs px-2 py-0.5 rounded-full font-medium
                  bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
                  {task.project}
                </span>
              ) : (
                <span className="text-xs text-dark-500 italic">None</span>
              )}
            </div>

            {/* Repo (editable, scoped to the board's repos) */}
            <EditableSelectRow
              icon={GitBranch}
              label="Repo"
              value={task.repoFullName || ''}
              options={availableRepos.map(r => ({ value: r.fullName, label: `[${r.provider}] ${r.fullName}` }))}
              onSave={saveRepo}
              disableWhenEmpty
              selectClassName="px-2 py-0.5 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              editTitle="Change repo"
              pencilReplacement={repoLoadError ? (
                <span className="text-[10px] text-amber-400 italic" title={repoLoadError}>github plugin off</span>
              ) : null}
              view={task.repoFullName ? (
                <span className="text-xs px-2 py-0.5 rounded-full font-medium
                  bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
                  {task.repoFullName}
                </span>
              ) : (
                <span className="text-xs text-dark-500 italic">None</span>
              )}
            />

            {/* Secondary repos (editable) — cloned alongside the primary at run time */}
            {task.repoFullName && (
              <div className="flex items-start gap-2">
                <GitBranch className="w-3.5 h-3.5 text-dark-500 mt-1 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-semibold text-dark-500 uppercase tracking-wide mb-1">Secondary repos</div>
                  {(() => {
                    const current = Array.isArray(task.secondaryRepos) ? task.secondaryRepos : [];
                    const currentNames = current.map(r => r.fullName);
                    const addable = availableRepos.filter(r => r.fullName !== task.repoFullName && !currentNames.includes(r.fullName));
                    return (
                      <div className="flex flex-wrap items-center gap-1.5">
                        {current.map(r => (
                          <span key={r.fullName} className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-500/20">
                            {r.fullName}
                            <button type="button" title="Remove" onClick={() => saveSecondaryRepos(current.filter(x => x.fullName !== r.fullName))} className="hover:text-emerald-200">
                              <X className="w-3 h-3" />
                            </button>
                          </span>
                        ))}
                        {current.length === 0 && <span className="text-xs text-dark-500 italic">None</span>}
                        {addable.length > 0 && (
                          <select
                            value=""
                            onChange={e => { const v = e.target.value; if (v) saveSecondaryRepos([...current, { provider: availableRepos.find(r => r.fullName === v)?.provider || 'github', fullName: v }]); }}
                            className="px-2 py-0.5 bg-dark-800 border border-emerald-500/40 rounded text-xs text-dark-200 focus:outline-none focus:border-emerald-500 transition-colors"
                            title="Add a secondary repo"
                          >
                            <option value="">+ Add…</option>
                            {addable.map(r => (
                              <option key={r.fullName} value={r.fullName}>[{r.provider}] {r.fullName}</option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })()}
                </div>
              </div>
            )}

            {/* Storage (editable, scoped to the board's OneDrive plugin) */}
            <EditableSelectRow
              icon={Cloud}
              label="Storage"
              value={task.storagePath || ''}
              options={availableStorages.map(s => ({ key: `${s.provider}:${s.path}`, value: s.path, label: `[${s.provider}] ${s.displayName || s.path}` }))}
              onSave={saveStorage}
              disableWhenEmpty
              selectClassName="px-2 py-0.5 bg-dark-800 border border-amber-500/50 rounded text-xs text-dark-200 focus:outline-none focus:border-amber-500 transition-colors"
              editTitle="Change storage"
              pencilHoverClass="hover:text-amber-400"
              pencilReplacement={!storageLoading && (storageLoadError || availableStorages.length === 0) ? (
                <span className="text-[10px] text-dark-500 italic">No drive connected</span>
              ) : null}
              view={task.storagePath ? (
                <span className="text-xs px-2 py-0.5 rounded-full font-medium
                  bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20">
                  {task.storagePath}
                </span>
              ) : (
                <span className="text-xs text-dark-500 italic">None</span>
              )}
            />

            {/* Task Type */}
            <EditableSelectRow
              icon={Layers}
              label="Type"
              value={task.taskType || ''}
              options={TASK_TYPES.map(t => ({ value: t.value, label: t.label }))}
              onSave={saveType}
              selectClassName="px-2 py-0.5 w-36 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              editTitle="Change type"
              view={task.taskType && TASK_TYPE_MAP[task.taskType] ? (() => {
                const tt = TASK_TYPE_MAP[task.taskType];
                const Icon = tt.icon;
                return (
                  <span className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full font-medium ring-1 ${tt.cls}`}>
                    <Icon className="w-2.5 h-2.5" />
                    {tt.label}
                  </span>
                );
              })() : (
                <span className="text-xs text-dark-500 italic">None</span>
              )}
            />

            {/* Assignee */}
            <EditableSelectRow
              icon={User}
              label="Assignee"
              value={task.assignee || ''}
              options={(agents || []).map(a => ({ value: a.id, label: `${a.icon} ${a.name}` }))}
              emptyOptionLabel="Unassigned"
              onSave={saveAssignee}
              selectClassName="px-2 py-0.5 w-36 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              editTitle="Reassign to another agent"
              view={(() => {
                const assignee = task.assignee ? (agents || []).find(a => a.id === task.assignee) : null;
                if (assignee) {
                  return (
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-medium bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20${onNavigateToAgent ? ' cursor-pointer hover:bg-blue-500/20 transition-colors' : ''}`}
                      onClick={onNavigateToAgent ? () => { onNavigateToAgent(assignee.id); onClose(); } : undefined}
                      title={onNavigateToAgent ? `Open ${assignee.name}'s chat` : undefined}
                    >
                      {assignee.icon} {assignee.name}
                    </span>
                  );
                }
                return <span className="text-xs text-dark-500 italic">Unassigned</span>;
              })()}
            />

            {/* Board */}
            {boards && boards.length > 1 && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <FolderKanban className="w-3.5 h-3.5" />
                  Board
                </div>
                {editingBoard ? (
                  <div className="flex items-center gap-1.5">
                    <select
                      autoFocus
                      defaultValue={task.boardId || activeBoardId || ''}
                      onChange={e => {
                        const targetId = e.target.value;
                        if (targetId === (task.boardId || activeBoardId)) { setEditingBoard(false); return; }
                        setBoardMoveTarget(targetId);
                      }}
                      disabled={task.actionRunning}
                      className="px-2 py-0.5 w-40 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200
                        focus:outline-none focus:border-indigo-500 transition-colors"
                    >
                      {(boards || []).map(b => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => { setEditingBoard(false); setBoardMoveTarget(null); }}
                      className="p-0.5 rounded text-dark-500 hover:text-dark-300 hover:bg-dark-700 transition-colors"
                      title="Cancel"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium
                      bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/20">
                      {currentBoard?.name || 'Unknown'}
                    </span>
                    <button
                      onClick={() => !task.actionRunning && setEditingBoard(true)}
                      className={`p-0.5 rounded text-dark-500 hover:text-indigo-400 hover:bg-dark-700 transition-colors
                        ${task.actionRunning ? 'opacity-50 cursor-not-allowed' : ''}`}
                      title={task.actionRunning ? 'Stop the agent first to move the task' : 'Move to another board'}
                    >
                      <Edit3 className="w-3 h-3" />
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Transition history (with commits interleaved chronologically) */}
            <TaskTimeline
              history={task.history}
              commits={task.commits}
              createdAt={task.createdAt}
              onOpenEntry={setHistoryDetail}
              onOpenCommit={(hash) => { setClickedCommitHash(hash); setShowAllCommits(true); }}
              onRemoveCommit={async (hash) => {
                await api.removeTaskCommit(task.agentId, task.id, hash);
                onRefresh();
              }}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-dark-700">
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400
              hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40
              rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-4 py-1.5 text-xs text-dark-300 hover:text-dark-100
                bg-dark-800 border border-dark-700 hover:border-dark-500 rounded-lg transition-colors"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>

    {/* All commits diff overlay */}
    {showAllCommits && task.commits?.length > 0 && (
      <AllCommitsDiffModal
        taskId={task.id}
        commits={task.commits}
        initialHash={clickedCommitHash}
        onClose={() => { setShowAllCommits(false); setClickedCommitHash(null); }}
        agentId={task.agentId}
        project={task.project}
      />
    )}

    {/* Board move confirmation modal */}
    {boardMoveTarget && (() => {
      const destBoard = boards?.find(b => b.id === boardMoveTarget);
      const destCol = destBoard?.workflow?.columns?.[0]?.label || 'first column';
      return (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="bg-dark-900 border border-amber-500/30 rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 rounded-full bg-amber-500/20 flex items-center justify-center shrink-0">
                <ArrowRight className="w-5 h-5 text-amber-400" />
              </div>
              <div>
                <h3 className="text-dark-100 font-semibold text-sm">Move to another board?</h3>
                <p className="text-dark-400 text-xs mt-0.5">The task will be moved and placed in the first column</p>
              </div>
            </div>
            <div className="bg-dark-800/60 rounded-lg p-3 mb-4 text-xs space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-dark-500 w-12">From:</span>
                <span className="text-dark-300 font-medium">{currentBoard?.name || 'Current board'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-dark-500 w-12">To:</span>
                <span className="text-amber-300 font-medium">{destBoard?.name || 'Unknown'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-dark-500 w-12">Column:</span>
                <span className="text-dark-300">{destCol}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setBoardMoveTarget(null)}
                className="px-3 py-1.5 rounded-lg text-sm text-dark-400 hover:bg-dark-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleBoardMoveConfirm}
                disabled={movingBoard}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-amber-600 hover:bg-amber-500 text-white disabled:opacity-40 transition-colors"
              >
                {movingBoard ? 'Moving...' : 'Confirm move'}
              </button>
            </div>
          </div>
        </div>
      );
    })()}

    {/* History detail modal */}
    {historyDetail && (
      <HistoryDetailModal
        entry={historyDetail}
        agents={agents}
        onClose={() => setHistoryDetail(null)}
      />
    )}
    </>
  );
}
