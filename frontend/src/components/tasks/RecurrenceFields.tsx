import { RECURRENCE_PERIODS } from './taskConstants';
import type { TaskRecurrencePeriod } from '../../types';

interface RecurrenceFieldsProps {
  /** One of RECURRENCE_PERIODS' values; the select is keyed on it. */
  period: TaskRecurrencePeriod;
  /** Receives the raw `<select>` value, i.e. a RECURRENCE_PERIODS entry. */
  onPeriodChange: (period: TaskRecurrencePeriod) => void;
  /** Minutes between two runs. Only editable while `period === 'custom'`. */
  customInterval: number;
  onCustomIntervalChange: (minutes: number) => void;
  /** Days a finished run is kept before deletion; 0 means "keep everything". */
  retentionDays: number;
  onRetentionDaysChange: (days: number) => void;
  /** How many finished runs to keep; 0 means "unlimited". */
  keepLast: number;
  onKeepLastChange: (count: number) => void;
  /** What to do when a run is due while the previous one is still unfinished. */
  onOverlap: 'skip' | 'spawn';
  onOverlapChange: (policy: 'skip' | 'spawn') => void;
  /** Tailwind focus-border class — the two callers use different accents. */
  focusClass?: string;
  /** Extra wrapper class; CreateTaskModal uses it to keep its mt-3 spacing. */
  rowClass?: string;
}

// Shared recurrence editor fields — period, custom minutes, overlap policy and
// the two retention limits — used by TaskDetailModal (teal accent) and
// CreateTaskModal (indigo accent). Each modal keeps its own enable-checkbox
// wrapper; `rowClass` lets CreateTaskModal preserve its mt-3 spacing.
//
// What these settings act on: a recurring task is a RULE that spawns one fresh
// run per period. The retention fields delete whole finished RUNS — they are
// what keeps a long-lived rule from accumulating rows forever.
export default function RecurrenceFields({
  period,
  onPeriodChange,
  customInterval,
  onCustomIntervalChange,
  retentionDays,
  onRetentionDaysChange,
  keepLast,
  onKeepLastChange,
  onOverlap,
  onOverlapChange,
  focusClass = 'focus:border-indigo-500',
  rowClass = '',
}: RecurrenceFieldsProps) {
  const fieldClass = `px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none ${focusClass} transition-colors`;
  const rowWrapper = (extra: string) => (rowClass ? `${rowClass} ${extra}` : extra);
  return (
    <>
      <div className={rowWrapper('flex gap-3 items-end')}>
        <div className="flex-1">
          <label className="block text-xs text-dark-400 mb-1">Period</label>
          <select
            value={period}
            onChange={e => onPeriodChange(e.target.value)}
            className={`w-full ${fieldClass}`}
          >
            {RECURRENCE_PERIODS.map(p => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {period === 'custom' && (
          <div className="w-32">
            <label className="block text-xs text-dark-400 mb-1">Minutes</label>
            <input
              type="number"
              min={1}
              value={customInterval}
              onChange={e => onCustomIntervalChange(Math.max(1, parseInt(e.target.value) || 1))}
              className={`w-full ${fieldClass}`}
            />
          </div>
        )}
      </div>

      <div className={rowWrapper('')}>
        <label className="block text-xs text-dark-400 mb-1">
          If the previous run is not finished
        </label>
        <select
          value={onOverlap}
          onChange={e => onOverlapChange(e.target.value === 'spawn' ? 'spawn' : 'skip')}
          className={`w-full ${fieldClass}`}
        >
          <option value="skip">Skip this run (recommended)</option>
          <option value="spawn">Start it anyway (runs in parallel)</option>
        </select>
      </div>

      <div className={rowWrapper('flex gap-3 items-end')}>
        <div className="flex-1">
          <label className="block text-xs text-dark-400 mb-1">
            Delete finished runs after (days)
            <span className="text-[10px] text-dark-500 ml-1">— 0 = keep all</span>
          </label>
          <input
            type="number"
            min={0}
            max={3650}
            value={retentionDays}
            onChange={e =>
              onRetentionDaysChange(Math.max(0, Math.min(3650, parseInt(e.target.value) || 0)))
            }
            className={`w-full ${fieldClass}`}
          />
        </div>
        <div className="flex-1">
          <label className="block text-xs text-dark-400 mb-1">
            Keep only the last N runs
            <span className="text-[10px] text-dark-500 ml-1">— 0 = all</span>
          </label>
          <input
            type="number"
            min={0}
            max={1000}
            value={keepLast}
            onChange={e =>
              onKeepLastChange(Math.max(0, Math.min(1000, parseInt(e.target.value) || 0)))
            }
            className={`w-full ${fieldClass}`}
          />
        </div>
      </div>
    </>
  );
}
