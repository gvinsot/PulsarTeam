import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  Search, Trash2, ArrowRightLeft, Clock, X, AlertTriangle,
  Edit3, Save, Check, User, Tag, Calendar, ChevronDown, Plus
} from 'lucide-react';
import { api } from '../api';

// ── Column definitions ──────────────────────────────────────────────────────

const COLUMNS = [
  {
    id: 'backlog',
    label: 'Backlog',
    statuses: ['backlog'],
    dropStatus: 'backlog',
    dot: 'bg-purple-500',
    headerText: 'text-purple-300',
    countCls: 'bg-purple-500/20 text-purple-300',
    dropRing: 'ring-purple-500/40 bg-purple-500/5',
    headerActive: 'border-purple-500/60',
  },
  {
    id: 'todo',
    label: 'To Do',
    statuses: ['pending', 'error'],
    dropStatus: 'pending',
    dot: 'bg-slate-500',
    headerText: 'text-dark-300',
    countCls: 'bg-dark-700 text-dark-400',
    dropRing: 'ring-slate-500/40 bg-slate-500/5',
    headerActive: 'border-slate-500/60',
  },
  {
    id: 'inprogress',
    label: 'In Progress',
    statuses: ['in_progress'],
    dropStatus: 'in_progress',
    dot: 'bg-amber-400',
    headerText: 'text-amber-300',
    countCls: 'bg-amber-500/20 text-amber-300',
    dropRing: 'ring-amber-500/40 bg-amber-500/5',
    headerActive: 'border-amber-400/60',
  },
  {
    id: 'done',
    label: 'Done',
    statuses: ['done'],
    dropStatus: 'done',
    dot: 'bg-emerald-400',
    headerText: 'text-emerald-300',
    countCls: 'bg-emerald-500/20 text-emerald-300',
    dropRing: 'ring-emerald-500/40 bg-emerald-500/5',
    headerActive: 'border-emerald-400/60',
  },
];

const STATUS_OPTIONS = [
  { value: 'backlog',     label: 'Backlog',      dot: 'bg-purple-400',  text: 'text-purple-300' },
  { value: 'pending',     label: 'To Do',        dot: 'bg-slate-400',   text: 'text-slate-300' },
  { value: 'in_progress', label: 'In Progress',  dot: 'bg-amber-400',   text: 'text-amber-300' },
  { value: 'done',        label: 'Done',         dot: 'bg-emerald-400', text: 'text-emerald-300' },
  { value: 'error',       label: 'Error',        dot: 'bg-red-400',     text: 'text-red-300' },
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

const SOURCE_META = {
  user:  { label: () => 'User',              cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20' },
  agent: { label: (s) => s.name || 'Agent',  cls: 'text-purple-400 bg-purple-500/10 ring-purple-500/20' },
  api:   { label: () => 'API',               cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20' },
  mcp:   { label: () => 'MCP',               cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20' },
};

// ── CreateTaskModal ──────────────────────────────────────────────────────────

function CreateTaskModal({ agents, allProjects, defaultAgentId, onClose, onCreated }) {
  const [text, setText] = useState('');
  const [agentId, setAgentId] = useState(defaultAgentId || agents[0]?.id || '');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('backlog');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !agentId) return;
    setSaving(true);
    try {
      await api.addTodo(agentId, trimmed, project.trim() || undefined, status);
      await onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const enabledAgents = agents.filter(a => a.enabled !== false);
  const CREATE_STATUSES = STATUS_OPTIONS.filter(s => ['backlog', 'pending'].includes(s.value));
  const currentStatus = STATUS_OPTIONS.find(s => s.value === status);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-md bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Plus className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-dark-100">Create Task</span>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-4 px-5 py-4">
          {/* Text */}
          <div>
            <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
              Task <span className="text-red-400">*</span>
            </label>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={e => setText(e.target.value)}
              rows={4}
              placeholder="Describe the task..."
              className="w-full px-3 py-2.5 bg-dark-800 border border-dark-700 rounded-lg text-sm
                text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500
                resize-none leading-relaxed transition-colors"
            />
          </div>

          {/* Assign to */}
          <div>
            <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
              <User className="inline w-3 h-3 mr-1" />Assign to <span className="text-red-400">*</span>
            </label>
            <select
              value={agentId}
              onChange={e => setAgentId(e.target.value)}
              className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
                focus:outline-none focus:border-indigo-500 transition-colors"
            >
              {enabledAgents.map(a => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </div>

          {/* Project + Status row */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
                <Tag className="inline w-3 h-3 mr-1" />Project
              </label>
              <input
                type="text"
                value={project}
                onChange={e => setProject(e.target.value)}
                placeholder={allProjects[0] || 'e.g. backend'}
                list="create-task-projects"
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
                  placeholder-dark-500 focus:outline-none focus:border-indigo-500 transition-colors"
              />
              <datalist id="create-task-projects">
                {allProjects.map(p => <option key={p} value={p} />)}
              </datalist>
            </div>
            <div className="w-36">
              <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
                Status
              </label>
              <select
                value={status}
                onChange={e => setStatus(e.target.value)}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm focus:outline-none focus:border-indigo-500 transition-colors"
                style={{ color: currentStatus?.text?.replace('text-', '') || 'inherit' }}
              >
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Actions */}
          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-xs text-dark-300 hover:text-dark-100
                bg-dark-800 border border-dark-700 hover:border-dark-500 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || !text.trim() || !agentId}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium text-white
                bg-indigo-500 hover:bg-indigo-600 disabled:opacity-50 rounded-lg transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              {saving ? 'Creating…' : 'Create Task'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── TaskDetailModal ──────────────────────────────────────────────────────────

function TaskDetailModal({ task, agents, onClose, onRefresh, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const [saving, setSaving] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const transferRef = useRef(null);
  const statusRef = useRef(null);
  const textareaRef = useRef(null);

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
      if (transferRef.current && !transferRef.current.contains(e.target)) setTransferOpen(false);
      if (statusRef.current && !statusRef.current.contains(e.target)) setStatusOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'Escape') {
        if (editing) { setEditing(false); setEditText(task.text); }
        else onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [editing, task.text, onClose]);

  const handleSave = async () => {
    const trimmed = editText.trim();
    if (!trimmed || trimmed === task.text) { setEditing(false); return; }
    setSaving(true);
    try {
      await api.updateTodoText(task.agentId, task.id, trimmed);
      await onRefresh();
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const handleStatusChange = async (newStatus) => {
    setStatusOpen(false);
    if (newStatus === task.status) return;
    await api.setTodoStatus(task.agentId, task.id, newStatus);
    onRefresh();
  };

  const handleTransfer = async (targetAgentId) => {
    setTransferOpen(false);
    await api.transferTodo(task.agentId, task.id, targetAgentId);
    onRefresh();
    onClose();
  };

  const handleDelete = async () => {
    await onDelete(task);
    onClose();
  };

  const isError = task.status === 'error';
  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;
  const currentStatus = STATUS_OPTIONS.find(s => s.value === (task.status || 'pending')) || STATUS_OPTIONS[0];
  const otherAgents = agents.filter(a => a.id !== task.agentId && a.enabled !== false);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col max-h-[90vh] animate-fadeIn">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            {/* Status badge / selector */}
            <div className="relative" ref={statusRef}>
              <button
                onClick={() => setStatusOpen(o => !o)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                  border transition-colors hover:opacity-80
                  ${isError
                    ? 'bg-red-500/15 text-red-300 border-red-500/30'
                    : task.status === 'done'
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                      : task.status === 'in_progress'
                        ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
                        : 'bg-dark-700 text-dark-300 border-dark-600'
                  }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${currentStatus.dot}`} />
                {currentStatus.label}
                <ChevronDown className="w-3 h-3 opacity-60" />
              </button>
              {statusOpen && (
                <div className="absolute left-0 top-8 z-50 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl py-1 min-w-[140px]">
                  {STATUS_OPTIONS.map(opt => (
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
                <button
                  onClick={() => { setEditText(task.text); setEditing(true); }}
                  className="flex items-center gap-1 text-xs text-dark-500 hover:text-indigo-400 transition-colors"
                >
                  <Edit3 className="w-3 h-3" />
                  Edit
                </button>
              )}
            </div>
            {editing ? (
              <div className="space-y-2">
                <textarea
                  ref={textareaRef}
                  value={editText}
                  onChange={e => setEditText(e.target.value)}
                  rows={5}
                  className="w-full px-3 py-2.5 bg-dark-800 border border-indigo-500/50 rounded-lg text-sm
                    text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500
                    resize-none leading-relaxed"
                  placeholder="Task description..."
                />
                <div className="flex gap-2 justify-end">
                  <button
                    onClick={() => { setEditing(false); setEditText(task.text); }}
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
              <p
                className={`text-sm leading-relaxed whitespace-pre-wrap cursor-text
                  ${isError ? 'text-red-300' : 'text-dark-200'}`}
                onClick={() => { setEditText(task.text); setEditing(true); }}
                title="Click to edit"
              >
                {task.text}
              </p>
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

            {/* Assigned to (agent) */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <User className="w-3.5 h-3.5" />
                Assigned to
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full font-medium
                  bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/20">
                  {task.agentName}
                </span>
                {/* Transfer */}
                <div className="relative" ref={transferRef}>
                  <button
                    onClick={() => setTransferOpen(o => !o)}
                    className="p-1 rounded text-dark-500 hover:text-indigo-400 hover:bg-dark-700 transition-colors"
                    title="Transfer to another agent"
                  >
                    <ArrowRightLeft className="w-3 h-3" />
                  </button>
                  {transferOpen && (
                    <div className="absolute right-0 top-7 z-50 bg-dark-800 border border-dark-600
                      rounded-xl shadow-2xl shadow-black/40 py-1 min-w-[160px]">
                      <div className="px-3 py-1.5 text-xs text-dark-400 font-semibold border-b border-dark-700 mb-1">
                        Transfer to
                      </div>
                      {otherAgents.length === 0
                        ? <p className="px-3 py-2 text-xs text-dark-500">No other agents</p>
                        : otherAgents.map(a => (
                          <button
                            key={a.id}
                            onClick={() => handleTransfer(a.id)}
                            className="w-full text-left px-3 py-1.5 text-xs text-dark-200
                              hover:bg-dark-700 hover:text-white transition-colors flex items-center gap-2"
                          >
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: a.status === 'busy' ? '#f59e0b' : a.status === 'error' ? '#ef4444' : '#22c55e' }} />
                            {a.name}
                          </button>
                        ))
                      }
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Assigned by (source) */}
            {sourceMeta && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Tag className="w-3.5 h-3.5" />
                  Assigned by
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ring-1 ${sourceMeta.cls}`}>
                  {sourceMeta.label(task.source)}
                </span>
              </div>
            )}

            {/* Project */}
            {task.project && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Tag className="w-3.5 h-3.5" />
                  Project
                </div>
                <span className="text-xs px-2 py-0.5 rounded-full font-medium
                  bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
                  {task.project}
                </span>
              </div>
            )}

            {/* Created */}
            {task.createdAt && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Calendar className="w-3.5 h-3.5" />
                  Created
                </div>
                <span className="text-xs text-dark-300" title={formatDate(task.createdAt)}>
                  {timeAgo(task.createdAt)}
                  <span className="text-dark-500 ml-1.5">· {formatDate(task.createdAt)}</span>
                </span>
              </div>
            )}

            {/* Started */}
            {task.startedAt && (
              <div className="flex items-center justify-between py-2 border-b border-dark-800">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Clock className="w-3.5 h-3.5" />
                  Started
                </div>
                <span className="text-xs text-amber-300/80" title={formatDate(task.startedAt)}>
                  {timeAgo(task.startedAt)}
                  <span className="text-dark-500 ml-1.5">· {formatDate(task.startedAt)}</span>
                </span>
              </div>
            )}

            {/* Completed */}
            {task.completedAt && (
              <div className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2 text-xs text-dark-400">
                  <Check className="w-3.5 h-3.5" />
                  Completed
                </div>
                <span className="text-xs text-emerald-300/80" title={formatDate(task.completedAt)}>
                  {timeAgo(task.completedAt)}
                  <span className="text-dark-500 ml-1.5">· {formatDate(task.completedAt)}</span>
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end px-5 py-3 border-t border-dark-700 gap-2">
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400
              hover:text-red-300 hover:bg-red-500/10 border border-red-500/20 hover:border-red-500/40
              rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Delete task
          </button>
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
  );
}

// ── TaskCard ────────────────────────────────────────────────────────────────

function TaskCard({ task, agents, onDelete, onTransfer, onOpen }) {
  const [transferOpen, setTransferOpen] = useState(false);
  const transferRef = useRef(null);
  const isError = task.status === 'error';
  const isDraggingRef = useRef(false);

  useEffect(() => {
    if (!transferOpen) return;
    const handler = (e) => {
      if (transferRef.current && !transferRef.current.contains(e.target)) setTransferOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [transferOpen]);

  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;

  return (
    <div
      draggable
      onDragStart={(e) => {
        isDraggingRef.current = true;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({ agentId: task.agentId, todoId: task.id }));
        setTimeout(() => e.target.classList.add('opacity-40'), 0);
      }}
      onDragEnd={(e) => {
        e.target.classList.remove('opacity-40');
        // Reset after a tick so click doesn't fire after drop
        setTimeout(() => { isDraggingRef.current = false; }, 50);
      }}
      onClick={() => { if (!isDraggingRef.current) onOpen(task); }}
      className={`group bg-dark-800 rounded-lg border p-3 cursor-pointer
        transition-all hover:shadow-lg hover:shadow-black/20
        ${isError
          ? 'border-red-500/40 bg-red-500/5 hover:border-red-500/60'
          : 'border-dark-700 hover:border-dark-500'
        }`}
    >
      {/* Task text */}
      <p className={`text-sm leading-snug mb-2.5 ${isError ? 'text-red-300' : 'text-dark-200'}`}
        style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {task.text}
      </p>

      {isError && task.error && (
        <div className="flex items-start gap-1.5 mb-2 p-1.5 rounded bg-red-500/10 border border-red-500/20">
          <AlertTriangle className="w-3 h-3 text-red-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-red-400/80 leading-tight"
            style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {task.error}
          </p>
        </div>
      )}

      {/* Badges */}
      <div className="flex flex-wrap gap-1 mb-2.5">
        <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-indigo-500/10 text-indigo-400 ring-1 ring-indigo-500/20">
          {task.agentName}
        </span>
        {task.project && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
            {task.project}
          </span>
        )}
        {sourceMeta && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${sourceMeta.cls}`}>
            {sourceMeta.label(task.source)}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs text-dark-500">
          <Clock className="w-3 h-3" />
          {timeAgo(task.createdAt)}
        </span>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
          {/* Transfer */}
          <div className="relative" ref={transferRef}>
            <button
              onClick={(e) => { e.stopPropagation(); setTransferOpen(o => !o); }}
              className="p-1.5 rounded text-dark-500 hover:text-indigo-400 hover:bg-dark-700 transition-colors"
              title="Transfer to another agent"
            >
              <ArrowRightLeft className="w-3.5 h-3.5" />
            </button>
            {transferOpen && (
              <div className="absolute right-0 bottom-8 z-50 bg-dark-800 border border-dark-600 rounded-xl shadow-2xl shadow-black/40 py-1 min-w-[160px]">
                <div className="px-3 py-1.5 text-xs text-dark-400 font-semibold border-b border-dark-700 mb-1">
                  Transfer to
                </div>
                {agents.filter(a => a.id !== task.agentId && a.enabled !== false).map(a => (
                  <button
                    key={a.id}
                    onClick={(e) => { e.stopPropagation(); setTransferOpen(false); onTransfer(task, a.id); }}
                    className="w-full text-left px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700 hover:text-white transition-colors flex items-center gap-2"
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                      style={{ background: a.status === 'busy' ? '#f59e0b' : a.status === 'error' ? '#ef4444' : '#22c55e' }} />
                    {a.name}
                  </button>
                ))}
                {agents.filter(a => a.id !== task.agentId && a.enabled !== false).length === 0 && (
                  <p className="px-3 py-2 text-xs text-dark-500">No other agents</p>
                )}
              </div>
            )}
          </div>
          {/* Delete */}
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(task); }}
            className="p-1.5 rounded text-dark-500 hover:text-red-400 hover:bg-dark-700 transition-colors"
            title="Delete task"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

// ── KanbanColumn ────────────────────────────────────────────────────────────

function KanbanColumn({ col, tasks, agents, onDelete, onTransfer, onDrop, onOpen }) {
  const [dragOver, setDragOver] = useState(false);

  return (
    <div className="flex flex-col min-w-[300px] w-[300px] flex-shrink-0">
      {/* Column header */}
      <div className={`flex items-center justify-between px-3 py-2.5 rounded-t-xl border border-b-2
        transition-colors mb-0
        ${dragOver
          ? `bg-dark-750 ${col.headerActive} border-b-2`
          : 'bg-dark-800/60 border-dark-700/50'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${col.dot}`} />
          <span className={`text-sm font-semibold ${col.headerText}`}>{col.label}</span>
        </div>
        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${col.countCls}`}>
          {tasks.length}
        </span>
      </div>

      {/* Drop zone */}
      <div
        className={`flex-1 flex flex-col gap-2 p-2 rounded-b-xl border border-t-0 min-h-[120px]
          transition-all duration-150
          ${dragOver
            ? `ring-2 ring-inset ${col.dropRing} border-dark-600`
            : 'bg-dark-800/20 border-dark-700/30'
          }`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onDrop(e, col); }}
      >
        {tasks.map(task => (
          <TaskCard
            key={`${task.agentId}-${task.id}`}
            task={task}
            agents={agents}
            onDelete={onDelete}
            onTransfer={onTransfer}
            onOpen={onOpen}
          />
        ))}
        {tasks.length === 0 && (
          <div className={`flex-1 flex items-center justify-center text-xs py-8
            transition-colors ${dragOver ? 'text-dark-400' : 'text-dark-700'}`}>
            {dragOver ? '↓ Drop here' : 'No tasks'}
          </div>
        )}
      </div>
    </div>
  );
}

// ── TasksBoard ──────────────────────────────────────────────────────────────

export default function TasksBoard({ agents, onRefresh }) {
  const [projectFilter, setProjectFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedTask, setSelectedTask] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);

  // Aggregate all todos from all agents
  const allTasks = useMemo(() =>
    agents.flatMap(a =>
      (a.todoList || []).map(t => ({ ...t, agentId: a.id, agentName: a.name }))
    ),
    [agents]
  );

  // Keep modal task in sync with live data
  const liveSelectedTask = useMemo(() => {
    if (!selectedTask) return null;
    return allTasks.find(t => t.id === selectedTask.id && t.agentId === selectedTask.agentId) || null;
  }, [selectedTask, allTasks]);

  // Unique projects for filter
  const allProjects = useMemo(() => {
    const ps = new Set(allTasks.map(t => t.project).filter(Boolean));
    return Array.from(ps).sort();
  }, [allTasks]);

  // Filtered tasks
  const filteredTasks = useMemo(() => {
    const q = search.toLowerCase();
    return allTasks.filter(t => {
      if (agentFilter && t.agentId !== agentFilter) return false;
      if (projectFilter && t.project !== projectFilter) return false;
      if (q && !t.text.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [allTasks, agentFilter, projectFilter, search]);

  // Group by column
  const tasksByColumn = useMemo(() => {
    const groups = {};
    COLUMNS.forEach(col => {
      groups[col.id] = filteredTasks.filter(t => col.statuses.includes(t.status || 'pending'));
    });
    return groups;
  }, [filteredTasks]);

  const handleDelete = useCallback(async (task) => {
    await api.deleteTodo(task.agentId, task.id);
    onRefresh();
  }, [onRefresh]);

  const handleTransfer = useCallback(async (task, targetAgentId) => {
    await api.transferTodo(task.agentId, task.id, targetAgentId);
    onRefresh();
  }, [onRefresh]);

  const handleDrop = useCallback(async (e, col) => {
    try {
      const { agentId, todoId } = JSON.parse(e.dataTransfer.getData('application/json'));
      const task = allTasks.find(t => t.id === todoId && t.agentId === agentId);
      if (!task || col.statuses.includes(task.status || 'pending')) return;
      await api.setTodoStatus(agentId, todoId, col.dropStatus);
      onRefresh();
    } catch { /* invalid drag data */ }
  }, [allTasks, onRefresh]);

  const totalByStatus = useMemo(() => ({
    pending: allTasks.filter(t => t.status === 'pending' || !t.status).length,
    error: allTasks.filter(t => t.status === 'error').length,
    in_progress: allTasks.filter(t => t.status === 'in_progress').length,
    done: allTasks.filter(t => t.status === 'done').length,
  }), [allTasks]);

  const activeFilters = [agentFilter, projectFilter, search].filter(Boolean).length;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 border-b border-dark-700 bg-dark-900/30">
        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-dark-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="pl-8 pr-7 py-1.5 w-48 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              placeholder-dark-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
          {search && (
            <button onClick={() => setSearch('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-dark-400 hover:text-dark-200">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        {/* Agent filter */}
        <select
          value={agentFilter}
          onChange={e => setAgentFilter(e.target.value)}
          className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
            focus:outline-none focus:border-indigo-500 transition-colors"
        >
          <option value="">All agents</option>
          {agents.filter(a => a.enabled !== false).map(a => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>

        {/* Project filter */}
        {allProjects.length > 0 && (
          <select
            value={projectFilter}
            onChange={e => setProjectFilter(e.target.value)}
            className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              focus:outline-none focus:border-indigo-500 transition-colors"
          >
            <option value="">All projects</option>
            {allProjects.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}

        {/* Clear filters */}
        {activeFilters > 0 && (
          <button
            onClick={() => { setAgentFilter(''); setProjectFilter(''); setSearch(''); }}
            className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-amber-400 bg-amber-500/10
              border border-amber-500/20 rounded-lg hover:bg-amber-500/20 transition-colors"
          >
            <X className="w-3 h-3" />
            Clear filters ({activeFilters})
          </button>
        )}

        {/* Stats */}
        <div className="ml-auto flex items-center gap-3 text-xs text-dark-500">
          <span>{totalByStatus.pending + totalByStatus.error} pending</span>
          <span className="text-amber-400/70">{totalByStatus.in_progress} active</span>
          <span className="text-emerald-400/70">{totalByStatus.done} done</span>
          {totalByStatus.error > 0 && (
            <span className="text-red-400/70">{totalByStatus.error} errors</span>
          )}
        </div>

        {/* Create Task */}
        <button
          onClick={() => setCreateOpen(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white
            bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-colors flex-shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          New Task
        </button>
      </div>

      {/* Board */}
      <div className="flex-1 overflow-auto min-h-0">
        <div className="flex gap-4 p-6 h-full min-w-max">
          {COLUMNS.map(col => (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={tasksByColumn[col.id] || []}
              agents={agents}
              onDelete={handleDelete}
              onTransfer={handleTransfer}
              onDrop={handleDrop}
              onOpen={setSelectedTask}
            />
          ))}
        </div>
      </div>

      {/* Task detail modal */}
      {liveSelectedTask && (
        <TaskDetailModal
          task={liveSelectedTask}
          agents={agents}
          onClose={() => setSelectedTask(null)}
          onRefresh={onRefresh}
          onDelete={handleDelete}
        />
      )}

      {/* Create task modal */}
      {createOpen && (
        <CreateTaskModal
          agents={agents}
          allProjects={allProjects}
          defaultAgentId={agentFilter || null}
          onClose={() => setCreateOpen(false)}
          onCreated={onRefresh}
        />
      )}
    </div>
  );
}
