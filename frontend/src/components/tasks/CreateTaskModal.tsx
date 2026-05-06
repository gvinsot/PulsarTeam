import { useState, useRef, useEffect } from 'react';
import { Plus, X, GitBranch, Repeat, Layers, Hand } from 'lucide-react';
import { api } from '../../api';
import { TASK_TYPES } from './taskConstants';

const RECURRENCE_PERIODS = [
  { value: 'hourly', label: 'Every hour', minutes: 60 },
  { value: 'daily', label: 'Every day', minutes: 1440 },
  { value: 'weekly', label: 'Every week', minutes: 10080 },
  { value: 'monthly', label: 'Every month', minutes: 43200 },
  { value: 'custom', label: 'Custom interval', minutes: null },
];

export default function CreateTaskModal({ agents, onClose, onCreated, statusOptions, defaultStatus, boardId, projectName }) {
  // Allow all columns as creation statuses (don't exclude the last one —
  // custom columns added after "Done" would be wrongly hidden by slice(0, -1))
  const CREATE_STATUSES = statusOptions;
  const initialStatus = defaultStatus && CREATE_STATUSES.some(s => s.value === defaultStatus)
    ? defaultStatus
    : (CREATE_STATUSES[0]?.value || 'backlog');
  const [text, setText] = useState('');
  const [status, setStatus] = useState(initialStatus);
  const [taskType, setTaskType] = useState('');
  const [isManual, setIsManual] = useState(false);
  const [recurring, setRecurring] = useState(false);
  const [recurrencePeriod, setRecurrencePeriod] = useState('daily');
  const [customInterval, setCustomInterval] = useState(60);
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef(null);

  // Repos linked to the board — task can target one of them
  const [boardRepos, setBoardRepos] = useState([]);
  const [repoId, setRepoId] = useState('');
  useEffect(() => {
    if (!boardId) { setBoardRepos([]); return; }
    api.getBoardRepos(boardId).then(setBoardRepos).catch(() => setBoardRepos([]));
  }, [boardId]);
  // Default to the only repo when there's exactly one
  useEffect(() => {
    if (!repoId && boardRepos.length === 1) setRepoId(boardRepos[0].id);
  }, [boardRepos, repoId]);

  // Auto-pick the first enabled agent as container (tasks are no longer agent-specific)
  const defaultAgentId = (agents || []).find(a => a.enabled !== false)?.id || '';

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
      const recurrence = recurring ? {
        enabled: true,
        period: recurrencePeriod,
        intervalMinutes: recurrencePeriod === 'custom'
          ? customInterval
          : RECURRENCE_PERIODS.find(p => p.value === recurrencePeriod)?.minutes || 1440,
      } : undefined;
      const created = await api.addTask(defaultAgentId, trimmed, status, boardId, repoId || undefined, recurrence, taskType || undefined, isManual || undefined);
      // Pass the created task so the parent can optimistically insert it
      // before the next loadTasks() fetch (avoids the race where the DB
      // INSERT hasn't committed yet).
      await onCreated({ ...created, agentId: defaultAgentId });
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
      <div className="w-full max-w-xl bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl shadow-black/50 flex flex-col animate-fadeIn">
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
              rows={6}
              placeholder="Describe the task..."
              className="w-full px-3 py-2.5 bg-dark-800 border border-dark-700 rounded-lg text-sm
                text-dark-100 placeholder-dark-500 focus:outline-none focus:border-indigo-500
                resize-none leading-relaxed transition-colors"
            />
          </div>

          {/* Project (read-only — derived from the board) */}
          {projectName && (
            <div className="flex items-center justify-between text-xs text-dark-400 bg-dark-800/60 border border-dark-700 rounded-lg px-3 py-2">
              <span className="uppercase tracking-wide">Project</span>
              <span className="text-dark-200 font-medium">{projectName}</span>
            </div>
          )}

          {/* Repo (optional, scoped to the board's repos) */}
          {boardRepos.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
                <GitBranch className="inline w-3 h-3 mr-1" />Repo
              </label>
              <select
                value={repoId}
                onChange={e => setRepoId(e.target.value)}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              >
                <option value="">No specific repo</option>
                {boardRepos.map(r => (
                  <option key={r.id} value={r.id}>[{r.provider}] {r.full_name}</option>
                ))}
              </select>
            </div>
          )}

          {/* Status + Type row */}
          <div className="flex gap-3">
            <div className="flex-1">
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
            <div className="flex-1">
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

          {/* Manual + Recurrence */}
          <div className="border border-dark-700 rounded-lg p-3 space-y-3">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isManual}
                onChange={e => setIsManual(e.target.checked)}
                className="w-3.5 h-3.5 rounded border-dark-600 bg-dark-800 text-orange-500 focus:ring-orange-500 focus:ring-offset-0"
              />
              <Hand className="w-3.5 h-3.5 text-dark-400" />
              <span className="text-xs font-semibold text-dark-300 uppercase tracking-wide">Manual task</span>
              <span className="text-[10px] text-dark-500 ml-1">— not processed by agents</span>
            </label>
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
