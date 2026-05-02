import { useState, useRef, useEffect } from 'react';
import {
  Trash2, X, AlertTriangle, Edit3, Save, Check, Tag, Calendar,
  ChevronDown, Zap, User, GitCommit, Repeat, FolderKanban, Loader2, Layers,
  ArrowRight, Hand, Pause, XCircle,
} from 'lucide-react';
import { api, updateTask as updateTaskById } from '../../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AllCommitsDiffModal from '../AllCommitsDiffModal';
import ExecutionLogEntry from './ExecutionLogEntry';
import { SOURCE_META, TASK_TYPES, TASK_TYPE_MAP, timeAgo, formatDate } from './taskConstants';

export default function TaskDetailModal({ task, agents, allProjects, onClose, onRefresh, onDelete, statusOptions, onNavigateToAgent, boards, activeBoardId }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const [editTitle, setEditTitle] = useState(task.title || '');
  const [saving, setSaving] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [editProject, setEditProject] = useState(task.project || '');
  const [savingProject, setSavingProject] = useState(false);
  const [editingAgent, setEditingAgent] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [editingType, setEditingType] = useState(false);
  const [savingType, setSavingType] = useState(false);
  const [editingBoard, setEditingBoard] = useState(false);
  const [boardMoveTarget, setBoardMoveTarget] = useState(null);
  const [movingBoard, setMovingBoard] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refining, setRefining] = useState(false);
  const [showAllCommits, setShowAllCommits] = useState(false);
  const [clickedCommitHash, setClickedCommitHash] = useState(null);
  const statusRef = useRef(null);
  const textareaRef = useRef(null);
  const projectInputRef = useRef(null);
  const refineRef = useRef(null);

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
    try {
      const body = {};
      if (textChanged) body.text = trimmedText;
      if (titleChanged) body.title = trimmedTitle;
      await api.updateTask(task.agentId, task.id, body);
      await onRefresh();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (newStatus) => {
    setStatusOpen(false);
    if (newStatus === task.status) return;
    try {
      await api.setTaskStatus(task.agentId, task.id, newStatus);
      onRefresh();
    } catch (err) {
      console.error('[TasksBoard] Status change failed:', err.message);
    }
  };

  const handleProjectSave = async () => {
    const trimmed = editProject.trim();
    if (trimmed === (task.project || '')) { setEditingProject(false); return; }
    setSavingProject(true);
    try {
      await api.updateTaskProject(task.agentId, task.id, trimmed || null);
      await onRefresh();
      setEditingProject(false);
    } finally {
      setSavingProject(false);
    }
  };

  const handleDelete = async () => {
    await onDelete(task);
    onClose();
  };

  const handleBoardMoveConfirm = async () => {
    if (!boardMoveTarget) return;
    setMovingBoard(true);
    try {
      const destBoard = boards.find(b => b.id === boardMoveTarget);
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
  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;
  const currentStatus = statusOptions.find(s => s.value === task.status) || statusOptions[0];
  const lastStatusId = statusOptions[statusOptions.length - 1]?.value;

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
                  {statusOptions.map(opt => (
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
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
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
                        {agents.filter(a => a.enabled !== false && a.status === 'idle').length === 0 && (
                          <div className="px-3 py-2 text-xs text-dark-500 italic">No idle agents available</div>
                        )}
                        {agents.filter(a => a.enabled !== false && a.status === 'idle').map(a => (
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
                    code: ({ inline, children }) => inline
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
            {task.recurrence?.enabled && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Repeat className="w-3.5 h-3.5" />
                  Recurring
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium ring-1 bg-teal-500/10 text-teal-400 ring-teal-500/20">
                  {task.recurrence.period === 'custom'
                    ? `Every ${task.recurrence.intervalMinutes} min`
                    : task.recurrence.period === 'hourly' ? 'Every hour'
                    : task.recurrence.period === 'daily' ? 'Every day'
                    : task.recurrence.period === 'weekly' ? 'Every week'
                    : task.recurrence.period === 'monthly' ? 'Every month'
                    : task.recurrence.period}
                </span>
              </div>
            )}

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
                      await api.updateTask(task.agentId, task.id, { isManual: newVal });
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

            {/* Project */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <Tag className="w-3.5 h-3.5" />
                Project
              </div>
              {editingProject ? (
                <div className="flex items-center gap-1.5">
                  <input
                    ref={projectInputRef}
                    type="text"
                    value={editProject}
                    onChange={e => setEditProject(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleProjectSave(); if (e.key === 'Escape') { setEditingProject(false); setEditProject(task.project || ''); } }}
                    list="detail-task-projects"
                    placeholder="No project"
                    className="px-2 py-0.5 w-32 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200
                      placeholder-dark-500 focus:outline-none focus:border-indigo-500 transition-colors"
                    autoFocus
                  />
                  <datalist id="detail-task-projects">
                    {(allProjects || []).map(p => <option key={p} value={p} />)}
                  </datalist>
                  <button
                    onClick={handleProjectSave}
                    disabled={savingProject}
                    className="p-0.5 rounded text-emerald-400 hover:text-emerald-300 hover:bg-dark-700 transition-colors"
                    title="Save"
                  >
                    <Check className="w-3 h-3" />
                  </button>
                  <button
                    onClick={() => { setEditingProject(false); setEditProject(task.project || ''); }}
                    className="p-0.5 rounded text-dark-500 hover:text-dark-300 hover:bg-dark-700 transition-colors"
                    title="Cancel"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {task.project ? (
                    <span className="text-xs px-2 py-0.5 rounded-full font-medium
                      bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
                      {task.project}
                    </span>
                  ) : (
                    <span className="text-xs text-dark-500 italic">None</span>
                  )}
                  <button
                    onClick={() => { setEditProject(task.project || ''); setEditingProject(true); }}
                    className="p-0.5 rounded text-dark-500 hover:text-indigo-400 hover:bg-dark-700 transition-colors"
                    title="Change project"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Task Type */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <Layers className="w-3.5 h-3.5" />
                Type
              </div>
              {editingType ? (
                <div className="flex items-center gap-1.5">
                  <select
                    autoFocus
                    defaultValue={task.taskType || ''}
                    onChange={async e => {
                      const newType = e.target.value || null;
                      if (newType === (task.taskType || '')) { setEditingType(false); return; }
                      setSavingType(true);
                      try {
                        await api.updateTask(task.agentId, task.id, { taskType: newType || '' });
                        onRefresh?.();
                      } finally {
                        setSavingType(false);
                        setEditingType(false);
                      }
                    }}
                    disabled={savingType}
                    className="px-2 py-0.5 w-36 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200
                      focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value="">None</option>
                    {TASK_TYPES.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setEditingType(false)}
                    className="p-0.5 rounded text-dark-500 hover:text-dark-300 hover:bg-dark-700 transition-colors"
                    title="Cancel"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {task.taskType && TASK_TYPE_MAP[task.taskType] ? (() => {
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
                  <button
                    onClick={() => setEditingType(true)}
                    className="p-0.5 rounded text-dark-500 hover:text-indigo-400 hover:bg-dark-700 transition-colors"
                    title="Change type"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Assignee */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <User className="w-3.5 h-3.5" />
                Assignee
              </div>
              {editingAgent ? (
                <div className="flex items-center gap-1.5">
                  <select
                    autoFocus
                    defaultValue={task.assignee || ''}
                    onChange={async e => {
                      const targetId = e.target.value || null;
                      if (targetId === (task.assignee || '')) { setEditingAgent(false); return; }
                      setTransferring(true);
                      try {
                        await api.setTaskAssignee(task.agentId, task.id, targetId);
                        onRefresh?.();
                      } finally {
                        setTransferring(false);
                        setEditingAgent(false);
                      }
                    }}
                    disabled={transferring}
                    className="px-2 py-0.5 w-36 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200
                      focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value="">Unassigned</option>
                    {agents.map(a => (
                      <option key={a.id} value={a.id}>{a.icon} {a.name}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => setEditingAgent(false)}
                    className="p-0.5 rounded text-dark-500 hover:text-dark-300 hover:bg-dark-700 transition-colors"
                    title="Cancel"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  {(() => {
                    const assignee = task.assignee ? agents.find(a => a.id === task.assignee) : null;
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
                  <button
                    onClick={() => setEditingAgent(true)}
                    className="p-0.5 rounded text-dark-500 hover:text-indigo-400 hover:bg-dark-700 transition-colors"
                    title="Reassign to another agent"
                  >
                    <Edit3 className="w-3 h-3" />
                  </button>
                </div>
              )}
            </div>

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
                      {boards.map(b => (
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

            {/* Transition history */}
            {(task.history && task.history.length > 0) ? (
              <div className="space-y-0">
                <div className="text-[10px] uppercase tracking-wider text-dark-500 font-semibold mb-1.5">History</div>
                <div className="relative pl-4 border-l border-dark-700 space-y-1.5">
                  {task.history.map((h, i) => (
                    <div key={i} className="relative">
                      <div className="flex items-start gap-2">
                        <div className="absolute -left-[17px] top-1 w-2 h-2 rounded-full bg-dark-600 ring-2 ring-dark-900" />
                        <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
                          <div className="flex items-center gap-1.5 text-xs min-w-0">
                            {h.type === 'execution' ? (
                              <ExecutionLogEntry entry={h} index={i} />
                            ) : h.type === 'edit' ? (
                            <>
                              <Edit3 className="w-2.5 h-2.5 text-dark-400 flex-shrink-0" />
                              <span className="text-dark-200 font-medium">edited {h.field || (h.fields ? h.fields.map(f => f.field).join(', ') : 'task')}</span>
                              {h.by && (
                                <span className="text-dark-500 truncate">by {h.by}</span>
                              )}
                            </>
                          ) : h.type === 'reassign' ? (
                            <>
                              <User className="w-2.5 h-2.5 text-dark-400 flex-shrink-0" />
                              <span className="text-dark-200 font-medium">reassigned</span>
                              {h.by && (
                                <span className="text-dark-500 truncate">by {h.by}</span>
                              )}
                            </>
                          ) : h.type === 'error' ? (
                            <>
                              <XCircle className="w-2.5 h-2.5 text-red-400 flex-shrink-0" />
                              <span className="text-red-300 font-medium">error</span>
                              {h.from && (
                                <span className="text-dark-500 truncate">in {h.from}</span>
                              )}
                              {h.by && (
                                <span className="text-dark-500 truncate">by {h.by}</span>
                              )}
                              {h.error && (
                                <span className="text-red-400/70 truncate" title={h.error}>{h.error.slice(0, 80)}</span>
                              )}
                            </>
                          ) : h.type === 'stopped' ? (
                            <>
                              <Pause className="w-2.5 h-2.5 text-yellow-400 flex-shrink-0" />
                              <span className="text-yellow-300 font-medium">stopped</span>
                              {h.by && (
                                <span className="text-dark-500 truncate">by {h.by}</span>
                              )}
                            </>
                          ) : (
                            <>
                              {h.from && (
                                <>
                                  <span className="text-dark-500">{h.from}</span>
                                  <ArrowRight className="w-2.5 h-2.5 text-dark-600 flex-shrink-0" />
                                </>
                              )}
                              <span className="text-dark-200 font-medium">{h.status}</span>
                              {h.by && (
                                <span className="text-dark-500 truncate">by {h.by}</span>
                              )}
                            </>
                          )}
                        </div>
                        <span className="text-[10px] text-dark-500 flex-shrink-0" title={formatDate(h.at)}>
                          {timeAgo(h.at)}
                        </span>
                      </div>
                    </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <>
                {task.createdAt && (
                  <div className="flex items-center justify-between py-1">
                    <div className="flex items-center gap-2 text-xs text-dark-400">
                      <Calendar className="w-3.5 h-3.5" />
                      Created
                    </div>
                    <span className="text-xs text-dark-300" title={formatDate(task.createdAt)}>
                      {timeAgo(task.createdAt)}
                    </span>
                  </div>
                )}
              </>
            )}

            {/* Associated commits */}
            {task.commits && task.commits.length > 0 && (
              <div className="space-y-0">
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-[10px] uppercase tracking-wider text-dark-500 font-semibold">Commits ({task.commits.length})</div>
                  <button
                    onClick={() => { setClickedCommitHash(null); setShowAllCommits(true); }}
                    className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors font-medium"
                  >
                    View all diffs
                  </button>
                </div>
                <div className="space-y-1">
                  {task.commits.map((c, i) => (
                    <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded-lg bg-dark-800/50 border border-dark-700/50 group hover:border-indigo-500/30 transition-colors">
                      <button
                        onClick={() => { setClickedCommitHash(c.hash); setShowAllCommits(true); }}
                        className="flex items-center gap-2 min-w-0 text-left cursor-pointer"
                        title="View commit diff"
                      >
                        <GitCommit className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                        <code className="text-xs text-amber-300 font-mono hover:text-amber-200 transition-colors">{c.hash?.slice(0, 7)}</code>
                        {c.message && (
                          <span className="text-xs text-dark-300 truncate">{c.message}</span>
                        )}
                      </button>
                      <div className="flex items-center gap-2">
                        {c.date && (
                          <span className="text-[10px] text-dark-500 flex-shrink-0" title={formatDate(c.date)}>
                            {timeAgo(c.date)}
                          </span>
                        )}
                        <button
                          onClick={async () => {
                            await api.removeTaskCommit(task.agentId, task.id, c.hash);
                            onRefresh();
                          }}
                          className="p-0.5 rounded text-dark-600 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-all"
                          title="Remove commit link"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
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
    </>
  );
}
