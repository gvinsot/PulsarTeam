import { Bug, Sparkles, Wrench, ArrowUpCircle, BookOpen, HelpCircle } from 'lucide-react';
import type { TaskRecurrenceInput } from '../../api';
import type {
  BoardWorkflowColumn,
  TaskPriority,
  TaskRecurrence,
  TaskSource,
  WorkflowAction,
  WorkflowTransition,
} from '../../types';

// ── Color mapping (hex → Tailwind classes) ──────────────────────────────────

/** The Tailwind class set one column color resolves to. UI-LOCAL: no API
 *  producer emits this — it is what COLOR_MAP stores per hex. */
export interface ColumnColorClasses {
  dot: string;
  headerText: string;
  headerTextLight: string;
  countCls: string;
  countClsLight: string;
  dropRing: string;
  headerActive: string;
  statusDot: string;
  statusText: string;
}

// `satisfies` rather than a `Record<string, …>` annotation: the checked shape is
// the same, but the KEYS stay literal, so `ColumnColor` below is the real set of
// styled hexes (the seven of AVAILABLE_COLORS) instead of `string`.
export const COLOR_MAP = {
  '#a855f7': {
    dot: 'bg-purple-500',
    headerText: 'text-purple-300',
    headerTextLight: 'text-purple-900',
    countCls: 'bg-purple-500/20 text-purple-300',
    countClsLight: 'bg-purple-500/20 text-purple-900',
    dropRing: 'ring-purple-500/40 bg-purple-500/5',
    headerActive: 'border-purple-500/60',
    statusDot: 'bg-purple-400',
    statusText: 'text-purple-300',
  },
  '#6b7280': {
    dot: 'bg-gray-500',
    headerText: 'text-gray-300',
    headerTextLight: 'text-gray-900',
    countCls: 'bg-gray-500/20 text-gray-300',
    countClsLight: 'bg-gray-500/20 text-gray-900',
    dropRing: 'ring-gray-500/40 bg-gray-500/5',
    headerActive: 'border-gray-500/60',
    statusDot: 'bg-gray-400',
    statusText: 'text-gray-300',
  },
  '#3b82f6': {
    dot: 'bg-blue-500',
    headerText: 'text-blue-300',
    headerTextLight: 'text-blue-900',
    countCls: 'bg-blue-500/20 text-blue-300',
    countClsLight: 'bg-blue-500/20 text-blue-900',
    dropRing: 'ring-blue-500/40 bg-blue-500/5',
    headerActive: 'border-blue-500/60',
    statusDot: 'bg-blue-400',
    statusText: 'text-blue-300',
  },
  '#eab308': {
    dot: 'bg-amber-400',
    headerText: 'text-amber-300',
    headerTextLight: 'text-amber-900',
    countCls: 'bg-amber-500/20 text-amber-300',
    countClsLight: 'bg-amber-500/20 text-amber-900',
    dropRing: 'ring-amber-500/40 bg-amber-500/5',
    headerActive: 'border-amber-400/60',
    statusDot: 'bg-amber-400',
    statusText: 'text-amber-300',
  },
  '#22c55e': {
    dot: 'bg-emerald-400',
    headerText: 'text-emerald-300',
    headerTextLight: 'text-emerald-900',
    countCls: 'bg-emerald-500/20 text-emerald-300',
    countClsLight: 'bg-emerald-500/20 text-emerald-900',
    dropRing: 'ring-emerald-500/40 bg-emerald-500/5',
    headerActive: 'border-emerald-400/60',
    statusDot: 'bg-emerald-400',
    statusText: 'text-emerald-300',
  },
  '#ef4444': {
    dot: 'bg-red-400',
    headerText: 'text-red-300',
    headerTextLight: 'text-red-900',
    countCls: 'bg-red-500/20 text-red-300',
    countClsLight: 'bg-red-500/20 text-red-900',
    dropRing: 'ring-red-500/40 bg-red-500/5',
    headerActive: 'border-red-400/60',
    statusDot: 'bg-red-400',
    statusText: 'text-red-300',
  },
  '#64748b': {
    dot: 'bg-slate-500',
    headerText: 'text-dark-300',
    headerTextLight: 'text-slate-900',
    countCls: 'bg-dark-700 text-dark-400',
    countClsLight: 'bg-slate-500/20 text-slate-900',
    dropRing: 'ring-slate-500/40 bg-slate-500/5',
    headerActive: 'border-slate-500/60',
    statusDot: 'bg-slate-400',
    statusText: 'text-slate-300',
  },
} satisfies Record<string, ColumnColorClasses>;

/** A hex COLOR_MAP actually styles. `BoardWorkflowColumn.color` is a free string,
 *  so this is the subset, not the field's type. */
export type ColumnColor = keyof typeof COLOR_MAP;

const DEFAULT_COLOR: ColumnColorClasses = COLOR_MAP['#6b7280'];

const isColumnColor = (hex: string): hex is ColumnColor =>
  Object.prototype.hasOwnProperty.call(COLOR_MAP, hex);

/** `hex` is a `BoardWorkflowColumn['color']`: optional on the wire and free-form
 *  when present, hence the fallback rather than a lookup. */
export function colorClasses(hex?: string): ColumnColorClasses {
  return hex && isColumnColor(hex) ? COLOR_MAP[hex] : DEFAULT_COLOR;
}

/** One rendered kanban column: a workflow column resolved against COLOR_MAP.
 *  UI-LOCAL — buildColumns is its only producer. */
export interface BoardColumnView {
  /** The workflow column id, i.e. the task status this column holds. */
  id: string;
  label: string;
  /** Always exactly `[id]`; kept as an array because the board matches tasks
   *  against a column's status LIST. */
  statuses: string[];
  dropStatus: string;
  dot: string;
  headerText: string;
  headerTextLight: string;
  countCls: string;
  countClsLight: string;
  dropRing: string;
  headerActive: string;
  /** The four display flags, defaulted here so consumers read a plain boolean —
   *  they are `.passthrough()` extras on the wire and genuinely absent on
   *  columns written before the workflow editor added them. */
  showAgent: boolean;
  showCreator: boolean;
  showProject: boolean;
  showTaskType: boolean;
}

export function buildColumns(workflowColumns: BoardWorkflowColumn[]): BoardColumnView[] {
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

/** One entry of the status picker the task modals render. `value` is the column
 *  id (BoardWorkflowColumn.id), which is exactly what `Task.status` stores;
 *  `dot`/`text` are the Tailwind classes from COLOR_MAP. */
export interface StatusOption {
  value: string;
  label: string;
  dot: string;
  text: string;
}

export function buildStatusOptions(workflowColumns: BoardWorkflowColumn[]): StatusOption[] {
  return workflowColumns.map(col => {
    const c = colorClasses(col.color);
    return { value: col.id, label: col.label, dot: c.statusDot, text: c.statusText };
  });
}

// ── Helpers ─────────────────────────────────────────────────────────────────

// The four helpers below all take an ISO 8601 timestamp that may be ABSENT
// (`|| undefined` in rowToTask drops the key) or an explicit NULL (the socket
// frames write one) — which is exactly why each opens on a falsiness guard.

export function timeAgo(iso?: string | null): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatDate(iso?: string | null): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** One provenance badge. UI-LOCAL. */
export interface SourceMeta {
  /** Both consumers pick the entry from a truthy `task.source` and then pass
   *  `task.source` again at render time, where the narrowing no longer holds —
   *  so the argument's type really is the field's own (optional AND nullable on
   *  a socket frame), even though it is never absent at that call. */
  label: (source?: TaskSource | null) => string;
  cls: string;
}

/** Keyed on `TaskSource.type`, which is rule 2 (open) — hence the plain
 *  `Record` and the `|| SOURCE_META.api` fallback both consumers apply. */
export const SOURCE_META: Record<string, SourceMeta> = {
  user: {
    label: s => (s?.name ? s.name : 'User'),
    cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20',
  },
  agent: {
    label: s => s?.name || 'Agent',
    cls: 'text-purple-400 bg-purple-500/10 ring-purple-500/20',
  },
  api: { label: () => 'API', cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20' },
  mcp: { label: () => 'MCP', cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20' },
  recurrence: { label: () => 'Recurring', cls: 'text-teal-400 bg-teal-500/10 ring-teal-500/20' },
  website: {
    label: s => s?.name || 'Website',
    cls: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20',
  },
};

// ── Task type definitions ────────────────────────────────────────────────────

export const TASK_TYPES = [
  { value: 'bug', label: 'Bug', icon: Bug, cls: 'text-red-400 bg-red-500/10 ring-red-500/20' },
  {
    value: 'feature',
    label: 'Feature',
    icon: Sparkles,
    cls: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20',
  },
  {
    value: 'technical',
    label: 'Technical',
    icon: Wrench,
    cls: 'text-blue-400 bg-blue-500/10 ring-blue-500/20',
  },
  {
    value: 'improvement',
    label: 'Improvement',
    icon: ArrowUpCircle,
    cls: 'text-violet-400 bg-violet-500/10 ring-violet-500/20',
  },
  {
    value: 'documentation',
    label: 'Documentation',
    icon: BookOpen,
    cls: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',
  },
  {
    value: 'other',
    label: 'Other',
    icon: HelpCircle,
    cls: 'text-slate-400 bg-slate-500/10 ring-slate-500/20',
  },
];

/** One TASK_TYPES row. Named so the lookup below has something to be a map OF. */
export type TaskTypeOption = (typeof TASK_TYPES)[number];

// The callback's return annotation is load-bearing: without it `[t.value, t]`
// infers as `(string | TaskTypeOption)[]`, Object.fromEntries falls through to
// its `any` overload, and the whole map (plus every read off it) goes untyped.
// Spelling the pair as a TUPLE selects the real overload, which returns
// `{ [k: string]: TaskTypeOption }`.
export const TASK_TYPE_MAP = Object.fromEntries(
  TASK_TYPES.map((t): [string, TaskTypeOption] => [t.value, t])
);

// ── Execution mode labels (history entries) ─────────────────────────────────

// 'execute' is a removed action mode, kept here only to label historical
// execution-log entries that genuinely ran under it.
export const MODE_LABELS: Record<string, string> = {
  execute: 'Execution',
  refine: 'Refine',
  decide: 'Decide',
  title: 'Title',
  set_type: 'Set Type',
};

// ── Recurrence periods ────────────────────────────────────────────────────────

export const RECURRENCE_PERIODS = [
  { value: 'hourly', label: 'Every hour', minutes: 60 },
  { value: 'daily', label: 'Every day', minutes: 1440 },
  { value: 'weekly', label: 'Every week', minutes: 10080 },
  { value: 'monthly', label: 'Every month', minutes: 43200 },
  { value: 'custom', label: 'Custom interval', minutes: null },
];

// Recurrence payload sent to the API when recurrence is enabled. Call sites
// keep their own disabled branch ({ enabled: false } on update vs undefined
// on create) because the wire formats differ deliberately.
export function buildRecurrence(
  period: string,
  customMinutes: number,
  retentionDays: number
): TaskRecurrenceInput {
  return {
    enabled: true,
    period,
    intervalMinutes:
      period === 'custom'
        ? customMinutes
        : RECURRENCE_PERIODS.find(p => p.value === period)?.minutes || 1440,
    historyRetentionDays: retentionDays > 0 ? retentionDays : null,
  };
}

// Display label for a stored recurrence (custom intervals are spelled out,
// so the table's 'Custom interval' label is never shown).
export function recurrenceLabel(rec: TaskRecurrence): string {
  if (rec.period === 'custom') return `Every ${rec.intervalMinutes} min`;
  return RECURRENCE_PERIODS.find(p => p.value === rec.period)?.label || rec.period;
}

// ── Priority definitions ──────────────────────────────────────────────────────

export const PRIORITIES = [
  {
    value: 'critical',
    label: 'Critique',
    sortOrder: 0,
    cls: 'text-red-400 bg-red-500/10 ring-red-500/20',
    dotCls: 'bg-red-400',
  },
  {
    value: 'high',
    label: 'Haute',
    sortOrder: 1,
    cls: 'text-orange-400 bg-orange-500/10 ring-orange-500/20',
    dotCls: 'bg-orange-400',
  },
  {
    value: 'medium',
    label: 'Moyenne',
    sortOrder: 2,
    cls: 'text-amber-400 bg-amber-500/10 ring-amber-500/20',
    dotCls: 'bg-amber-400',
  },
  {
    value: 'low',
    label: 'Basse',
    sortOrder: 3,
    cls: 'text-sky-400 bg-sky-500/10 ring-sky-500/20',
    dotCls: 'bg-sky-400',
  },
];

/** One PRIORITIES row. */
export type PriorityOption = (typeof PRIORITIES)[number];

// Same tuple annotation as TASK_TYPE_MAP, for the same overload reason.
export const PRIORITY_MAP = Object.fromEntries(
  PRIORITIES.map((p): [string, PriorityOption] => [p.value, p])
);

// ── Sort helpers ─────────────────────────────────────────────────────────────

export function isToday(iso?: string | null): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}

export const SORT_OPTIONS = [
  { value: 'manual', label: 'Manual (drag & drop)' },
  { value: 'created_desc', label: 'Created (recent)' },
  { value: 'created_asc', label: 'Created (oldest)' },
  { value: 'updated_desc', label: 'Modified (recent)' },
  { value: 'updated_asc', label: 'Modified (oldest)' },
  { value: 'priority_asc', label: 'Priority (high first)' },
  { value: 'priority_desc', label: 'Priority (low first)' },
];

/**
 * The four fields the comparators below read. Deliberately a structural minimum
 * instead of `Task`: the board sorts `TaskSocketPayload`s, whose every key is
 * optional AND nullable, and the sort must hand back the SAME element type it
 * was given — hence the type parameter on sortTasks.
 */
export interface SortableTask {
  position?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  priority?: TaskPriority | null;
}

/** `sortBy` is a SORT_OPTIONS value, plus the two legacy 'date_*' aliases the
 *  switch still honours — no closed union, the value comes out of localStorage. */
export function sortTasks<T extends SortableTask>(tasks: T[], sortBy: string): T[] {
  const sorted = [...tasks];
  switch (sortBy) {
    case 'manual':
      return sorted.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    case 'date_asc':
    case 'created_asc':
      return sorted.sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );
    case 'date_desc':
    case 'created_desc':
      return sorted.sort(
        (a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime()
      );
    case 'updated_asc':
      return sorted.sort(
        (a, b) =>
          new Date(a.updatedAt || a.createdAt || 0).getTime() -
          new Date(b.updatedAt || b.createdAt || 0).getTime()
      );
    case 'updated_desc':
      return sorted.sort(
        (a, b) =>
          new Date(b.updatedAt || b.createdAt || 0).getTime() -
          new Date(a.updatedAt || a.createdAt || 0).getTime()
      );
    case 'priority_asc': {
      // `?? ''` only stands in for the absent key: PRIORITY_MAP has no ''
      // entry, so an unset priority still falls through to the default below.
      const order = (t: SortableTask) => PRIORITY_MAP[t.priority ?? '']?.sortOrder ?? 99;
      return sorted.sort((a, b) => order(a) - order(b));
    }
    case 'priority_desc': {
      const order = (t: SortableTask) => PRIORITY_MAP[t.priority ?? '']?.sortOrder ?? -1;
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

// Sentinel role value for a run_agent / assign_agent action whose role is picked
// automatically at run time by the admin-configured Role Router LLM. Defined in
// workflowRoles.ts (which stays free of React/icon imports so it can be unit
// tested) and re-exported here for the existing call sites.
export { AUTO_ROLE } from './workflowRoles';

export const ACTION_OPTIONS = [
  { value: 'assign_agent', label: 'Assign to agent (by role)' },
  { value: 'assign_agent_individual', label: 'Assign to agent (individually)' },
  { value: 'run_agent:refine', label: 'Refine description (agent)' },
  { value: 'run_agent:title', label: 'Generate title (agent)' },
  { value: 'run_agent:set_type', label: 'Set task type (agent)' },
  { value: 'run_agent:decide', label: 'Instructions (agent)' },
  { value: 'change_status', label: 'Move to status' },
];

/** `key` is an ACTION_OPTIONS value, but it arrives straight off a `<select>`,
 *  so an unrecognised one is possible by type and is what the final fallback
 *  answers. `_cols` is unused today and kept because both call sites pass the
 *  board's columns. */
export function createAction(key: string, _cols: BoardWorkflowColumn[]): WorkflowAction {
  if (key === 'assign_agent') return { type: 'assign_agent', role: '' };
  if (key === 'assign_agent_individual') return { type: 'assign_agent_individual', agentId: '' };
  if (key === 'run_agent:refine')
    return { type: 'run_agent', mode: 'refine', role: '', instructions: '' };
  if (key === 'run_agent:title') return { type: 'run_agent', mode: 'title', role: '' };
  if (key === 'run_agent:set_type') return { type: 'run_agent', mode: 'set_type', role: '' };
  if (key === 'run_agent:decide')
    return { type: 'run_agent', mode: 'decide', role: '', instructions: '' };
  if (key === 'change_status') return { type: 'change_status', target: '__next__' };
  return { type: 'change_status', target: '' };
}

export function getActionKey(action: WorkflowAction): string {
  // Legacy boards may still carry mode:'execute' (removed) — surface it as the
  // 'decide' option so the action stays editable instead of showing a blank
  // dropdown. Re-saving the board then persists it as decide.
  if (action.type === 'run_agent')
    return `run_agent:${action.mode === 'execute' ? 'decide' : action.mode}`;
  return action.type;
}

/**
 * Filter valid transitions (must have new format with trigger + actions).
 *
 * The input is `unknown` because both call sites feed it JSON: a structural
 * clone of `board.workflow.transitions` and the JSON textarea's parse output.
 * `z.array(z.any()).max(200)` is all the API validates, so nothing about the
 * element's shape is known before this guard runs — which is precisely what it
 * is for. It is the narrowing to WorkflowTransition, hence the type predicate.
 */
export function validTransition(t: unknown): t is WorkflowTransition {
  if (typeof t !== 'object' || t === null) return false;
  return (
    'from' in t &&
    !!t.from &&
    'trigger' in t &&
    !!t.trigger &&
    'actions' in t &&
    Array.isArray(t.actions)
  );
}
