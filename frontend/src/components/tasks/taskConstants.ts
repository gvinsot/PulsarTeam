import {
  Bug, Sparkles, Wrench, ArrowUpCircle, BookOpen, HelpCircle,
} from 'lucide-react';

// ── Color mapping (hex → Tailwind classes) ──────────────────────────────────

export const COLOR_MAP = {
  '#a855f7': { dot: 'bg-purple-500',  headerText: 'text-purple-300', headerTextLight: 'text-purple-900', countCls: 'bg-purple-500/20 text-purple-300', countClsLight: 'bg-purple-500/20 text-purple-900', dropRing: 'ring-purple-500/40 bg-purple-500/5', headerActive: 'border-purple-500/60', statusDot: 'bg-purple-400', statusText: 'text-purple-300' },
  '#6b7280': { dot: 'bg-gray-500',    headerText: 'text-gray-300',   headerTextLight: 'text-gray-900',   countCls: 'bg-gray-500/20 text-gray-300',     countClsLight: 'bg-gray-500/20 text-gray-900',     dropRing: 'ring-gray-500/40 bg-gray-500/5',     headerActive: 'border-gray-500/60',   statusDot: 'bg-gray-400',   statusText: 'text-gray-300' },
  '#3b82f6': { dot: 'bg-blue-500',    headerText: 'text-blue-300',   headerTextLight: 'text-blue-900',   countCls: 'bg-blue-500/20 text-blue-300',     countClsLight: 'bg-blue-500/20 text-blue-900',     dropRing: 'ring-blue-500/40 bg-blue-500/5',     headerActive: 'border-blue-500/60',   statusDot: 'bg-blue-400',   statusText: 'text-blue-300' },
  '#eab308': { dot: 'bg-amber-400',   headerText: 'text-amber-300',  headerTextLight: 'text-amber-900',  countCls: 'bg-amber-500/20 text-amber-300',   countClsLight: 'bg-amber-500/20 text-amber-900',   dropRing: 'ring-amber-500/40 bg-amber-500/5',   headerActive: 'border-amber-400/60',  statusDot: 'bg-amber-400',  statusText: 'text-amber-300' },
  '#22c55e': { dot: 'bg-emerald-400', headerText: 'text-emerald-300',headerTextLight: 'text-emerald-900',countCls: 'bg-emerald-500/20 text-emerald-300',countClsLight: 'bg-emerald-500/20 text-emerald-900',dropRing: 'ring-emerald-500/40 bg-emerald-500/5',headerActive: 'border-emerald-400/60', statusDot: 'bg-emerald-400',statusText: 'text-emerald-300' },
  '#ef4444': { dot: 'bg-red-400',     headerText: 'text-red-300',    headerTextLight: 'text-red-900',    countCls: 'bg-red-500/20 text-red-300',       countClsLight: 'bg-red-500/20 text-red-900',       dropRing: 'ring-red-500/40 bg-red-500/5',       headerActive: 'border-red-400/60',    statusDot: 'bg-red-400',    statusText: 'text-red-300' },
  '#64748b': { dot: 'bg-slate-500',   headerText: 'text-dark-300',   headerTextLight: 'text-slate-900',  countCls: 'bg-dark-700 text-dark-400',        countClsLight: 'bg-slate-500/20 text-slate-900',   dropRing: 'ring-slate-500/40 bg-slate-500/5',   headerActive: 'border-slate-500/60',  statusDot: 'bg-slate-400',  statusText: 'text-slate-300' },
};

const DEFAULT_COLOR = COLOR_MAP['#6b7280'];

export function colorClasses(hex) {
  return COLOR_MAP[hex] || DEFAULT_COLOR;
}

export function buildColumns(workflowColumns) {
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

export function buildStatusOptions(workflowColumns) {
  return workflowColumns.map(col => {
    const c = colorClasses(col.color);
    return { value: col.id, label: col.label, dot: c.statusDot, text: c.statusText };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

export function timeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatDate(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

export const SOURCE_META = {
  user:       { label: (s) => s?.name ? s.name : 'User', cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20' },
  agent:      { label: (s) => s.name || 'Agent',  cls: 'text-purple-400 bg-purple-500/10 ring-purple-500/20' },
  api:        { label: () => 'API',               cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20' },
  mcp:        { label: () => 'MCP',               cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20' },
  recurrence: { label: () => 'Recurring',          cls: 'text-teal-400 bg-teal-500/10 ring-teal-500/20' },
  website:    { label: (s) => s?.name || 'Website', cls: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' },
};

// ── Task type definitions ────────────────────────────────────────────────────

export const TASK_TYPES = [
  { value: 'bug',           label: 'Bug',           icon: Bug,            cls: 'text-red-400 bg-red-500/10 ring-red-500/20' },
  { value: 'feature',       label: 'Feature',       icon: Sparkles,       cls: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' },
  { value: 'technical',     label: 'Technical',     icon: Wrench,         cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20' },
  { value: 'improvement',   label: 'Improvement',   icon: ArrowUpCircle,  cls: 'text-violet-400 bg-violet-500/10 ring-violet-500/20' },
  { value: 'documentation', label: 'Documentation', icon: BookOpen,       cls: 'text-amber-400 bg-amber-500/10 ring-amber-500/20' },
  { value: 'other',         label: 'Other',         icon: HelpCircle,     cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20' },
];

export const TASK_TYPE_MAP = Object.fromEntries(TASK_TYPES.map(t => [t.value, t]));

// ── Recurrence periods ────────────────────────────────────────────────────────

export const RECURRENCE_PERIODS = [
  { value: 'hourly',  label: 'Every hour',     minutes: 60 },
  { value: 'daily',   label: 'Every day',      minutes: 1440 },
  { value: 'weekly',  label: 'Every week',     minutes: 10080 },
  { value: 'monthly', label: 'Every month',    minutes: 43200 },
  { value: 'custom',  label: 'Custom interval', minutes: null },
];

// ── Priority definitions ──────────────────────────────────────────────────────

export const PRIORITIES = [
  { value: 'critical', label: 'Critique',  sortOrder: 0, cls: 'text-red-400 bg-red-500/10 ring-red-500/20',    dotCls: 'bg-red-400' },
  { value: 'high',     label: 'Haute',     sortOrder: 1, cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20', dotCls: 'bg-orange-400' },
  { value: 'medium',   label: 'Moyenne',   sortOrder: 2, cls: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',   dotCls: 'bg-amber-400' },
  { value: 'low',      label: 'Basse',     sortOrder: 3, cls: 'text-sky-400 bg-sky-500/10 ring-sky-500/20',      dotCls: 'bg-sky-400' },
];

export const PRIORITY_MAP = Object.fromEntries(PRIORITIES.map(p => [p.value, p]));

// ── Sort helpers ─────────────────────────────────────────────────────────────

export function isToday(iso) {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
}

export const SORT_OPTIONS = [
  { value: 'manual',          label: 'Manual (drag & drop)' },
  { value: 'created_desc',    label: 'Created (recent)' },
  { value: 'created_asc',     label: 'Created (oldest)' },
  { value: 'updated_desc',    label: 'Modified (recent)' },
  { value: 'updated_asc',     label: 'Modified (oldest)' },
  { value: 'priority_asc',    label: 'Priority (high first)' },
  { value: 'priority_desc',   label: 'Priority (low first)' },
];

export function sortTasks(tasks, sortBy) {
  const sorted = [...tasks];
  switch (sortBy) {
    case 'manual':
      return sorted.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    case 'date_asc':
    case 'created_asc':
      return sorted.sort((a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime());
    case 'date_desc':
    case 'created_desc':
      return sorted.sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
    case 'updated_asc':
      return sorted.sort((a, b) => new Date(a.updatedAt || a.createdAt || 0).getTime() - new Date(b.updatedAt || b.createdAt || 0).getTime());
    case 'updated_desc':
      return sorted.sort((a, b) => new Date(b.updatedAt || b.createdAt || 0).getTime() - new Date(a.updatedAt || a.createdAt || 0).getTime());
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

// ── Available colors for workflow editor columns ─────────────────────────────

export const AVAILABLE_COLORS = [
  { hex: '#a855f7', label: 'Purple' },
  { hex: '#6b7280', label: 'Gray' },
  { hex: '#3b82f6', label: 'Blue' },
  { hex: '#eab308', label: 'Amber' },
  { hex: '#22c55e', label: 'Green' },
  { hex: '#ef4444', label: 'Red' },
  { hex: '#64748b', label: 'Slate' },
];

// ── Action type helpers ──────────────────────────────────────────────────────

export const ACTION_OPTIONS = [
  { value: 'assign_agent', label: 'Assign to agent (by role)' },
  { value: 'assign_agent_individual', label: 'Assign to agent (individually)' },
  { value: 'run_agent:execute', label: 'Execute task (agent)' },
  { value: 'run_agent:refine', label: 'Refine description (agent)' },
  { value: 'run_agent:title', label: 'Generate title (agent)' },
  { value: 'run_agent:set_type', label: 'Set task type (agent)' },
  { value: 'run_agent:decide', label: 'Instructions (agent)' },
  { value: 'change_status', label: 'Move to status' },
  { value: 'move_jira_status', label: '🔗 Move Jira ticket to status', jira: true },
  { value: 'jira_ai_comment', label: '🤖 AI analyze & comment on Jira ticket', jira: true },
];

export function createAction(key, cols) {
  if (key === 'assign_agent') return { type: 'assign_agent', role: '' };
  if (key === 'assign_agent_individual') return { type: 'assign_agent_individual', agentId: '' };
  if (key === 'run_agent:execute') return { type: 'run_agent', mode: 'execute', role: '', instructions: '' };
  if (key === 'run_agent:refine') return { type: 'run_agent', mode: 'refine', role: '', instructions: '' };
  if (key === 'run_agent:title') return { type: 'run_agent', mode: 'title', role: '' };
  if (key === 'run_agent:set_type') return { type: 'run_agent', mode: 'set_type', role: '' };
  if (key === 'run_agent:decide') return { type: 'run_agent', mode: 'decide', role: '', instructions: '' };
  if (key === 'change_status') return { type: 'change_status', target: '__next__' };
  if (key === 'move_jira_status') return { type: 'move_jira_status', jiraStatusIds: [] };
  if (key === 'jira_ai_comment') return { type: 'jira_ai_comment', role: '', instructions: '' };
  return { type: 'change_status', target: '' };
}

export function getActionKey(action) {
  if (action.type === 'run_agent') return `run_agent:${action.mode}`;
  return action.type;
}

/** Filter valid transitions (must have new format with trigger + actions) */
export function validTransition(t) {
  return t && t.from && t.trigger && Array.isArray(t.actions);
}
