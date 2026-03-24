import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  Search, Trash2, Clock, X, AlertTriangle,
  Edit3, Save, Check, Tag, Calendar, ChevronDown, Plus, Settings,
  ArrowRight, Zap, User
} from 'lucide-react';
import { api } from '../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// ── Color mapping (hex → Tailwind classes) ──────────────────────────────────

const COLOR_MAP = {
  '#a855f7': { dot: 'bg-purple-500',  headerText: 'text-purple-300', countCls: 'bg-purple-500/20 text-purple-300', dropRing: 'ring-purple-500/40 bg-purple-500/5', headerActive: 'border-purple-500/60', statusDot: 'bg-purple-400', statusText: 'text-purple-300' },
  '#6b7280': { dot: 'bg-gray-500',    headerText: 'text-gray-300',   countCls: 'bg-gray-500/20 text-gray-300',     dropRing: 'ring-gray-500/40 bg-gray-500/5',     headerActive: 'border-gray-500/60',   statusDot: 'bg-gray-400',   statusText: 'text-gray-300' },
  '#3b82f6': { dot: 'bg-blue-500',    headerText: 'text-blue-300',   countCls: 'bg-blue-500/20 text-blue-300',     dropRing: 'ring-blue-500/40 bg-blue-500/5',     headerActive: 'border-blue-500/60',   statusDot: 'bg-blue-400',   statusText: 'text-blue-300' },
  '#eab308': { dot: 'bg-amber-400',   headerText: 'text-amber-300',  countCls: 'bg-amber-500/20 text-amber-300',   dropRing: 'ring-amber-500/40 bg-amber-500/5',   headerActive: 'border-amber-400/60',  statusDot: 'bg-amber-400',  statusText: 'text-amber-300' },
  '#22c55e': { dot: 'bg-emerald-400', headerText: 'text-emerald-300',countCls: 'bg-emerald-500/20 text-emerald-300',dropRing: 'ring-emerald-500/40 bg-emerald-500/5',headerActive: 'border-emerald-400/60', statusDot: 'bg-emerald-400',statusText: 'text-emerald-300' },
  '#ef4444': { dot: 'bg-red-400',     headerText: 'text-red-300',    countCls: 'bg-red-500/20 text-red-300',       dropRing: 'ring-red-500/40 bg-red-500/5',       headerActive: 'border-red-400/60',    statusDot: 'bg-red-400',    statusText: 'text-red-300' },
  '#64748b': { dot: 'bg-slate-500',   headerText: 'text-dark-300',   countCls: 'bg-dark-700 text-dark-400',        dropRing: 'ring-slate-500/40 bg-slate-500/5',   headerActive: 'border-slate-500/60',  statusDot: 'bg-slate-400',  statusText: 'text-slate-300' },
};

const DEFAULT_COLOR = COLOR_MAP['#6b7280'];

function colorClasses(hex) {
  return COLOR_MAP[hex] || DEFAULT_COLOR;
}

function buildColumns(workflowColumns) {
  return workflowColumns.map(col => {
    const c = colorClasses(col.color);
    return {
      id: col.id,
      label: col.label,
      statuses: [col.id],
      dropStatus: col.id,
      dot: c.dot,
      headerText: c.headerText,
      countCls: c.countCls,
      dropRing: c.dropRing,
      headerActive: c.headerActive,
      showAgent: col.showAgent || false,
    };
  });
}

function buildStatusOptions(workflowColumns) {
  return workflowColumns.map(col => {
    const c = colorClasses(col.color);
    return { value: col.id, label: col.label, dot: c.statusDot, text: c.statusText };
  });
}

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

function CreateTaskModal({ agents, allProjects, onClose, onCreated, statusOptions }) {
  const [text, setText] = useState('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState('idea');
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Auto-pick the first enabled agent as container (tasks are no longer agent-specific)
  const defaultAgentId = agents.find(a => a.enabled !== false)?.id || '';

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
    if (!trimmed || !defaultAgentId) return;
    setSaving(true);
    try {
      await api.addTodo(defaultAgentId, trimmed, project.trim() || undefined, status);
      await onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const CREATE_STATUSES = statusOptions.filter(s => ['idea', 'backlog', 'pending'].includes(s.value));
  const currentStatus = statusOptions.find(s => s.value === status);

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
                {statusOptions.map(opt => (
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
              disabled={saving || !text.trim()}
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

function TaskDetailModal({ task, agents, allProjects, onClose, onRefresh, onDelete, statusOptions }) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(task.text);
  const [saving, setSaving] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const [editingProject, setEditingProject] = useState(false);
  const [editProject, setEditProject] = useState(task.project || '');
  const [savingProject, setSavingProject] = useState(false);
  const [editingAgent, setEditingAgent] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refining, setRefining] = useState(false);
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

  const handleProjectSave = async () => {
    const trimmed = editProject.trim();
    if (trimmed === (task.project || '')) { setEditingProject(false); return; }
    setSavingProject(true);
    try {
      await api.updateTodoProject(task.agentId, task.id, trimmed || null);
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

  const isError = task.status === 'error';
  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;
  const currentStatus = statusOptions.find(s => s.value === (task.status || 'pending')) || statusOptions[0];

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[80vw] max-w-5xl h-[80vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn">

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
                  rows={15}
                  className="w-full h-full min-h-[300px] px-3 py-2.5 bg-dark-800 border border-indigo-500/50 rounded-lg text-sm
                    text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500
                    resize-y leading-relaxed font-mono"
                  placeholder="Task description (supports Markdown)..."
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
              <div
                className={`text-sm leading-relaxed cursor-text
                  ${isError ? 'text-red-300' : 'text-dark-200'}`}
                onClick={() => { setEditText(task.text); setEditing(true); }}
                title="Click to edit"
              >
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
                    h1: ({ children }) => <h1 className="text-lg font-bold text-white mt-3 mb-1">{children}</h1>,
                    h2: ({ children }) => <h2 className="text-base font-bold text-white mt-3 mb-1">{children}</h2>,
                    h3: ({ children }) => <h3 className="text-sm font-bold text-white mt-2 mb-1">{children}</h3>,
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


            {/* Agent */}
            <div className="flex items-center justify-between py-2 border-b border-dark-800">
              <div className="flex items-center gap-2 text-xs text-dark-400">
                <User className="w-3.5 h-3.5" />
                Agent
              </div>
              {editingAgent ? (
                <div className="flex items-center gap-1.5">
                  <select
                    autoFocus
                    defaultValue={task.agentId || ''}
                    onChange={async e => {
                      const targetId = e.target.value;
                      if (!targetId || targetId === task.agentId) { setEditingAgent(false); return; }
                      setTransferring(true);
                      try {
                        await api.transferTodo(task.agentId, task.id, targetId);
                        onRefresh?.();
                        onClose();
                      } finally {
                        setTransferring(false);
                        setEditingAgent(false);
                      }
                    }}
                    disabled={transferring}
                    className="px-2 py-0.5 w-36 bg-dark-800 border border-indigo-500/50 rounded text-xs text-dark-200
                      focus:outline-none focus:border-indigo-500 transition-colors"
                  >
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
                    const ag = agents.find(a => a.id === task.agentId);
                    return ag ? (
                      <span className="text-xs px-2 py-0.5 rounded-full font-medium
                        bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20">
                        {ag.icon} {ag.name}
                      </span>
                    ) : (
                      <span className="text-xs text-dark-500 italic">Unassigned</span>
                    );
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

            {/* Transition history */}
            {(task.history && task.history.length > 0) ? (
              <div className="space-y-0">
                <div className="text-[10px] uppercase tracking-wider text-dark-500 font-semibold mb-1.5">History</div>
                <div className="relative pl-4 border-l border-dark-700 space-y-1.5">
                  {task.history.map((h, i) => (
                    <div key={i} className="relative flex items-start gap-2">
                      <div className="absolute -left-[17px] top-1 w-2 h-2 rounded-full bg-dark-600 ring-2 ring-dark-900" />
                      <div className="flex-1 flex items-center justify-between gap-2 min-w-0">
                        <div className="flex items-center gap-1.5 text-xs min-w-0">
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
                        </div>
                        <span className="text-[10px] text-dark-500 flex-shrink-0" title={formatDate(h.at)}>
                          {timeAgo(h.at)}
                        </span>
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
            {/* Refine with AI */}
            <div className="relative" ref={refineRef}>
              <button
                onClick={() => setRefineOpen(o => !o)}
                disabled={refining}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-amber-400
                  hover:text-amber-300 hover:bg-amber-500/10 border border-amber-500/20 hover:border-amber-500/40
                  rounded-lg transition-colors disabled:opacity-50"
              >
                <Zap className="w-3.5 h-3.5" />
                {refining ? 'Refining...' : 'Refine with AI'}
              </button>
              {refineOpen && (
                <div className="absolute right-0 bottom-9 z-50 bg-dark-800 border border-dark-600
                  rounded-xl shadow-2xl shadow-black/40 py-1 min-w-[180px]">
                  <div className="px-3 py-1.5 text-xs text-dark-400 font-semibold border-b border-dark-700 mb-1">
                    Choose agent
                  </div>
                  {agents.filter(a => a.enabled !== false).map(a => (
                    <button
                      key={a.id}
                      onClick={async () => {
                        setRefineOpen(false);
                        setRefining(true);
                        try {
                          await api.refineTodo(task.agentId, task.id, a.id);
                        } finally {
                          setRefining(false);
                        }
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-dark-200
                        hover:bg-dark-700 hover:text-white transition-colors flex items-center gap-2"
                    >
                      <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                        style={{ background: a.status === 'busy' ? '#f59e0b' : a.status === 'error' ? '#ef4444' : '#22c55e' }} />
                      {a.name}
                      <span className="text-dark-500 ml-auto">{a.model}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
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
  );
}

// ── TaskCard ────────────────────────────────────────────────────────────────

function TaskCard({ task, agents, onDelete, onOpen, showAgent }) {
  const isError = task.status === 'error';
  const isDraggingRef = useRef(false);

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
        {showAgent && task.agentName && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/20">
            <User className="w-2.5 h-2.5" />
            {task.agentName}
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

function KanbanColumn({ col, tasks, agents, onDelete, onDrop, onOpen, onClearAll, showAgent }) {
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
        <div className="flex items-center gap-1.5">
          {onClearAll && tasks.length > 0 && (
            <button
              onClick={onClearAll}
              className="p-1 rounded text-dark-500 hover:text-red-400 hover:bg-dark-700 transition-colors"
              title="Delete all done tasks"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${col.countCls}`}>
            {tasks.length}
          </span>
        </div>
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
            onOpen={onOpen}
            showAgent={showAgent}
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

// ── Available colors for columns ─────────────────────────────────────────────

const AVAILABLE_COLORS = [
  { hex: '#a855f7', label: 'Purple' },
  { hex: '#6b7280', label: 'Gray' },
  { hex: '#3b82f6', label: 'Blue' },
  { hex: '#eab308', label: 'Amber' },
  { hex: '#22c55e', label: 'Green' },
  { hex: '#ef4444', label: 'Red' },
  { hex: '#64748b', label: 'Slate' },
];

// ── Action type helpers ──────────────────────────────────────────────────────

const ACTION_OPTIONS = [
  { value: 'assign_agent', label: 'Assign to agent (by role)' },
  { value: 'run_agent:execute', label: 'Execute task (agent)' },
  { value: 'run_agent:refine', label: 'Refine description (agent)' },
  { value: 'run_agent:decide', label: 'Evaluate / Decide (agent)' },
  { value: 'change_status', label: 'Move to status' },
];

function getActionKey(action) {
  if (action.type === 'run_agent') return `run_agent:${action.mode}`;
  return action.type;
}

function createAction(key, cols) {
  if (key === 'assign_agent') return { type: 'assign_agent', role: '' };
  if (key === 'run_agent:execute') return { type: 'run_agent', mode: 'execute', role: '', instructions: '', targetStatus: cols[cols.length - 1]?.id || '' };
  if (key === 'run_agent:refine') return { type: 'run_agent', mode: 'refine', role: '', instructions: '', targetStatus: cols[1]?.id || '' };
  if (key === 'run_agent:decide') return { type: 'run_agent', mode: 'decide', role: '', instructions: '', targetStatus: cols[1]?.id || '' };
  if (key === 'change_status') return { type: 'change_status', target: cols[1]?.id || '' };
  return { type: 'change_status', target: '' };
}

/** Migrate old transition format (triggerType/to/agent/mode) to new trigger+actions format */
function migrateTransition(t) {
  if (t.actions) return t; // already new format
  const triggerType = t.triggerType || (t.autoRefine ? 'agent' : 'none');
  if (triggerType === 'none') return null; // manual → no transition needed
  const newT = { from: t.from, trigger: triggerType === 'agent' ? 'on_enter' : 'condition', conditions: t.conditions || [], actions: [] };
  if (triggerType === 'agent') {
    newT.actions.push({ type: 'run_agent', mode: t.mode || 'refine', role: t.agent || '', instructions: t.instructions || '', targetStatus: t.to || '' });
  } else {
    newT.actions.push({ type: 'change_status', target: t.to || '' });
  }
  return newT;
}

// ── Condition value widget ───────────────────────────────────────────────────

function ConditionValueWidget({ cond, onChange, agents = [] }) {
  if (cond.field === 'assignee_status') {
    return (
      <select value={cond.value || 'idle'} onChange={e => onChange({ ...cond, value: e.target.value })}
        className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
        <option value="idle">idle</option>
        <option value="busy">busy</option>
        <option value="error">error</option>
      </select>
    );
  }
  if (cond.field === 'idle_agent_available') {
    const roles = [...new Set(agents.map(a => a.role).filter(Boolean))];
    return (
      <select value={cond.value || roles[0] || ''} onChange={e => onChange({ ...cond, value: e.target.value })}
        className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
        {roles.map(r => <option key={r} value={r}>{r}</option>)}
        {roles.length === 0 && <option value="">no roles</option>}
      </select>
    );
  }
  if (cond.field === 'assignee_enabled' || cond.field === 'task_has_assignee') {
    return (
      <select value={cond.value || 'true'} onChange={e => onChange({ ...cond, value: e.target.value })}
        className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }
  if (cond.field === 'assignee_role') {
    const roles = [...new Set(agents.map(a => a.role).filter(Boolean))];
    return (
      <select value={cond.value || roles[0] || ''} onChange={e => onChange({ ...cond, value: e.target.value })}
        className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
        {roles.map(r => <option key={r} value={r}>{r}</option>)}
        {roles.length === 0 && <option value="">no roles</option>}
      </select>
    );
  }
  return (
    <input value={cond.value || ''} onChange={e => onChange({ ...cond, value: e.target.value })}
      placeholder="value..." className="flex-1 px-1.5 py-0.5 bg-dark-900 border border-dark-600 rounded text-[10px] text-dark-200 placeholder-dark-500" />
  );
}

// ── WorkflowEditor ──────────────────────────────────────────────────────────

function WorkflowEditor({ workflow, agents, onClose, onSave }) {
  const [cols, setCols] = useState(() => JSON.parse(JSON.stringify(workflow.columns)));
  const [transitions, setTransitions] = useState(() => {
    const raw = JSON.parse(JSON.stringify(workflow.transitions));
    return raw.map(migrateTransition).filter(Boolean);
  });
  const [saving, setSaving] = useState(false);

  const enabledAgents = agents.filter(a => a.enabled !== false);
  const availableRoles = [...new Set(enabledAgents.map(a => a.role).filter(Boolean))].sort();

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({ columns: cols, transitions, version: workflow.version });
      onClose();
    } finally {
      setSaving(false);
    }
  };

  // ── Column helpers ──
  const updateCol = (idx, patch) => setCols(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  const removeCol = (idx) => {
    const removed = cols[idx];
    setCols(prev => prev.filter((_, i) => i !== idx));
    setTransitions(prev => prev.filter(t => t.from !== removed.id));
  };
  const addCol = () => {
    const id = `step_${Date.now()}`;
    setCols(prev => [...prev, { id, label: 'New Step', color: '#6b7280' }]);
  };

  // ── Transition helpers ──
  const updateTransition = (idx, patch) => setTransitions(prev => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
  const removeTransition = (idx) => setTransitions(prev => prev.filter((_, i) => i !== idx));
  const addTransition = () => {
    setTransitions(prev => [...prev, {
      from: cols[0]?.id || '',
      trigger: 'on_enter',
      conditions: [],
      actions: [{ type: 'change_status', target: cols[1]?.id || '' }],
    }]);
  };

  // ── Action helpers ──
  const updateAction = (tIdx, aIdx, patch) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      const newActions = t.actions.map((a, j) => j === aIdx ? { ...a, ...patch } : a);
      return { ...t, actions: newActions };
    }));
  };
  const removeAction = (tIdx, aIdx) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      return { ...t, actions: t.actions.filter((_, j) => j !== aIdx) };
    }));
  };
  const addAction = (tIdx) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      return { ...t, actions: [...t.actions, createAction('change_status', cols)] };
    }));
  };
  const changeActionType = (tIdx, aIdx, newKey) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      const newActions = [...t.actions];
      newActions[aIdx] = createAction(newKey, cols);
      return { ...t, actions: newActions };
    }));
  };

  // ── Condition helpers ──
  const updateCondition = (tIdx, cIdx, cond) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      const newConds = t.conditions.map((c, j) => j === cIdx ? cond : c);
      return { ...t, conditions: newConds };
    }));
  };
  const removeCondition = (tIdx, cIdx) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      return { ...t, conditions: t.conditions.filter((_, j) => j !== cIdx) };
    }));
  };
  const addCondition = (tIdx) => {
    setTransitions(prev => prev.map((t, i) => {
      if (i !== tIdx) return t;
      return { ...t, conditions: [...t.conditions, { field: 'idle_agent_available', operator: 'eq', value: '' }] };
    }));
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-2xl max-h-[85vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Settings className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-dark-100">Workflow Configuration</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4 space-y-6">
          {/* ── Columns ── */}
          <section>
            <h3 className="text-xs font-semibold text-dark-300 uppercase tracking-wider mb-3">Columns</h3>
            <div className="space-y-2">
              {cols.map((col, idx) => (
                <div key={col.id} className="flex items-center gap-2 bg-dark-800 rounded-lg px-3 py-2">
                  <select
                    value={col.color}
                    onChange={e => updateCol(idx, { color: e.target.value })}
                    className="w-8 h-6 bg-dark-700 border-0 rounded cursor-pointer text-xs"
                    style={{ color: col.color }}
                  >
                    {AVAILABLE_COLORS.map(c => (
                      <option key={c.hex} value={c.hex} style={{ color: c.hex }}>{c.label}</option>
                    ))}
                  </select>
                  <input
                    value={col.label}
                    onChange={e => updateCol(idx, { label: e.target.value })}
                    className="flex-1 bg-transparent text-sm text-dark-200 outline-none"
                    placeholder="Column name"
                  />
                  <span className="text-[10px] text-dark-500 font-mono">{col.id}</span>
                  <label className="flex items-center gap-1 text-[10px] text-dark-400 cursor-pointer" title="Show assigned agent on task cards">
                    <input
                      type="checkbox"
                      checked={col.showAgent || false}
                      onChange={e => updateCol(idx, { showAgent: e.target.checked })}
                      className="rounded border-dark-600 bg-dark-700 text-indigo-500 focus:ring-indigo-500/30 w-3 h-3"
                    />
                    <User className="w-3 h-3" />
                  </label>
                  <select
                    value={col.autoAssignRole || ''}
                    onChange={e => updateCol(idx, { autoAssignRole: e.target.value || null })}
                    className="bg-dark-700 border border-dark-600 rounded px-1.5 py-0.5 text-[10px] text-dark-300"
                    title="Auto-assign tasks in this column to an agent with this role"
                  >
                    <option value="">No auto-assign</option>
                    {availableRoles.map(r => (
                      <option key={r} value={r}>Auto: {r}</option>
                    ))}
                  </select>
                  <button
                    onClick={() => removeCol(idx)}
                    className="p-1 text-dark-500 hover:text-red-400 transition-colors"
                    title="Remove column"
                  >
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
            <button
              onClick={addCol}
              className="mt-2 flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
            >
              <Plus className="w-3 h-3" /> Add column
            </button>
          </section>

          {/* ── Transitions ── */}
          <section>
            <h3 className="text-xs font-semibold text-dark-300 uppercase tracking-wider mb-3">Transitions</h3>
            <div className="space-y-3">
              {transitions.map((t, idx) => (
                <div key={idx} className="bg-dark-800 rounded-lg px-3 py-3 space-y-3">
                  {/* From column + delete */}
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-dark-500 w-10">From:</span>
                    <select value={t.from} onChange={e => updateTransition(idx, { from: e.target.value })}
                      className="px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs text-dark-200">
                      {cols.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                    </select>
                    <button onClick={() => removeTransition(idx)}
                      className="ml-auto p-1 text-dark-500 hover:text-red-400 transition-colors" title="Remove transition">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>

                  {/* Trigger */}
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <Zap className="w-3 h-3 text-amber-400" />
                      <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">Trigger</span>
                    </div>
                    <select value={t.trigger || 'on_enter'}
                      onChange={e => updateTransition(idx, { trigger: e.target.value })}
                      className="w-full px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs text-dark-200">
                      <option value="on_enter">On enter — fires immediately when a task enters this column</option>
                      <option value="condition">When conditions met — fires when all conditions become true (checked periodically)</option>
                    </select>
                    {t.trigger === 'condition' && (
                      <div className="mt-2 space-y-1.5 pl-3 border-l-2 border-amber-500/30">
                        <div className="text-[10px] text-dark-400">All conditions must be true:</div>
                        {(t.conditions || []).map((cond, ci) => (
                          <div key={ci} className="flex items-center gap-1.5">
                            <select value={cond.field || 'assignee_status'}
                              onChange={e => updateCondition(idx, ci, { ...cond, field: e.target.value })}
                              className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                              <option value="assignee_status">Assigned agent status</option>
                              <option value="assignee_enabled">Assigned agent enabled</option>
                              <option value="assignee_role">Assigned agent role</option>
                              <option value="task_has_assignee">Task has assignee</option>
                              <option value="idle_agent_available">Idle agent available (by role)</option>
                            </select>
                            {cond.field === 'idle_agent_available' ? (
                              <span className="text-[10px] text-dark-400">with role</span>
                            ) : (
                              <select value={cond.operator || 'eq'}
                                onChange={e => updateCondition(idx, ci, { ...cond, operator: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="eq">is</option>
                                <option value="neq">is not</option>
                              </select>
                            )}
                            <ConditionValueWidget cond={cond} onChange={c => updateCondition(idx, ci, c)} agents={agents} />
                            <button onClick={() => removeCondition(idx, ci)}
                              className="p-0.5 text-dark-500 hover:text-red-400">
                              <Trash2 className="w-2.5 h-2.5" />
                            </button>
                          </div>
                        ))}
                        <button onClick={() => addCondition(idx)}
                          className="text-[10px] text-amber-400 hover:text-amber-300">
                          <Plus className="w-2.5 h-2.5 inline mr-0.5" />Add condition
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div>
                    <div className="flex items-center gap-2 mb-1.5">
                      <ArrowRight className="w-3 h-3 text-indigo-400" />
                      <span className="text-[10px] font-semibold text-indigo-400 uppercase tracking-wider">Then</span>
                    </div>
                    <div className="space-y-2 pl-3 border-l-2 border-indigo-500/30">
                      {(t.actions || []).map((action, ai) => (
                        <div key={ai} className="space-y-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-dark-500 w-3">{ai + 1}.</span>
                            <select value={getActionKey(action)}
                              onChange={e => changeActionType(idx, ai, e.target.value)}
                              className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                              {ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                            </select>

                            {/* Role selector for assign_agent and run_agent */}
                            {(action.type === 'assign_agent' || action.type === 'run_agent') && (
                              <select value={action.role || ''}
                                onChange={e => updateAction(idx, ai, { role: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">Role...</option>
                                {availableRoles.map(r => <option key={r} value={r}>{r}</option>)}
                              </select>
                            )}

                            {/* Target status for run_agent */}
                            {action.type === 'run_agent' && (
                              <>
                                <ArrowRight className="w-2.5 h-2.5 text-dark-500 flex-shrink-0" />
                                <select value={action.targetStatus || ''}
                                  onChange={e => updateAction(idx, ai, { targetStatus: e.target.value })}
                                  className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                  <option value="">Then move to...</option>
                                  {cols.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                                </select>
                              </>
                            )}

                            {/* Target status for change_status */}
                            {action.type === 'change_status' && (
                              <select value={action.target || ''}
                                onChange={e => updateAction(idx, ai, { target: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">Select status...</option>
                                {cols.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                              </select>
                            )}

                            <button onClick={() => removeAction(idx, ai)}
                              className="ml-auto p-0.5 text-dark-500 hover:text-red-400">
                              <Trash2 className="w-2.5 h-2.5" />
                            </button>
                          </div>

                          {/* Instructions for agent actions */}
                          {action.type === 'run_agent' && (
                            <textarea value={action.instructions || ''}
                              onChange={e => updateAction(idx, ai, { instructions: e.target.value })}
                              placeholder={action.mode === 'decide'
                                ? "Decision criteria... (e.g., 'Approve if task has acceptance criteria and clear scope')"
                                : action.mode === 'refine'
                                ? "Refinement instructions... (e.g., 'Add acceptance criteria and break into sub-tasks')"
                                : "Extra instructions (optional)... (e.g., 'Focus on unit tests')"}
                              className="w-full ml-4 bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-xs text-dark-200 placeholder-dark-500 resize-none h-14"
                              style={{ width: 'calc(100% - 1rem)' }}
                            />
                          )}
                        </div>
                      ))}
                      <button onClick={() => addAction(idx)}
                        className="text-[10px] text-indigo-400 hover:text-indigo-300">
                        <Plus className="w-2.5 h-2.5 inline mr-0.5" />Add action
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button onClick={addTransition}
              className="mt-2 flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              <Plus className="w-3 h-3" /> Add transition
            </button>
          </section>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-5 py-3 border-t border-dark-700">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-xs text-dark-300 hover:text-dark-100 bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-colors disabled:opacity-50"
          >
            <Save className="w-3 h-3" />
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
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
  const [showWorkflowEditor, setShowWorkflowEditor] = useState(false);

  // Workflow config (columns + transitions from DB)
  const [workflow, setWorkflow] = useState(null);

  useEffect(() => {
    api.getWorkflow().then(setWorkflow).catch(() => {});
  }, []);

  const columns = useMemo(() => workflow ? buildColumns(workflow.columns) : [], [workflow]);
  const statusOptions = useMemo(() => workflow ? buildStatusOptions(workflow.columns) : [], [workflow]);

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
    columns.forEach(col => {
      groups[col.id] = filteredTasks.filter(t => col.statuses.includes(t.status || 'pending'));
    });
    return groups;
  }, [filteredTasks, columns]);

  const handleDelete = useCallback(async (task) => {
    await api.deleteTodo(task.agentId, task.id);
    onRefresh();
  }, [onRefresh]);

  const handleClearDone = useCallback(async () => {
    const doneTasks = allTasks.filter(t => t.status === 'done');
    await Promise.all(doneTasks.map(t => api.deleteTodo(t.agentId, t.id)));
    onRefresh();
  }, [allTasks, onRefresh]);

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

        {/* Workflow settings */}
        <button
          onClick={() => setShowWorkflowEditor(true)}
          className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors"
          title="Workflow settings"
        >
          <Settings className="w-3.5 h-3.5" />
        </button>

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
          {columns.map(col => (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={tasksByColumn[col.id] || []}
              agents={agents}
              onDelete={handleDelete}
              onDrop={handleDrop}
              onOpen={setSelectedTask}
              onClearAll={col.id === 'done' ? handleClearDone : undefined}
              showAgent={col.showAgent}
            />
          ))}
        </div>
      </div>

      {/* Task detail modal */}
      {liveSelectedTask && (
        <TaskDetailModal
          task={liveSelectedTask}
          agents={agents}
          allProjects={allProjects}
          statusOptions={statusOptions}
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
          statusOptions={statusOptions}
          onClose={() => setCreateOpen(false)}
          onCreated={onRefresh}
        />
      )}

      {/* Workflow editor modal */}
      {showWorkflowEditor && workflow && (
        <WorkflowEditor
          workflow={workflow}
          agents={agents}
          onClose={() => setShowWorkflowEditor(false)}
          onSave={async (updated) => {
            const saved = await api.updateWorkflow(updated);
            setWorkflow(saved);
          }}
        />
      )}
    </div>
  );
}
// Ideas column v1.0.216
