import { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import {
  Search, Trash2, Clock, X, AlertTriangle,
  Edit3, Save, Check, Tag, Calendar, ChevronDown, ChevronRight, Plus, Settings,
  ArrowRight, Zap, User, GitCommit, KanbanSquare, Repeat, MessageSquare, FolderKanban, Code, Loader2, Square,
  Bug, Sparkles, Wrench, BookOpen, ArrowUpCircle, HelpCircle, Layers,
  ArrowUpDown, Flag, Sun
} from 'lucide-react';
import { api } from '../api';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import AllCommitsDiffModal from './AllCommitsDiffModal';
import { useTheme } from '../contexts/ThemeContext';

// ── Color mapping (hex → Tailwind classes) ──────────────────────────────────

const COLOR_MAP = {
  '#a855f7': { dot: 'bg-purple-500',  headerText: 'text-purple-300', headerTextLight: 'text-purple-900', countCls: 'bg-purple-500/20 text-purple-300', countClsLight: 'bg-purple-500/20 text-purple-900', dropRing: 'ring-purple-500/40 bg-purple-500/5', headerActive: 'border-purple-500/60', statusDot: 'bg-purple-400', statusText: 'text-purple-300' },
  '#6b7280': { dot: 'bg-gray-500',    headerText: 'text-gray-300',   headerTextLight: 'text-gray-900',   countCls: 'bg-gray-500/20 text-gray-300',     countClsLight: 'bg-gray-500/20 text-gray-900',     dropRing: 'ring-gray-500/40 bg-gray-500/5',     headerActive: 'border-gray-500/60',   statusDot: 'bg-gray-400',   statusText: 'text-gray-300' },
  '#3b82f6': { dot: 'bg-blue-500',    headerText: 'text-blue-300',   headerTextLight: 'text-blue-900',   countCls: 'bg-blue-500/20 text-blue-300',     countClsLight: 'bg-blue-500/20 text-blue-900',     dropRing: 'ring-blue-500/40 bg-blue-500/5',     headerActive: 'border-blue-500/60',   statusDot: 'bg-blue-400',   statusText: 'text-blue-300' },
  '#eab308': { dot: 'bg-amber-400',   headerText: 'text-amber-300',  headerTextLight: 'text-amber-900',  countCls: 'bg-amber-500/20 text-amber-300',   countClsLight: 'bg-amber-500/20 text-amber-900',   dropRing: 'ring-amber-500/40 bg-amber-500/5',   headerActive: 'border-amber-400/60',  statusDot: 'bg-amber-400',  statusText: 'text-amber-300' },
  '#22c55e': { dot: 'bg-emerald-400', headerText: 'text-emerald-300',headerTextLight: 'text-emerald-900',countCls: 'bg-emerald-500/20 text-emerald-300',countClsLight: 'bg-emerald-500/20 text-emerald-900',dropRing: 'ring-emerald-500/40 bg-emerald-500/5',headerActive: 'border-emerald-400/60', statusDot: 'bg-emerald-400',statusText: 'text-emerald-300' },
  '#ef4444': { dot: 'bg-red-400',     headerText: 'text-red-300',    headerTextLight: 'text-red-900',    countCls: 'bg-red-500/20 text-red-300',       countClsLight: 'bg-red-500/20 text-red-900',       dropRing: 'ring-red-500/40 bg-red-500/5',       headerActive: 'border-red-400/60',    statusDot: 'bg-red-400',    statusText: 'text-red-300' },
  '#64748b': { dot: 'bg-slate-500',   headerText: 'text-dark-300',   headerTextLight: 'text-slate-900',  countCls: 'bg-dark-700 text-dark-400',        countClsLight: 'bg-slate-500/20 text-slate-900',   dropRing: 'ring-slate-500/40 bg-slate-500/5',   headerActive: 'border-slate-500/60',  statusDot: 'bg-slate-400',  statusText: 'text-slate-300' },
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
      headerTextLight: c.headerTextLight,
      countCls: c.countCls,
      countClsLight: c.countClsLight,
      dropRing: c.dropRing,
      headerActive: c.headerActive,
      showAgent: col.showAgent || false,
      showCreator: col.showCreator || false,
      showProject: col.showProject || false,
      showTaskType: col.showTaskType || false,
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
  user:       { label: () => 'User',              cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20' },
  agent:      { label: (s) => s.name || 'Agent',  cls: 'text-purple-400 bg-purple-500/10 ring-purple-500/20' },
  api:        { label: () => 'API',               cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20' },
  mcp:        { label: () => 'MCP',               cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20' },
  recurrence: { label: () => 'Recurring',          cls: 'text-teal-400 bg-teal-500/10 ring-teal-500/20' },
};

// ── Task type definitions ────────────────────────────────────────────────────

const TASK_TYPES = [
  { value: 'bug',           label: 'Bug',           icon: Bug,            cls: 'text-red-400 bg-red-500/10 ring-red-500/20' },
  { value: 'feature',       label: 'Feature',       icon: Sparkles,       cls: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' },
  { value: 'technical',     label: 'Technical',     icon: Wrench,         cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20' },
  { value: 'improvement',   label: 'Improvement',   icon: ArrowUpCircle,  cls: 'text-violet-400 bg-violet-500/10 ring-violet-500/20' },
  { value: 'documentation', label: 'Documentation', icon: BookOpen,       cls: 'text-amber-400 bg-amber-500/10 ring-amber-500/20' },
  { value: 'other',         label: 'Other',         icon: HelpCircle,     cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20' },
];

const TASK_TYPE_MAP = Object.fromEntries(TASK_TYPES.map(t => [t.value, t]));

// ── Priority definitions ──────────────────────────────────────────────────────

const PRIORITIES = [
  { value: 'critical', label: 'Critique',  sortOrder: 0, cls: 'text-red-400 bg-red-500/10 ring-red-500/20',    dotCls: 'bg-red-400' },
  { value: 'high',     label: 'Haute',     sortOrder: 1, cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20', dotCls: 'bg-orange-400' },
  { value: 'medium',   label: 'Moyenne',   sortOrder: 2, cls: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',   dotCls: 'bg-amber-400' },
  { value: 'low',      label: 'Basse',     sortOrder: 3, cls: 'text-sky-400 bg-sky-500/10 ring-sky-500/20',      dotCls: 'bg-sky-400' },
];

const PRIORITY_MAP = Object.fromEntries(PRIORITIES.map(p => [p.value, p]));

// ── Sort helpers ─────────────────────────────────────────────────────────────

function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

const SORT_OPTIONS = [
  { value: 'date_desc',     label: 'Date (recent)' },
  { value: 'date_asc',      label: 'Date (oldest)' },
  { value: 'priority_asc',  label: 'Priority (high first)' },
  { value: 'priority_desc', label: 'Priority (low first)' },
];

function sortTasks(tasks, sortBy) {
  const sorted = [...tasks];
  switch (sortBy) {
    case 'date_asc':
      return sorted.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    case 'date_desc':
      return sorted.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    case 'priority_asc': {
      const order = (t) => PRIORITY_MAP[t.priority]?.sortOrder ?? 99;
      return sorted.sort((a, b) => order(a) - order(b));
    }
    case 'priority_desc': {
      const order = (t) => PRIORITY_MAP[t.priority]?.sortOrder ?? -1;
      return sorted.sort((a, b) => order(b) - order(a));
    }
    default:
      return sorted;
  }
}

// ── CreateTaskModal ──────────────────────────────────────────────────────────

function CreateTaskModal({ agents, allProjects, onClose, onCreated, statusOptions, defaultStatus, boardId }) {
  // Allow all columns as creation statuses (don't exclude the last one —
  // custom columns added after "Done" would be wrongly hidden by slice(0, -1))
  const CREATE_STATUSES = statusOptions;
  const initialStatus = defaultStatus && CREATE_STATUSES.some(s => s.value === defaultStatus)
    ? defaultStatus
    : (CREATE_STATUSES[0]?.value || 'backlog');
  const [text, setText] = useState('');
  const [project, setProject] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [taskType, setTaskType] = useState('');
  const [recurring, setRecurring] = useState(false);
  const [recurrencePeriod, setRecurrencePeriod] = useState('daily');
  const [customInterval, setCustomInterval] = useState(60);
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

  const RECURRENCE_PERIODS = [
    { value: 'hourly', label: 'Every hour', minutes: 60 },
    { value: 'daily', label: 'Every day', minutes: 1440 },
    { value: 'weekly', label: 'Every week', minutes: 10080 },
    { value: 'monthly', label: 'Every month', minutes: 43200 },
    { value: 'custom', label: 'Custom interval', minutes: null },
  ];

  const handleSubmit = async (e) => {
    e.preventDefault();
    const trimmed = text.trim();
    if (!trimmed || !defaultAgentId) return;
    setSaving(true);
    try {
      const recurrence = recurring ? {
        enabled: true,
        period: recurrencePeriod,
        intervalMinutes: recurrencePeriod === 'custom'
          ? customInterval
          : RECURRENCE_PERIODS.find(p => p.value === recurrencePeriod)?.minutes || 1440,
      } : undefined;
      await api.addTask(defaultAgentId, trimmed, project.trim() || undefined, status, boardId, recurrence, taskType || undefined);
      await onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const currentStatus = CREATE_STATUSES.find(s => s.value === status);

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
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
                {CREATE_STATUSES.map(opt => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div className="w-36">
              <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
                <Layers className="inline w-3 h-3 mr-1" />Type
              </label>
              <select
                value={taskType}
                onChange={e => setTaskType(e.target.value)}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              >
                <option value="">None</option>
                {TASK_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Recurrence */}
          <div className="border border-dark-700 rounded-lg p-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={recurring}
                onChange={e => setRecurring(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-800 text-indigo-500 focus:ring-indigo-500 focus:ring-offset-0"
              />
              <Repeat className="w-3.5 h-3.5 text-dark-400" />
              <span className="text-xs font-semibold text-dark-300 uppercase tracking-wide">Recurring task</span>
            </label>
            {recurring && (
              <div className="mt-3 flex gap-3 items-end">
                <div className="flex-1">
                  <label className="block text-xs text-dark-400 mb-1">Period</label>
                  <select
                    value={recurrencePeriod}
                    onChange={e => setRecurrencePeriod(e.target.value)}
                    className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    {RECURRENCE_PERIODS.map(p => (
                      <option key={p.value} value={p.value}>{p.label}</option>
                    ))}
                  </select>
                </div>
                {recurrencePeriod === 'custom' && (
                  <div className="w-32">
                    <label className="block text-xs text-dark-400 mb-1">Minutes</label>
                    <input
                      type="number"
                      min={1}
                      value={customInterval}
                      onChange={e => setCustomInterval(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                  </div>
                )}
              </div>
            )}
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

// ── ExecutionLogEntry ────────────────────────────────────────────────────────

function ExecutionLogEntry({ entry, index }) {
  const [expanded, setExpanded] = useState(false);
  const messages = entry.messages || [];
  const duration = entry.startedAt && entry.at
    ? Math.round((new Date(entry.at) - new Date(entry.startedAt)) / 1000)
    : null;
  const durationLabel = duration != null
    ? duration < 60 ? `${duration}s` : `${Math.floor(duration / 60)}m${duration % 60}s`
    : null;

  const MODE_LABELS = { execute: 'Execution', refine: 'Refine', decide: 'Decide', title: 'Title', set_type: 'Set Type' };
  const MODE_COLORS = { execute: 'text-blue-300', refine: 'text-violet-300', decide: 'text-amber-300', title: 'text-teal-300', set_type: 'text-pink-300' };
  const MODE_ICON_COLORS = { execute: 'text-blue-400', refine: 'text-violet-400', decide: 'text-amber-400', title: 'text-teal-400', set_type: 'text-pink-400' };
  const modeKey = entry.mode || 'execute';
  const modeLabel = MODE_LABELS[modeKey] || 'Execution';

  return (
    <div className="flex-1 min-w-0">
      <button
        onClick={(e) => { e.stopPropagation(); setExpanded(o => !o); }}
        className="flex items-center gap-1.5 text-xs group/exec hover:opacity-80 transition-opacity w-full"
      >
        <MessageSquare className={`w-2.5 h-2.5 ${MODE_ICON_COLORS[modeKey] || 'text-blue-400'} flex-shrink-0`} />
        <span className={`font-medium ${entry.success ? (MODE_COLORS[modeKey] || 'text-blue-300') : 'text-red-300'}`}>
          {modeLabel} {entry.success ? '✓' : '✗'}
        </span>
        <span className="text-dark-500 truncate">by {entry.by}</span>
        {durationLabel && (
          <span className="text-[10px] text-dark-500 font-mono">({durationLabel})</span>
        )}
        {messages.length > 0 && (
          <span className="text-[10px] text-dark-500">
            — {messages.length} msg{messages.length > 1 ? 's' : ''}
          </span>
        )}
        {expanded
          ? <ChevronDown className="w-3 h-3 text-dark-500 flex-shrink-0 ml-auto" />
          : <ChevronRight className="w-3 h-3 text-dark-500 flex-shrink-0 ml-auto" />
        }
      </button>
      {expanded && messages.length > 0 && (
        <div className="mt-2 space-y-2 max-h-80 overflow-y-auto scrollbar-thin-dark">
          {messages.map((m, mi) => (
            <div key={mi} className={`rounded-lg p-2.5 text-xs leading-relaxed ${
              m.role === 'user'
                ? 'bg-blue-500/10 border border-blue-500/20'
                : 'bg-dark-700/60 border border-dark-600/50'
            }`}>
              <div className="flex items-center justify-between mb-1">
                <span className={`text-[10px] font-semibold uppercase tracking-wider ${
                  m.role === 'user' ? 'text-blue-400' : 'text-emerald-400'
                }`}>
                  {m.role === 'user' ? '→ Prompt' : '← Agent'}
                </span>
                {m.timestamp && (
                  <span className="text-[10px] text-dark-500">
                    {new Date(m.timestamp).toLocaleTimeString()}
                  </span>
                )}
              </div>
              <pre className="whitespace-pre-wrap break-words text-dark-300 font-sans">
                {m.content}
              </pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── TaskDetailModal ──────────────────────────────────────────────────────────

function TaskDetailModal({ task, agents, allProjects, onClose, onRefresh, onDelete, statusOptions }) {
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
                onClick={() => setStatusOpen(o => !o)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold
                  border transition-colors hover:opacity-80
                  ${isError
                    ? 'bg-red-500/15 text-red-300 border-red-500/30'
                    : task.status === lastStatusId
                      ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
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
                  onClick={() => { setEditText(task.text); setEditTitle(task.title || ''); setEditing(true); }}
                  className="flex items-center gap-1 text-xs text-dark-500 hover:text-indigo-400 transition-colors"
                >
                  <Edit3 className="w-3 h-3" />
                  Edit
                </button>
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
                        <span className="text-xs px-2 py-0.5 rounded-full font-medium
                          bg-blue-500/10 text-blue-400 ring-1 ring-blue-500/20">
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
            {/* Refine with AI */}
            <div className="relative" ref={refineRef}>
              <button
                onClick={() => setRefineOpen(o => !o)}
                disabled={refining}
                className={`flex items-center gap-1.5 px-3 py-1.5 text-xs
                  border rounded-lg transition-colors disabled:opacity-50
                  ${refining
                    ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
                    : 'text-amber-400 hover:text-amber-300 hover:bg-amber-500/10 border-amber-500/20 hover:border-amber-500/40'
                  }`}
              >
                {refining
                  ? <><svg className="w-3.5 h-3.5 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M21 12a9 9 0 11-6.219-8.56" strokeLinecap="round" />
                    </svg>Refining...</>
                  : <><Zap className="w-3.5 h-3.5" />Refine with AI</>
                }
              </button>
              {refineOpen && !refining && (
                <div className="absolute right-0 bottom-9 z-50 bg-dark-800 border border-dark-600
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
      />
    )}
    </>
  );
}

// ── TaskCard ────────────────────────────────────────────────────────────────

function TaskCard({ task, agents, onDelete, onStop, onOpen, showAgent, showCreator, showProject, showTaskType, onTouchDragStart }) {
  const isError = task.status === 'error';
  const today = isToday(task.createdAt);
  const isDraggingRef = useRef(false);
  const touchDragRef = useRef(null);
  const cardRef = useRef(null);

  const sourceMeta = task.source ? (SOURCE_META[task.source.type] || SOURCE_META.api) : null;

  // Attach non-passive touchmove listener so preventDefault() works on mobile
  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;

    const handleTouchMove = (e) => {
      if (!touchDragRef.current) return;
      const touch = e.touches[0];
      const dx = touch.clientX - touchDragRef.current.startX;
      const dy = touch.clientY - touchDragRef.current.startY;

      if (!touchDragRef.current.started) {
        if (Math.abs(dx) < 20 && Math.abs(dy) < 20) return;
        touchDragRef.current.started = true;
        isDraggingRef.current = true;

        // Create ghost element
        const ghost = el.cloneNode(true);
        ghost.style.position = 'fixed';
        ghost.style.zIndex = '9999';
        ghost.style.pointerEvents = 'none';
        ghost.style.opacity = '0.85';
        ghost.style.width = el.offsetWidth + 'px';
        ghost.style.transform = 'rotate(2deg) scale(1.02)';
        ghost.style.boxShadow = '0 8px 32px rgba(0,0,0,0.4)';
        document.body.appendChild(ghost);
        touchDragRef.current.ghost = ghost;

        // Dim the original card
        el.style.opacity = '0.4';
      }

      e.preventDefault(); // Prevent scrolling while dragging

      // Move ghost
      if (touchDragRef.current.ghost) {
        touchDragRef.current.ghost.style.left = (touch.clientX - el.offsetWidth / 2) + 'px';
        touchDragRef.current.ghost.style.top = (touch.clientY - 30) + 'px';
      }

      // Highlight the column under the touch point
      const elemUnder = document.elementFromPoint(touch.clientX, touch.clientY);
      const colUnder = elemUnder?.closest?.('[data-column-id]');
      document.querySelectorAll('[data-column-id]').forEach(colEl => {
        colEl.classList.remove('touch-drag-over');
      });
      if (colUnder) {
        colUnder.classList.add('touch-drag-over');
      }
    };

    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', handleTouchMove);
  }, []);

  return (
    <div
      ref={cardRef}
      draggable
      onDragStart={(e) => {
        isDraggingRef.current = true;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/json', JSON.stringify({ agentId: task.agentId, taskId: task.id }));
        setTimeout(() => e.target.classList.add('opacity-40'), 0);
      }}
      onDragEnd={(e) => {
        e.target.classList.remove('opacity-40');
        // Reset after a tick so click doesn't fire after drop
        setTimeout(() => { isDraggingRef.current = false; }, 50);
      }}
      onTouchStart={(e) => {
        const touch = e.touches[0];
        touchDragRef.current = {
          startX: touch.clientX,
          startY: touch.clientY,
          started: false,
          ghost: null,
        };
      }}
      onTouchEnd={(e) => {
        if (!touchDragRef.current) return;

        // Restore original card opacity
        if (cardRef.current) cardRef.current.style.opacity = '';

        if (touchDragRef.current.started) {
          // Remove ghost
          if (touchDragRef.current.ghost) {
            touchDragRef.current.ghost.remove();
          }

          // Clear all highlights
          document.querySelectorAll('[data-column-id]').forEach(el => {
            el.classList.remove('touch-drag-over');
          });

          // Find drop target
          const touch = e.changedTouches[0];
          const elemUnder = document.elementFromPoint(touch.clientX, touch.clientY);
          const colUnder = elemUnder?.closest?.('[data-column-id]');
          if (colUnder) {
            const colId = colUnder.getAttribute('data-column-id');
            // Dispatch a custom event that the board listens to
            const dropEvent = new CustomEvent('touch-task-drop', {
              bubbles: true,
              detail: { agentId: task.agentId, taskId: task.id, targetColumnId: colId }
            });
            colUnder.dispatchEvent(dropEvent);
          }

          // Prevent click after drag
          setTimeout(() => { isDraggingRef.current = false; }, 50);
        } else {
          isDraggingRef.current = false;
        }

        touchDragRef.current = null;
      }}
      onClick={() => { if (!isDraggingRef.current) onOpen(task); }}
      className={`group/card bg-dark-800 rounded-lg border p-3 cursor-pointer
        transition-all hover:shadow-lg hover:shadow-black/20
        ${isError
          ? 'border-red-500/40 bg-red-500/5 hover:border-red-500/60'
          : today
            ? 'border-amber-500/40 bg-amber-500/5 hover:border-amber-500/60 ring-1 ring-amber-500/20'
            : 'border-dark-700 hover:border-dark-500'
        }`}
    >
      {/* Task text */}
      <p className={`text-sm leading-snug mb-2.5 ${isError ? 'text-red-300' : 'text-dark-200'}`}
        style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
        {task.title || task.text}
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
        {task.priority && PRIORITY_MAP[task.priority] && (
          <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${PRIORITY_MAP[task.priority].cls}`}>
            <Flag className="w-2.5 h-2.5" />
            {PRIORITY_MAP[task.priority].label}
          </span>
        )}
        {showProject && task.project && (
          <span className="text-xs px-1.5 py-0.5 rounded font-medium bg-violet-500/10 text-violet-400 ring-1 ring-violet-500/20">
            {task.project}
          </span>
        )}
        {showTaskType && task.taskType && TASK_TYPE_MAP[task.taskType] && (() => {
          const tt = TASK_TYPE_MAP[task.taskType];
          const Icon = tt.icon;
          return (
            <span className={`flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${tt.cls}`}>
              <Icon className="w-2.5 h-2.5" />
              {tt.label}
            </span>
          );
        })()}
        {showCreator && sourceMeta && (
          <span className={`text-xs px-1.5 py-0.5 rounded font-medium ring-1 ${sourceMeta.cls}`}>
            {sourceMeta.label(task.source)}
          </span>
        )}
        {showAgent && task.assigneeName && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-cyan-500/10 text-cyan-400 ring-1 ring-cyan-500/20">
            <User className="w-2.5 h-2.5" />
            {`${task.assigneeIcon || ''} ${task.assigneeName}`.trim()}
          </span>
        )}
        {task.commits && task.commits.length > 0 && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20">
            <GitCommit className="w-2.5 h-2.5" />
            {task.commits.length}
          </span>
        )}
        {task.recurrence?.enabled && (
          <span className="flex items-center gap-1 text-xs px-1.5 py-0.5 rounded font-medium bg-teal-500/10 text-teal-400 ring-1 ring-teal-500/20">
            <Repeat className="w-2.5 h-2.5" />
            {task.recurrence.period === 'custom' ? `${task.recurrence.intervalMinutes}m` : task.recurrence.period}
          </span>
        )}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1 text-xs text-dark-500">
          <Clock className="w-3 h-3" />
          {timeAgo(task.createdAt)}
          {today && (
            <span className="flex items-center gap-0.5 ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/25">
              <Sun className="w-2.5 h-2.5" />
              Today
            </span>
          )}
        </span>
        <div className="flex items-center gap-1">
          {task.actionRunning && (
            <Loader2 className="w-3.5 h-3.5 text-cyan-400 animate-spin" />
          )}
          <div className="flex items-center gap-0.5 opacity-0 group-hover/card:opacity-100 transition-opacity">
            {task.actionRunning ? (
              <button
                onClick={(e) => { e.stopPropagation(); onStop(task); }}
                className="p-1.5 rounded text-red-400 hover:text-red-300 hover:bg-red-500/10 transition-colors"
                title="Stop action"
              >
                <Square className="w-3.5 h-3.5 fill-current" />
              </button>
            ) : (
              <button
                onClick={(e) => { e.stopPropagation(); onDelete(task); }}
                className="p-1.5 rounded text-dark-500 hover:text-red-400 hover:bg-dark-700 transition-colors"
                title="Delete task"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── InstructionsEditModal ────────────────────────────────────────────────────

function InstructionsEditModal({ columnLabel, instructions, agents, onClose, onSave }) {
  const [items, setItems] = useState(() => instructions.map(i => ({ ...i })));
  const [saving, setSaving] = useState(false);

  const roles = useMemo(() => [...new Set(agents.filter(a => a.enabled !== false).map(a => a.role).filter(Boolean))].sort(), [agents]);

  const updateField = (idx, field, value) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(items);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-[700px] max-h-[80vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-dark-100">Instructions — {columnLabel}</span>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg text-dark-400 hover:text-dark-100 hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 overflow-auto px-5 py-4 space-y-4">
          {items.map((item, idx) => (
            <div key={idx} className="space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex items-center gap-2">
                  <User className="w-3.5 h-3.5 text-dark-500" />
                  <select
                    value={item.role || ''}
                    onChange={e => updateField(idx, 'role', e.target.value)}
                    className="px-2 py-1 bg-dark-800 border border-dark-600 rounded-lg text-xs text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
                  >
                    <option value="">Any agent</option>
                    {roles.map(r => <option key={r} value={r}>{r}</option>)}
                  </select>
                </div>
                <span className="text-dark-600 text-[10px]">Transition #{item.transitionIdx + 1}, Action #{item.actionIdx + 1}</span>
              </div>
              <textarea
                value={item.instructions}
                onChange={e => updateField(idx, 'instructions', e.target.value)}
                placeholder="Instructions for the agent..."
                className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2.5 text-sm text-dark-200 placeholder-dark-500 resize-y min-h-[120px] focus:outline-none focus:border-indigo-500 transition-colors"
              />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-dark-700">
          <button onClick={onClose}
            className="px-3 py-1.5 text-xs text-dark-400 hover:text-dark-200 transition-colors">
            Cancel
          </button>
          <button onClick={handleSave} disabled={saving}
            className="flex items-center gap-1.5 px-4 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium rounded-lg transition-colors disabled:opacity-50">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

// ── KanbanColumn ────────────────────────────────────────────────────────────

function KanbanColumn({ col, tasks, agents, onDelete, onStop, onDrop, onOpen, onClearAll, onAddTask, onEditInstructions, hasInstructions, showAgent, showCreator, showProject, showTaskType, onTouchDragStart }) {
  const { theme } = useTheme();
  const isLight = theme === 'light';
  const [dragOver, setDragOver] = useState(false);
  const [hovered, setHovered] = useState(false);

  return (
    <div className="flex flex-col min-w-[300px] w-[300px] max-h-[2500px] flex-shrink-0 group"
      onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {/* Column header */}
      <div className={`flex items-center justify-between px-3 py-2.5 rounded-t-xl border border-b-2
        transition-colors mb-0 flex-shrink-0
        ${dragOver
          ? `bg-dark-750 ${col.headerActive} border-b-2`
          : 'bg-dark-800/60 border-dark-700/50'
        }`}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${col.dot}`} />
          <span className={`text-sm font-semibold ${isLight ? col.headerTextLight : col.headerText}`}>{col.label}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {hasInstructions && (
            <button
              onClick={() => onEditInstructions(col.id)}
              className="p-1 rounded text-dark-500 hover:text-blue-400 hover:bg-dark-700 transition-colors"
              title="Edit agent instructions for this column"
            >
              <Edit3 className="w-3.5 h-3.5" />
            </button>
          )}
          {onClearAll && tasks.length > 0 && (
            <button
              onClick={onClearAll}
              className="p-1 rounded text-dark-500 hover:text-red-400 hover:bg-dark-700 transition-colors"
              title="Delete all done tasks"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
          <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${isLight ? col.countClsLight : col.countCls}`}>
            {tasks.length}
          </span>
        </div>
      </div>

      {/* Drop zone */}
      <div
        data-column-id={col.id}
        className={`flex flex-col gap-2 p-2 rounded-b-xl border border-t-0
          transition-all duration-150 flex-1 min-h-0 overflow-y-auto
          ${dragOver
            ? `ring-2 ring-inset ${col.dropRing} border-dark-600`
            : 'bg-dark-800/20 border-dark-700/30'
          }`}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(true); }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOver(false); }}
        onDrop={(e) => { e.preventDefault(); setDragOver(false); onDrop(e, col); }}
      >
        {onAddTask && (
          <button
            onClick={onAddTask}
            className={`flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-xs
              transition-all duration-150 flex-shrink-0
              ${hovered || tasks.length === 0 ? 'opacity-100 text-dark-400 hover:text-indigo-400 hover:bg-dark-700/50' : 'opacity-0'}`}
          >
            <Plus className="w-3 h-3" /> Add task
          </button>
        )}
        {tasks.map(task => (
          <TaskCard
            key={`${task.agentId}-${task.id}`}
            task={task}
            agents={agents}
            onDelete={onDelete}
            onStop={onStop}
            onOpen={onOpen}
            showAgent={showAgent}
            showCreator={showCreator}
            showProject={showProject}
            showTaskType={showTaskType}
            onTouchDragStart={onTouchDragStart}
          />
        ))}
        {tasks.length === 0 && (
          <div className={`flex items-center justify-center text-xs py-4
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
  { value: 'run_agent:title', label: 'Generate title (agent)' },
  { value: 'run_agent:set_type', label: 'Set task type (agent)' },
  { value: 'run_agent:decide', label: 'Instructions (agent)' },
  { value: 'change_status', label: 'Move to status' },
  { value: 'move_jira_status', label: '🔗 Move Jira ticket to status', jira: true },
  { value: 'jira_ai_comment', label: '🤖 AI analyze & comment on Jira ticket', jira: true },
];

function createAction(key, cols) {
  if (key === 'assign_agent') return { type: 'assign_agent', role: '' };
  if (key === 'run_agent:execute') return { type: 'run_agent', mode: 'execute', role: '', instructions: '' };
  if (key === 'run_agent:refine') return { type: 'run_agent', mode: 'refine', role: '', instructions: '' };
  if (key === 'run_agent:title') return { type: 'run_agent', mode: 'title', role: '' };
  if (key === 'run_agent:set_type') return { type: 'run_agent', mode: 'set_type', role: '' };
  if (key === 'run_agent:decide') return { type: 'run_agent', mode: 'decide', role: '', instructions: '' };
  if (key === 'change_status') return { type: 'change_status', target: cols[1]?.id || '' };
  if (key === 'move_jira_status') return { type: 'move_jira_status', jiraStatusIds: [] };
  if (key === 'jira_ai_comment') return { type: 'jira_ai_comment', role: '', instructions: '' };
  return { type: 'change_status', target: '' };
}

function getActionKey(action) {
  if (action.type === 'run_agent') return `run_agent:${action.mode}`;
  return action.type;
}

/** Filter valid transitions (must have new format with trigger + actions) */
function validTransition(t) {
  return t && t.from && t.trigger && Array.isArray(t.actions);
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

function WorkflowEditor({ workflow, agents, jiraStatus, onClose, onSave }) {
  const [cols, setCols] = useState(() => JSON.parse(JSON.stringify(workflow.columns)));
  const [transitions, setTransitions] = useState(() => {
    const raw = JSON.parse(JSON.stringify(workflow.transitions));
    return raw.filter(validTransition);
  });
  const [saving, setSaving] = useState(false);
  const [jiraColumns, setJiraColumns] = useState([]);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState(null);

  const jiraEnabled = jiraStatus?.enabled || false;

  // Fetch Jira columns for dropdowns
  useEffect(() => {
    if (jiraEnabled) {
      api.getJiraColumns().then(setJiraColumns).catch(() => {});
    }
  }, [jiraEnabled]);

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
  const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'step';
  const updateCol = (idx, patch) => setCols(prev => prev.map((c, i) => {
    if (i !== idx) return c;
    const updated = { ...c, ...patch };
    // Sync id with label when label changes
    if (patch.label !== undefined) {
      const newId = slugify(patch.label);
      const oldId = c.id;
      if (newId && newId !== oldId) {
        updated.id = newId;
        // Update transitions that reference the old id
        setTransitions(ts => ts.map(t => t.from === oldId ? { ...t, from: newId } : t));
      }
    }
    return updated;
  }));
  const removeCol = (idx) => {
    const removed = cols[idx];
    setCols(prev => prev.filter((_, i) => i !== idx));
    setTransitions(prev => prev.filter(t => t.from !== removed.id));
  };
  const addCol = () => {
    setCols(prev => [...prev, { id: 'new_step', label: 'New Step', color: '#6b7280' }]);
  };
  const moveCol = (idx, dir) => {
    const target = idx + dir;
    if (target < 0 || target >= cols.length) return;
    setCols(prev => {
      const arr = [...prev];
      [arr[idx], arr[target]] = [arr[target], arr[idx]];
      return arr;
    });
  };

  // ── Transition helpers ──
  const updateTransition = (idx, patch) => setTransitions(prev => prev.map((t, i) => i === idx ? { ...t, ...patch } : t));
  const removeTransition = (idx) => setTransitions(prev => prev.filter((_, i) => i !== idx));

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
    >
      <div className="w-[90vw] max-h-[90vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col">
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

        <div className="flex-1 overflow-auto px-5 py-4">
          {/* ── Columns as horizontal cards with transitions below each ── */}
          <div className="flex gap-3 pb-2">
            {cols.map((col, idx) => {
              const colTransitions = transitions
                .map((t, ti) => ({ ...t, _idx: ti }))
                .filter(t => t.from === col.id);

              return (
                <div key={idx} className="flex flex-col min-w-[240px] flex-1">
                  {/* Column header card */}
                  <div className="bg-dark-800 rounded-lg px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <select value={col.color} onChange={e => updateCol(idx, { color: e.target.value })}
                        className="w-6 h-5 bg-dark-700 border-0 rounded cursor-pointer text-[10px]" style={{ color: col.color }}>
                        {AVAILABLE_COLORS.map(c => <option key={c.hex} value={c.hex} style={{ color: c.hex }}>{c.label}</option>)}
                      </select>
                      <input value={col.label} onChange={e => updateCol(idx, { label: e.target.value })}
                        className="flex-1 bg-transparent text-sm font-medium text-dark-200 outline-none min-w-0" placeholder="Column name" />
                      <button onClick={() => moveCol(idx, -1)} disabled={idx === 0}
                        className={`p-0.5 ${idx === 0 ? 'text-dark-700 cursor-not-allowed' : 'text-dark-500 hover:text-dark-200'}`} title="Move left">
                        <ChevronDown className="w-3 h-3 rotate-90" />
                      </button>
                      <button onClick={() => moveCol(idx, 1)} disabled={idx === cols.length - 1}
                        className={`p-0.5 ${idx === cols.length - 1 ? 'text-dark-700 cursor-not-allowed' : 'text-dark-500 hover:text-dark-200'}`} title="Move right">
                        <ChevronDown className="w-3 h-3 -rotate-90" />
                      </button>
                      <button onClick={() => removeCol(idx)} className="p-0.5 text-dark-500 hover:text-red-400" title="Remove column">
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1 text-[10px] text-dark-400 cursor-pointer" title="Show assignee on cards">
                        <input type="checkbox" checked={col.showAgent || false}
                          onChange={e => updateCol(idx, { showAgent: e.target.checked })}
                          className="rounded border-dark-600 bg-dark-700 text-indigo-500 focus:ring-indigo-500/30 w-3 h-3" />
                        <User className="w-3 h-3" />
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-dark-400 cursor-pointer" title="Show creator on cards">
                        <input type="checkbox" checked={col.showCreator || false}
                          onChange={e => updateCol(idx, { showCreator: e.target.checked })}
                          className="rounded border-dark-600 bg-dark-700 text-indigo-500 focus:ring-indigo-500/30 w-3 h-3" />
                        <Zap className="w-3 h-3" />
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-dark-400 cursor-pointer" title="Show project on cards">
                        <input type="checkbox" checked={col.showProject || false}
                          onChange={e => updateCol(idx, { showProject: e.target.checked })}
                          className="rounded border-dark-600 bg-dark-700 text-indigo-500 focus:ring-indigo-500/30 w-3 h-3" />
                        <FolderKanban className="w-3 h-3" />
                      </label>
                      <label className="flex items-center gap-1 text-[10px] text-dark-400 cursor-pointer" title="Show task type on cards">
                        <input type="checkbox" checked={col.showTaskType || false}
                          onChange={e => updateCol(idx, { showTaskType: e.target.checked })}
                          className="rounded border-dark-600 bg-dark-700 text-indigo-500 focus:ring-indigo-500/30 w-3 h-3" />
                        <Layers className="w-3 h-3" />
                      </label>
                    </div>
                  </div>

                  {/* Transitions for this column */}
                  <div className="mt-2 space-y-2 flex-1">
                    {colTransitions.map(t => {
                      const idx = t._idx;
                      return (
                        <div key={idx} className="bg-dark-800/60 border border-dark-700/50 rounded-lg px-3 py-2.5 space-y-2">
                          {/* Trigger */}
                          <div>
                            <div className="flex items-center justify-between mb-1.5">
                              <div className="flex items-center gap-1.5">
                                <Zap className="w-3 h-3 text-amber-400" />
                                <span className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider">Trigger</span>
                              </div>
                              <button onClick={() => removeTransition(idx)}
                                className="p-0.5 text-dark-500 hover:text-red-400" title="Remove transition">
                                <Trash2 className="w-3 h-3" />
                              </button>
                            </div>
                    <select value={t.trigger || 'on_enter'}
                      onChange={e => {
                        const patch = { trigger: e.target.value };
                        if (e.target.value === 'jira_ticket') { patch.jiraStatusIds = []; patch.jiraStatusNames = []; }
                        updateTransition(idx, patch);
                      }}
                      className="w-full px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs text-dark-200">
                      <option value="on_enter">On enter (immediate)</option>
                      <option value="condition">When conditions met (periodic)</option>
                      {jiraEnabled && <option value="jira_ticket">🔗 Jira ticket arrives</option>}
                    </select>
                    {t.trigger === 'jira_ticket' && (
                      <div className="mt-2 pl-3 border-l-2 border-blue-500/30 space-y-1.5">
                        <div className="text-[10px] text-dark-400">Import tickets from Jira column(s):</div>
                        {jiraColumns.map(jc => (
                          <label key={jc.name} className="flex items-center gap-2 text-xs text-dark-200 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={(t.jiraStatusIds || []).some(id => jc.statusIds.includes(id))}
                              onChange={e => {
                                const current = new Set(t.jiraStatusIds || []);
                                const currentNames = new Set(t.jiraStatusNames || []);
                                jc.statusIds.forEach(id => e.target.checked ? current.add(id) : current.delete(id));
                                (jc.statusNames || []).forEach(n => e.target.checked ? currentNames.add(n) : currentNames.delete(n));
                                updateTransition(idx, { jiraStatusIds: [...current], jiraStatusNames: [...currentNames] });
                              }}
                              className="rounded border-dark-600"
                            />
                            {jc.name}{jc.statusIds.length === 0 && <span className="text-dark-500 text-[9px] ml-1">(no statuses mapped)</span>}
                          </label>
                        ))}
                        {jiraColumns.length === 0 && <div className="text-[10px] text-dark-500 italic">Loading Jira columns...</div>}
                      </div>
                    )}
                    {t.trigger === 'condition' && (
                      <div className="mt-2 space-y-1.5 pl-3 border-l-2 border-amber-500/30">
                        <div className="text-[10px] text-dark-400">All conditions must be true:</div>
                        {(t.conditions || []).map((cond, ci) => (
                          <div key={ci} className="flex flex-wrap items-center gap-1.5">
                            <select value={cond.field || 'assignee_status'}
                              onChange={e => {
                                const f = e.target.value;
                                const defaults = { assignee_status: 'idle', assignee_enabled: 'true', assignee_role: '', task_has_assignee: 'true', idle_agent_available: '' };
                                updateCondition(idx, ci, { ...cond, field: f, value: defaults[f] || '' });
                              }}
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
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-[10px] text-dark-500 w-3">{ai + 1}.</span>
                            <select value={getActionKey(action)}
                              onChange={e => changeActionType(idx, ai, e.target.value)}
                              className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                              {ACTION_OPTIONS.filter(o => !o.jira || jiraEnabled).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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

                            {/* Target status for change_status */}
                            {action.type === 'change_status' && (
                              <select value={action.target || ''}
                                onChange={e => updateAction(idx, ai, { target: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">Select status...</option>
                                {cols.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                              </select>
                            )}

                            {/* Jira target status for move_jira_status */}
                            {action.type === 'move_jira_status' && (
                              <select
                                value={(action.jiraStatusIds || [])[0] || ''}
                                onChange={e => {
                                  const jc = jiraColumns.find(c => c.statusIds.includes(e.target.value));
                                  updateAction(idx, ai, { jiraStatusIds: jc ? jc.statusIds : [e.target.value] });
                                }}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">Jira column...</option>
                                {jiraColumns.map(jc => (
                                  <option key={jc.name} value={jc.statusIds[0]}>{jc.name}</option>
                                ))}
                              </select>
                            )}

                            {/* Agent role for jira_ai_comment */}
                            {action.type === 'jira_ai_comment' && (
                              <select value={action.role || ''}
                                onChange={e => updateAction(idx, ai, { role: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">Any agent...</option>
                                {[...new Set(agents.map(a => a.role).filter(Boolean))].map(r => (
                                  <option key={r} value={r}>{r}</option>
                                ))}
                              </select>
                            )}

                            <button onClick={() => removeAction(idx, ai)}
                              className="ml-auto p-0.5 text-dark-500 hover:text-red-400">
                              <Trash2 className="w-2.5 h-2.5" />
                            </button>
                          </div>

                          {/* Instructions for agent actions */}
                          {action.type === 'run_agent' && action.mode !== 'title' && action.mode !== 'set_type' && (
                            <textarea value={action.instructions || ''}
                              onChange={e => updateAction(idx, ai, { instructions: e.target.value })}
                              placeholder={action.mode === 'decide' || action.mode === 'execute'
                                ? "Instructions for the agent... (e.g., 'Run build_stack. If success, move task to test. If failure, move to backlog.')"
                                : action.mode === 'refine'
                                ? "Refinement instructions... (e.g., 'Add acceptance criteria and break into sub-tasks')"
                                : "Extra instructions (optional)... (e.g., 'Focus on unit tests')"}
                              className={`w-full bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-xs text-dark-200 placeholder-dark-500 resize-none ${action.mode === 'decide' || action.mode === 'execute' ? 'h-24' : 'h-14'}`}
                            />
                          )}

                          {/* Instructions for jira_ai_comment */}
                          {action.type === 'jira_ai_comment' && (
                            <textarea value={action.instructions || ''}
                              onChange={e => updateAction(idx, ai, { instructions: e.target.value })}
                              placeholder="Custom analysis instructions... (e.g., 'Focus on security risks and testing requirements' or leave empty for default analysis)"
                              className="w-full bg-dark-900 border border-dark-600 rounded px-2 py-1.5 text-xs text-dark-200 placeholder-dark-500 resize-none h-14"
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
                      );
                    })}
                    <button onClick={() => {
                      setTransitions(prev => [...prev, {
                        from: col.id,
                        trigger: 'on_enter',
                        conditions: [],
                        actions: [createAction('change_status', cols)],
                      }]);
                    }}
                      className="flex items-center gap-1 text-[10px] text-indigo-400 hover:text-indigo-300">
                      <Plus className="w-2.5 h-2.5" /> Add transition
                    </button>
                  </div>
                </div>
              );
            })}
            <div className="flex flex-col justify-start min-w-[120px] w-[120px] flex-shrink-0">
              <button onClick={addCol}
                className="flex items-center justify-center gap-1.5 h-[72px] border-2 border-dashed border-dark-700
                  rounded-lg text-xs text-dark-500 hover:text-indigo-400 hover:border-indigo-500/30 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Add column
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-dark-700">
          <button
            onClick={() => { setJsonText(JSON.stringify({ columns: cols, transitions }, null, 2)); setJsonError(null); setShowJson(true); }}
            className="p-1.5 text-dark-500 hover:text-indigo-400 hover:bg-dark-700 rounded-lg transition-colors"
            title="View / Edit JSON"
          >
            <Code className="w-4 h-4" />
          </button>
          <div className="flex gap-2">
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

        {/* JSON Modal */}
        {showJson && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowJson(false)}>
            <div className="bg-dark-800 border border-dark-700 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-3 border-b border-dark-700">
                <span className="text-sm font-semibold text-dark-100">Workflow JSON</span>
                <button onClick={() => setShowJson(false)} className="p-1 text-dark-400 hover:text-dark-100 rounded">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 min-h-0 p-4 overflow-auto">
                <textarea
                  value={jsonText}
                  onChange={e => { setJsonText(e.target.value); setJsonError(null); }}
                  className="w-full h-[50vh] bg-dark-900 border border-dark-600 rounded-lg p-3 text-xs font-mono text-dark-200 focus:outline-none focus:border-indigo-500 resize-none"
                  spellCheck={false}
                />
                {jsonError && <p className="mt-2 text-xs text-red-400">{jsonError}</p>}
              </div>
              <div className="flex justify-end gap-2 px-5 py-3 border-t border-dark-700">
                <button onClick={() => setShowJson(false)} className="px-3 py-1.5 text-xs text-dark-300 hover:text-dark-100 bg-dark-800 hover:bg-dark-700 rounded-lg transition-colors">Cancel</button>
                <button
                  onClick={() => {
                    try {
                      const parsed = JSON.parse(jsonText);
                      if (!Array.isArray(parsed.columns) || !Array.isArray(parsed.transitions)) {
                        setJsonError('JSON must have "columns" and "transitions" arrays.');
                        return;
                      }
                      setCols(parsed.columns);
                      setTransitions(parsed.transitions.filter(validTransition));
                      setShowJson(false);
                    } catch (err) {
                      setJsonError('Invalid JSON: ' + err.message);
                    }
                  }}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-indigo-500 hover:bg-indigo-600 rounded-lg transition-colors"
                >
                  <Check className="w-3 h-3" />
                  Apply
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── BoardTabs ──────────────────────────────────────────────────────────────

function BoardTabs({ boards, activeBoardId, onSelect, onCreate, onRename, onDelete }) {
  const [renaming, setRenaming] = useState(null);
  const [renameValue, setRenameValue] = useState('');
  const [contextMenu, setContextMenu] = useState(null);
  const renameRef = useRef(null);
  const contextRef = useRef(null);

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  useEffect(() => {
    if (!contextMenu) return;
    const handler = (e) => {
      if (contextRef.current && !contextRef.current.contains(e.target)) setContextMenu(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [contextMenu]);

  const handleRenameSubmit = (boardId) => {
    const trimmed = renameValue.trim();
    if (trimmed && trimmed !== boards.find(b => b.id === boardId)?.name) {
      onRename(boardId, trimmed);
    }
    setRenaming(null);
  };

  return (
    <div className="flex items-center gap-1 px-4 py-1.5 border-b border-dark-700/50 bg-dark-900/50 flex-wrap relative z-20">
      {boards.map(board => (
        <div key={board.id} className="relative flex-shrink-0">
          {renaming === board.id ? (
            <input
              ref={renameRef}
              value={renameValue}
              onChange={e => setRenameValue(e.target.value)}
              onBlur={() => handleRenameSubmit(board.id)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleRenameSubmit(board.id);
                if (e.key === 'Escape') setRenaming(null);
              }}
              className="px-3 py-1.5 bg-dark-800 border border-indigo-500/50 rounded-lg text-xs text-dark-200
                focus:outline-none focus:border-indigo-500 w-32"
            />
          ) : (
            <button
              onClick={() => onSelect(board.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setContextMenu(board.id);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                ${activeBoardId === board.id
                  ? 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30'
                  : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800 border border-transparent'
                }`}
            >
              <KanbanSquare className="w-3 h-3" />
              {board.name}
              <ChevronDown
                className="w-3 h-3 opacity-50 hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); setContextMenu(contextMenu === board.id ? null : board.id); }}
              />
            </button>
          )}
          {contextMenu === board.id && (
            <div ref={contextRef}
              className="absolute left-0 top-full mt-1 z-50 bg-dark-800 border border-dark-600 rounded-lg shadow-xl py-1 min-w-[140px]">
              <button
                onClick={() => {
                  setRenameValue(board.name);
                  setRenaming(board.id);
                  setContextMenu(null);
                }}
                className="w-full text-left px-3 py-1.5 text-xs text-dark-200 hover:bg-dark-700 flex items-center gap-2"
              >
                <Edit3 className="w-3 h-3" /> Rename
              </button>
              {boards.length > 1 && (
                <button
                  onClick={() => { onDelete(board.id); setContextMenu(null); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-dark-700 flex items-center gap-2"
                >
                  <Trash2 className="w-3 h-3" /> Delete
                </button>
              )}
            </div>
          )}
        </div>
      ))}
      <button
        onClick={onCreate}
        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-dark-500
          hover:text-indigo-400 hover:bg-dark-800 transition-colors flex-shrink-0"
        title="Create new board"
      >
        <Plus className="w-3 h-3" />
        New Board
      </button>
    </div>
  );
}

// ── TasksBoard (multi-board) ────────────────────────────────────────────────

export default function TasksBoard({ agents, onRefresh, user }) {
  const [projectFilter, setProjectFilter] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('date_desc');
  const [selectedTask, setSelectedTask] = useState(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createDefaultStatus, setCreateDefaultStatus] = useState(null);
  const [showWorkflowEditor, setShowWorkflowEditor] = useState(false);
  const [editInstructionsCol, setEditInstructionsCol] = useState(null);
  const [jiraStatus, setJiraStatus] = useState(null);
  const boardScrollRef = useRef(null);

  // Multi-board state
  const [boards, setBoards] = useState([]);
  const [activeBoardId, setActiveBoardId] = useState(null);
  const [boardsLoaded, setBoardsLoaded] = useState(false);

  // Fallback workflow for when no board exists yet (legacy compat)
  const [fallbackWorkflow, setFallbackWorkflow] = useState(null);

  // Load boards on mount
  useEffect(() => {
    let cancelled = false;
    async function loadBoards() {
      try {
        const boardList = await api.getBoards();
        if (cancelled) return;
        if (boardList.length > 0) {
          setBoards(boardList);
          // Restore last active board from localStorage or use first
          const lastBoardId = localStorage.getItem('activeBoardId');
          const validBoard = boardList.find(b => b.id === lastBoardId);
          setActiveBoardId(validBoard ? validBoard.id : boardList[0].id);
        } else {
          // No boards yet — create with clean default (backend provides Todo/In Progress/Done)
          const board = await api.createBoard('My Board');
          if (cancelled) return;
          setBoards([board]);
          setActiveBoardId(board.id);
        }
      } catch {
        // Fallback to legacy single workflow
        try {
          const wf = await api.getWorkflow();
          if (!cancelled) setFallbackWorkflow(wf);
        } catch { /* no-op */ }
      } finally {
        if (!cancelled) setBoardsLoaded(true);
      }
    }
    loadBoards();
    api.getJiraStatus().then(setJiraStatus).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Persist active board selection
  useEffect(() => {
    if (activeBoardId) localStorage.setItem('activeBoardId', activeBoardId);
  }, [activeBoardId]);

  // Active board data
  const activeBoard = useMemo(() => boards.find(b => b.id === activeBoardId) || null, [boards, activeBoardId]);

  // Get workflow: from active board, or fallback
  const workflow = useMemo(() => {
    if (activeBoard?.workflow?.columns) return activeBoard.workflow;
    return fallbackWorkflow;
  }, [activeBoard, fallbackWorkflow]);

  const columns = useMemo(() => workflow ? buildColumns(workflow.columns) : [], [workflow]);
  const statusOptions = useMemo(() => workflow ? buildStatusOptions(workflow.columns) : [], [workflow]);

  // Map column IDs to their "Instructions/Execute (agent)" actions from transitions
  const columnInstructionsMap = useMemo(() => {
    if (!workflow?.transitions) return {};
    const map = {};
    workflow.transitions.forEach((tr, tIdx) => {
      (tr.actions || []).forEach((act, aIdx) => {
        if (act.type === 'run_agent' && (act.mode === 'decide' || act.mode === 'execute')) {
          const colId = tr.from;
          if (!map[colId]) map[colId] = [];
          map[colId].push({
            instructions: act.instructions || '',
            role: act.role || '',
            transitionIdx: tIdx,
            actionIdx: aIdx,
          });
        }
      });
    });
    return map;
  }, [workflow]);

  // Aggregate all tasks from all agents, filtered by active board
  const firstBoardId = boards.length > 0 ? boards[0].id : null;
  const allTasks = useMemo(() =>
    agents.flatMap(a =>
      (a.todoList || [])
        .filter(t => {
          if (!activeBoardId) return true;
          // Tasks without a boardId belong to the first board only
          if (!t.boardId) return activeBoardId === firstBoardId;
          return t.boardId === activeBoardId;
        })
        .map(t => {
          const assigneeAgent = t.assignee ? agents.find(ag => ag.id === t.assignee) : null;
          return {
            ...t,
            agentId: a.id,
            agentName: a.name,
            assigneeName: assigneeAgent?.name || null,
            assigneeIcon: assigneeAgent?.icon || null,
          };
        })
    ),
    [agents, activeBoardId, firstBoardId]
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

  // Group by column — error is an internal state, not a workflow column.
  // Use errorFromStatus to keep error tasks visible in their originating column.
  const tasksByColumn = useMemo(() => {
    const groups = {};
    const fallbackColId = columns[0]?.id;
    columns.forEach(col => {
      const colTasks = filteredTasks.filter(t => {
        if (t.status === 'error') {
          return (t.errorFromStatus || fallbackColId) === col.id;
        }
        return col.statuses.includes(t.status || fallbackColId);
      });
      groups[col.id] = sortTasks(colTasks, sortBy);
    });
    return groups;
  }, [filteredTasks, columns, sortBy]);

  const handleDelete = useCallback(async (task) => {
    await api.deleteTask(task.agentId, task.id);
    onRefresh();
  }, [onRefresh]);

  const handleStopAction = useCallback(async (task) => {
    const agentId = task.actionRunningAgentId || task.assignee;
    if (agentId) {
      await api.stopAgent(agentId);
      onRefresh();
    }
  }, [onRefresh]);

  const lastColId = columns[columns.length - 1]?.id;

  const handleClearDone = useCallback(async () => {
    const doneTasks = allTasks.filter(t => t.status === lastColId);
    await Promise.all(doneTasks.map(t => api.deleteTask(t.agentId, t.id)));
    onRefresh();
  }, [allTasks, onRefresh, lastColId]);

  const handleDrop = useCallback(async (e, col) => {
    let agentId, taskId;
    try {
      ({ agentId, taskId } = JSON.parse(e.dataTransfer.getData('application/json')));
    } catch { return; }
    try {
      const task = allTasks.find(t => t.id === taskId && t.agentId === agentId);
      if (!task) return;
      // Check if task is already in this column (including error tasks in their original column)
      const fallbackColId = columns[0]?.id;
      const isAlreadyInColumn = task.status === 'error'
        ? (task.errorFromStatus || fallbackColId) === col.id
        : col.statuses.includes(task.status || fallbackColId);
      if (isAlreadyInColumn) return;
      await api.setTaskStatus(agentId, taskId, col.dropStatus);
      onRefresh();
    } catch (err) {
      console.error('[TasksBoard] Drop status change failed:', err.message);
    }
  }, [allTasks, onRefresh]);

  // Touch drag-and-drop handler
  const handleTouchDrop = useCallback(async (agentId, taskId, targetColumnId) => {
    try {
      const task = allTasks.find(t => t.id === taskId && t.agentId === agentId);
      if (!task) return;
      const col = columns.find(c => c.id === targetColumnId);
      if (!col) return;
      const fallbackColId = columns[0]?.id;
      const isAlreadyInColumn = task.status === 'error'
        ? (task.errorFromStatus || fallbackColId) === col.id
        : col.statuses.includes(task.status || fallbackColId);
      if (isAlreadyInColumn) return;
      await api.setTaskStatus(agentId, taskId, col.dropStatus);
      onRefresh();
    } catch (err) {
      console.error('[TasksBoard] Touch drop status change failed:', err.message);
    }
  }, [allTasks, columns, onRefresh]);

  // Listen for custom touch-task-drop events on the board
  useEffect(() => {
    const boardEl = boardScrollRef.current;
    if (!boardEl) return;
    const handler = (e) => {
      const { agentId, taskId, targetColumnId } = e.detail;
      handleTouchDrop(agentId, taskId, targetColumnId);
    };
    boardEl.addEventListener('touch-task-drop', handler);
    return () => boardEl.removeEventListener('touch-task-drop', handler);
  }, [handleTouchDrop]);

  const totalByStatus = useMemo(() => {
    const lastColId = columns[columns.length - 1]?.id;
    return {
      open: allTasks.filter(t => t.status !== 'error' && t.status !== lastColId).length,
      error: allTasks.filter(t => t.status === 'error').length,
      done: allTasks.filter(t => t.status === lastColId).length,
    };
  }, [allTasks, columns]);

  const activeFilters = [agentFilter, projectFilter, search].filter(Boolean).length;

  // ── Board management handlers ──
  const handleCreateBoard = useCallback(async () => {
    try {
      // New boards always start with a clean 3-column workflow
      const board = await api.createBoard(`Board ${boards.length + 1}`);
      setBoards(prev => [...prev, board]);
      setActiveBoardId(board.id);
    } catch (err) {
      console.error('Failed to create board:', err.message);
    }
  }, [boards.length]);

  const handleRenameBoard = useCallback(async (boardId, newName) => {
    try {
      const updated = await api.updateBoard(boardId, { name: newName });
      setBoards(prev => prev.map(b => b.id === boardId ? updated : b));
    } catch (err) {
      console.error('Failed to rename board:', err.message);
    }
  }, []);

  const handleDeleteBoard = useCallback(async (boardId) => {
    if (boards.length <= 1) return;
    try {
      await api.deleteBoard(boardId);
      setBoards(prev => {
        const remaining = prev.filter(b => b.id !== boardId);
        if (activeBoardId === boardId && remaining.length > 0) {
          setActiveBoardId(remaining[0].id);
        }
        return remaining;
      });
    } catch (err) {
      console.error('Failed to delete board:', err.message);
    }
  }, [boards.length, activeBoardId]);

  const handleSaveWorkflow = useCallback(async (updated) => {
    if (!activeBoardId) return;
    const updatedBoard = await api.updateBoardWorkflow(activeBoardId, updated);
    setBoards(prev => prev.map(b => b.id === activeBoardId ? updatedBoard : b));
  }, [activeBoardId]);

  if (!boardsLoaded) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* Board Tabs */}
      {boards.length > 0 && (
        <BoardTabs
          boards={boards}
          activeBoardId={activeBoardId}
          onSelect={setActiveBoardId}
          onCreate={handleCreateBoard}
          onRename={handleRenameBoard}
          onDelete={handleDeleteBoard}
        />
      )}

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

        {/* Sort */}
        <div className="flex items-center gap-1.5">
          <ArrowUpDown className="w-3.5 h-3.5 text-dark-400" />
          <select
            value={sortBy}
            onChange={e => setSortBy(e.target.value)}
            className="px-3 py-1.5 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200
              focus:outline-none focus:border-indigo-500 transition-colors"
          >
            {SORT_OPTIONS.map(opt => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
        </div>

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
          <span>{totalByStatus.open} open</span>
          <span className="text-emerald-400/70">{totalByStatus.done} done</span>
          {totalByStatus.error > 0 && (
            <span className="text-red-400/70">{totalByStatus.error} errors</span>
          )}
        </div>

        {/* Workflow settings */}
        <button
          onClick={() => setShowWorkflowEditor(true)}
          className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors"
          title="Board workflow settings"
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
      <div
        ref={boardScrollRef}
        className="flex-1 min-h-0 overflow-auto scrollbar-always-visible"
      >
        <div className="flex gap-4 p-6 min-w-max items-stretch">
          {columns.map((col, colIdx) => (
            <KanbanColumn
              key={col.id}
              col={col}
              tasks={tasksByColumn[col.id] || []}
              agents={agents}
              onDelete={handleDelete}
              onStop={handleStopAction}
              onDrop={handleDrop}
              onOpen={setSelectedTask}
              onClearAll={col.id === lastColId ? handleClearDone : undefined}
              onAddTask={() => { setCreateDefaultStatus(col.id); setCreateOpen(true); }}
              onEditInstructions={setEditInstructionsCol}
              hasInstructions={!!columnInstructionsMap[col.id]}
              showAgent={col.showAgent}
              showCreator={col.showCreator}
              showProject={col.showProject}
              showTaskType={col.showTaskType}
              onTouchDragStart={() => {}}
            />
          ))}
        </div>
      </div>

      {/* Instructions edit modal */}
      {editInstructionsCol && columnInstructionsMap[editInstructionsCol] && (
        <InstructionsEditModal
          columnLabel={columns.find(c => c.id === editInstructionsCol)?.label || editInstructionsCol}
          instructions={columnInstructionsMap[editInstructionsCol]}
          agents={agents}
          onClose={() => setEditInstructionsCol(null)}
          onSave={async (updatedEntries) => {
            if (!workflow) return;
            const updated = JSON.parse(JSON.stringify(workflow));
            for (const entry of updatedEntries) {
              const action = updated.transitions[entry.transitionIdx]?.actions?.[entry.actionIdx];
              if (action) {
                action.instructions = entry.instructions;
                if (entry.role !== undefined) action.role = entry.role;
              }
            }
            await handleSaveWorkflow(updated);
            setEditInstructionsCol(null);
          }}
        />
      )}

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
          defaultStatus={createDefaultStatus}
          boardId={activeBoardId}
          onClose={() => { setCreateOpen(false); setCreateDefaultStatus(null); }}
          onCreated={onRefresh}
        />
      )}

      {/* Workflow editor modal */}
      {showWorkflowEditor && workflow && (
        <WorkflowEditor
          workflow={workflow}
          agents={agents}
          jiraStatus={jiraStatus}
          onClose={() => setShowWorkflowEditor(false)}
          onSave={handleSaveWorkflow}
        />
      )}
    </div>
  );
}
