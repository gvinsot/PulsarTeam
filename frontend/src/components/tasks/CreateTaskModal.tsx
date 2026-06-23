import { useState, useRef, useEffect } from 'react';
import { Plus, X, GitBranch, Cloud, Repeat, Layers, Hand } from 'lucide-react';
import { api } from '../../api';
import { TASK_TYPES, buildRecurrence } from './taskConstants';
import RecurrenceFields from './RecurrenceFields';
import { useBoardRepos, useBoardStorages } from '../../hooks/useBoardResources';

export default function CreateTaskModal({ agents, onClose, onCreated, statusOptions, defaultStatus, boardId, projectName, defaultRepoFullName = null, defaultStoragePath = null }) {
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
  // 0 = keep everything (no purge). Otherwise drops history/commits older
  // than N days at each reset.
  const [historyRetentionDays, setHistoryRetentionDays] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const textareaRef = useRef(null);

  // Repos accessible via the board's GitHub plugin — task targets one of them
  const { repos: availableRepos, error: repoLoadError } = useBoardRepos(boardId);
  // Pre-fill with the last repo used on this board (passed from TasksBoard).
  const [repoFullName, setRepoFullName] = useState(defaultRepoFullName || '');
  const userTouchedRepo = useRef(false);
  // Extra repos (fullNames) cloned alongside the primary at run time.
  const [secondaryRepos, setSecondaryRepos] = useState<string[]>([]);
  // If the user hasn't touched the picker, fall back to either the explicit
  // default or, when only one repo is available, that single repo.
  useEffect(() => {
    if (userTouchedRepo.current) return;
    if (defaultRepoFullName && availableRepos.some(r => r.fullName === defaultRepoFullName)) {
      setRepoFullName(defaultRepoFullName);
    } else if (!repoFullName && availableRepos.length === 1) {
      setRepoFullName(availableRepos[0].fullName);
    }
  }, [availableRepos, defaultRepoFullName, repoFullName]);

  // Storages accessible via the board's OneDrive plugin
  const { storages: availableStorages, loading: storageLoading } = useBoardStorages(boardId);
  const [storagePath, setStoragePath] = useState(defaultStoragePath || '');
  const userTouchedStorage = useRef(false);
  // Once the OneDrive root list arrives, settle on the default if it's still listed,
  // otherwise on the only available folder (besides the root).
  useEffect(() => {
    if (userTouchedStorage.current) return;
    if (defaultStoragePath && availableStorages.some(s => s.path === defaultStoragePath)) {
      setStoragePath(defaultStoragePath);
    } else if (!storagePath && availableStorages.length === 1) {
      setStoragePath(availableStorages[0].path);
    }
  }, [availableStorages, defaultStoragePath, storagePath]);

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
    setError(null);
    try {
      const recurrence = recurring
        ? buildRecurrence(recurrencePeriod, customInterval, historyRetentionDays)
        : undefined;
      const storageProvider = storagePath
        ? (availableStorages.find(s => s.path === storagePath)?.provider || 'onedrive')
        : 'onedrive';
      const created = await api.addTask(defaultAgentId, trimmed, {
        status,
        boardId,
        repoFullName: repoFullName || undefined,
        repoProvider: 'github',
        secondaryRepos: repoFullName && secondaryRepos.length > 0
          ? secondaryRepos.map(fn => ({ provider: 'github', fullName: fn }))
          : undefined,
        recurrence,
        taskType: taskType || undefined,
        isManual: isManual || undefined,
        storagePath: storagePath || null,
        storageProvider,
      });
      // Pass the created task so the parent can optimistically insert it
      // before the next loadTasks() fetch (avoids the race where the DB
      // INSERT hasn't committed yet).
      await onCreated({ ...created, agentId: defaultAgentId });
      onClose();
    } catch (err) {
      // Keep the modal open so the (possibly long) description isn't lost.
      setError(err?.message || 'Failed to create task');
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

          {/* Repo — sourced from the board's GitHub plugin OAuth */}
          <div>
            <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
              <GitBranch className="inline w-3 h-3 mr-1" />Repo
            </label>
            {repoLoadError ? (
              <p className="text-xs text-amber-300 italic px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                {repoLoadError} — connect the GitHub plugin on this board to enable the repo picker.
              </p>
            ) : availableRepos.length > 0 ? (
              <select
                value={repoFullName}
                onChange={e => { userTouchedRepo.current = true; const v = e.target.value; setRepoFullName(v); setSecondaryRepos(prev => prev.filter(s => s !== v)); }}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              >
                <option value="">No specific repo</option>
                {availableRepos.map(r => (
                  <option key={r.fullName} value={r.fullName}>[{r.provider}] {r.fullName}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-dark-500 italic px-3 py-2 bg-dark-800/40 border border-dark-700 rounded-lg">
                Loading repos...
              </p>
            )}
          </div>

          {/* Secondary repos — extra repos cloned next to the primary at run time */}
          {repoFullName && availableRepos.length > 0 && (
            <div>
              <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
                <GitBranch className="inline w-3 h-3 mr-1" />Secondary repos
              </label>
              <select
                value=""
                onChange={e => { const v = e.target.value; if (v && !secondaryRepos.includes(v)) setSecondaryRepos([...secondaryRepos, v]); }}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              >
                <option value="">Add a secondary repo…</option>
                {availableRepos
                  .filter(r => r.fullName !== repoFullName && !secondaryRepos.includes(r.fullName))
                  .map(r => (
                    <option key={r.fullName} value={r.fullName}>[{r.provider}] {r.fullName}</option>
                  ))}
              </select>
              {secondaryRepos.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {secondaryRepos.map(fn => (
                    <span key={fn} className="inline-flex items-center gap-1 px-2 py-1 text-[11px] rounded-md bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">
                      {fn}
                      <button type="button" onClick={() => setSecondaryRepos(secondaryRepos.filter(s => s !== fn))} className="hover:text-emerald-100">
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Storage — sourced from the board's OneDrive plugin OAuth */}
          <div>
            <label className="block text-xs font-semibold text-dark-400 uppercase tracking-wide mb-1.5">
              <Cloud className="inline w-3 h-3 mr-1" />Storage
            </label>
            {storageLoading ? (
              <p className="text-xs text-dark-500 italic px-3 py-2 bg-dark-800/40 border border-dark-700 rounded-lg">
                Loading folders...
              </p>
            ) : availableStorages.length > 0 ? (
              <select
                value={storagePath}
                onChange={e => { userTouchedStorage.current = true; setStoragePath(e.target.value); }}
                className="w-full px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none focus:border-indigo-500 transition-colors"
              >
                <option value="">No specific folder</option>
                {availableStorages.map(s => (
                  <option key={`${s.provider}:${s.path}`} value={s.path}>[{s.provider}] {s.displayName || s.path}</option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-dark-500 italic px-3 py-2 bg-dark-800/40 border border-dark-700 rounded-lg">
                No drive connected
              </p>
            )}
          </div>

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
              <RecurrenceFields
                period={recurrencePeriod}
                onPeriodChange={setRecurrencePeriod}
                customInterval={customInterval}
                onCustomIntervalChange={setCustomInterval}
                retentionDays={historyRetentionDays}
                onRetentionDaysChange={setHistoryRetentionDays}
                rowClass="mt-3"
              />
            )}
          </div>

          {error && (
            <p className="text-xs text-amber-300 italic px-3 py-2 bg-amber-500/10 border border-amber-500/30 rounded-lg">
              {error}
            </p>
          )}

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
