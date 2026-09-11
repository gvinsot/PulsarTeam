import { useState, useEffect, useCallback } from 'react';
import {
  Repeat,
  X,
  Loader2,
  Play,
  Trash2,
  Save,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import {
  getTaskTemplates,
  updateTaskTemplate,
  deleteTaskTemplate,
  runTaskTemplate,
  type TaskTemplate,
} from '../../api';
import { errorMessage } from '../../utils/errors';
import { buildRecurrence, recurrenceLabel, RECURRENCE_PERIODS } from './taskConstants';
import RecurrenceFields from './RecurrenceFields';
import type { TaskRecurrencePeriod } from '../../types';

interface RecurringTasksPanelProps {
  /** The board whose rules are listed. */
  boardId: string | null;
  onClose: () => void;
  /** Fired after a run is started or a rule deleted, so the board reloads. */
  onChanged: () => void;
}

/** "in 3 h", "in 12 min", "overdue" — a rule's schedule read at a glance. */
function untilLabel(iso: string | null): string {
  if (!iso) return 'unscheduled';
  const deltaMs = Date.parse(iso) - Date.now();
  if (!Number.isFinite(deltaMs)) return 'unscheduled';
  if (deltaMs <= 0) return 'due now';
  const minutes = Math.round(deltaMs / 60000);
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} h`;
  return `in ${Math.round(hours / 24)} d`;
}

const RUN_STATUS_CLASS: Record<string, string> = {
  done: 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20',
  error: 'text-red-400 bg-red-500/10 ring-red-500/20',
};

/**
 * The recurring rules of a board.
 *
 * A rule is NOT a card: it holds a schedule and spawns one fresh run per period,
 * and only those runs appear on the board. That is why this panel exists at all
 * — it is the only place a rule can be seen, edited, run early or stopped.
 */
export default function RecurringTasksPanel({
  boardId,
  onClose,
  onChanged,
}: RecurringTasksPanelProps) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Ids of rules whose run list is expanded. */
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  /** The rule being edited, and the id of the one with an action in flight. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Editor state — seeded from the rule when the pencil is clicked.
  const [period, setPeriod] = useState<TaskRecurrencePeriod>('daily');
  const [customInterval, setCustomInterval] = useState(60);
  const [retentionDays, setRetentionDays] = useState(0);
  const [keepLast, setKeepLast] = useState(0);
  const [onOverlap, setOnOverlap] = useState<'skip' | 'spawn'>('skip');

  const load = useCallback(async () => {
    try {
      setTemplates(await getTaskTemplates(boardId));
      setError(null);
    } catch (err) {
      setError(errorMessage(err) || 'Failed to load recurring tasks');
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    load();
  }, [load]);

  const startEditing = (template: TaskTemplate) => {
    const rec = template.recurrence;
    // A stored interval that matches no preset is a custom one, whatever the
    // `period` field says — the presets are the only values the select offers.
    const preset = RECURRENCE_PERIODS.find(p => p.minutes === rec?.intervalMinutes);
    setPeriod(preset ? (preset.value as TaskRecurrencePeriod) : 'custom');
    setCustomInterval(rec?.intervalMinutes || 60);
    setRetentionDays(rec?.historyRetentionDays || 0);
    setKeepLast(rec?.keepLastOccurrences || 0);
    setOnOverlap(rec?.onOverlap === 'spawn' ? 'spawn' : 'skip');
    setEditingId(template.id);
  };

  const handleSave = async (templateId: string) => {
    setBusyId(templateId);
    try {
      await updateTaskTemplate(templateId, {
        recurrence: buildRecurrence(period, customInterval, retentionDays, keepLast, onOverlap),
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(errorMessage(err) || 'Failed to save the schedule');
    } finally {
      setBusyId(null);
    }
  };

  const handleRunNow = async (templateId: string) => {
    setBusyId(templateId);
    try {
      await runTaskTemplate(templateId);
      await load();
      onChanged();
    } catch (err) {
      setError(errorMessage(err) || 'Failed to start a run');
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (templateId: string) => {
    setBusyId(templateId);
    try {
      await deleteTaskTemplate(templateId);
      setTemplates(prev => prev.filter(t => t.id !== templateId));
      setConfirmDelete(null);
      onChanged();
    } catch (err) {
      setError(errorMessage(err) || 'Failed to stop the rule');
    } finally {
      setBusyId(null);
    }
  };

  const toggleExpanded = (templateId: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(templateId)) next.delete(templateId);
      else next.add(templateId);
      return next;
    });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="bg-dark-900 border border-dark-700 rounded-xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Repeat className="w-4 h-4 text-teal-400" />
            <h2 className="text-sm font-semibold text-dark-200">Recurring tasks</h2>
            <span className="text-xs text-dark-500">({templates.length})</span>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mx-4 mt-3 flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 text-xs text-red-400">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{error}</span>
          </div>
        )}

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-dark-400 animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-dark-500">
              <Repeat className="w-8 h-8 mb-2 opacity-30" />
              <span className="text-sm">No recurring task on this board</span>
              <span className="text-xs mt-1 text-dark-600">
                Tick “Recurring” when creating a task to add one
              </span>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map(template => {
                const isEditing = editingId === template.id;
                const isBusy = busyId === template.id;
                const isExpanded = expanded.has(template.id);
                return (
                  <div
                    key={template.id}
                    className="bg-dark-800 border border-dark-700 rounded-lg overflow-hidden"
                  >
                    <div className="flex items-start justify-between px-4 py-3 gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-dark-200 truncate">
                          {template.title || template.text || 'Untitled'}
                        </p>
                        <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                          {template.recurrence && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full font-medium ring-1 bg-teal-500/10 text-teal-400 ring-teal-500/20">
                              {recurrenceLabel(template.recurrence)}
                            </span>
                          )}
                          <span className="text-[11px] text-dark-400">
                            Next {untilLabel(template.nextRunAt)}
                          </span>
                          {template.unfinishedRuns > 0 && (
                            <span
                              className="text-[11px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 ring-1 ring-amber-500/20"
                              title={
                                template.recurrence?.onOverlap === 'spawn'
                                  ? 'Runs still going; the next one starts regardless'
                                  : 'Runs still going; the next cycle is skipped until they finish'
                              }
                            >
                              {template.unfinishedRuns} in flight
                            </span>
                          )}
                          {template.agentName && (
                            <span className="text-[11px] text-dark-500">{template.agentName}</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 flex-shrink-0">
                        <button
                          onClick={() => handleRunNow(template.id)}
                          disabled={isBusy}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-400
                            bg-emerald-500/10 border border-emerald-500/20 rounded-lg
                            hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                          title="Start one run now, without moving the schedule"
                        >
                          {isBusy ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Play className="w-3 h-3" />
                          )}
                          Run now
                        </button>
                        <button
                          onClick={() => (isEditing ? setEditingId(null) : startEditing(template))}
                          className="px-2.5 py-1.5 text-xs text-dark-300 bg-dark-700 rounded-lg hover:bg-dark-600 transition-colors"
                          title="Edit the schedule"
                        >
                          {isEditing ? 'Close' : 'Edit'}
                        </button>
                        {confirmDelete === template.id ? (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => handleDelete(template.id)}
                              disabled={isBusy}
                              className="px-2 py-1.5 text-xs font-medium text-red-400 bg-red-500/20
                                border border-red-500/30 rounded-lg hover:bg-red-500/30
                                transition-colors disabled:opacity-50"
                            >
                              {isBusy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Confirm'}
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="px-2 py-1.5 text-xs text-dark-400 hover:text-dark-200 bg-dark-700 rounded-lg hover:bg-dark-600 transition-colors"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(template.id)}
                            className="p-1.5 rounded-lg text-red-400/70 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                            title="Stop this rule (its runs are kept)"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        )}
                      </div>
                    </div>

                    {isEditing && (
                      <div className="px-4 pb-4 space-y-3 border-t border-dark-700/60 pt-3">
                        <RecurrenceFields
                          period={period}
                          onPeriodChange={setPeriod}
                          customInterval={customInterval}
                          onCustomIntervalChange={setCustomInterval}
                          retentionDays={retentionDays}
                          onRetentionDaysChange={setRetentionDays}
                          keepLast={keepLast}
                          onKeepLastChange={setKeepLast}
                          onOverlap={onOverlap}
                          onOverlapChange={setOnOverlap}
                          focusClass="focus:border-teal-500"
                        />
                        <div className="flex justify-end">
                          <button
                            onClick={() => handleSave(template.id)}
                            disabled={isBusy}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white
                              bg-teal-600 hover:bg-teal-500 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {isBusy ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Save className="w-3 h-3" />
                            )}
                            Save schedule
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Recent runs — the history that used to pile up inside one card */}
                    {template.recentRuns.length > 0 && (
                      <div className="border-t border-dark-700/60">
                        <button
                          onClick={() => toggleExpanded(template.id)}
                          className="w-full flex items-center gap-1.5 px-4 py-2 text-[11px] text-dark-400 hover:text-dark-200 hover:bg-dark-700/40 transition-colors"
                        >
                          {isExpanded ? (
                            <ChevronDown className="w-3 h-3" />
                          ) : (
                            <ChevronRight className="w-3 h-3" />
                          )}
                          Recent runs ({template.recentRuns.length})
                        </button>
                        {isExpanded && (
                          <div className="px-4 pb-3 space-y-1">
                            {template.recentRuns.map(run => (
                              <div
                                key={run.id}
                                className="flex items-center gap-2 text-[11px] text-dark-400"
                              >
                                <span className="text-dark-500 w-10 flex-shrink-0">
                                  #{run.occurrenceSeq ?? '—'}
                                </span>
                                <span
                                  className={`px-1.5 py-0.5 rounded ring-1 ${
                                    RUN_STATUS_CLASS[run.status] ||
                                    'text-dark-300 bg-dark-700/40 ring-dark-600'
                                  }`}
                                >
                                  {run.status}
                                </span>
                                <span className="text-dark-500">
                                  {new Date(run.createdAt).toLocaleString()}
                                </span>
                                {run.error && (
                                  <span className="text-red-400/80 truncate" title={run.error}>
                                    {run.error}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="px-6 py-3 border-t border-dark-700 text-[11px] text-dark-500">
          A recurring task spawns a fresh card each period; the rule itself stays here, off the
          board.
        </div>
      </div>
    </div>
  );
}
