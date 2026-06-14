import { RECURRENCE_PERIODS } from './taskConstants';

// Shared recurrence editor fields — period select, custom-minutes input,
// purge-after-days input — used by TaskDetailModal (teal accent) and
// CreateTaskModal (indigo accent). Each modal keeps its own enable-checkbox
// wrapper; `rowClass` lets CreateTaskModal preserve its mt-3 spacing.
export default function RecurrenceFields({
  period, onPeriodChange,
  customInterval, onCustomIntervalChange,
  retentionDays, onRetentionDaysChange,
  focusClass = 'focus:border-indigo-500',
  rowClass = '',
}) {
  const fieldClass = `px-3 py-2 bg-dark-800 border border-dark-700 rounded-lg text-sm text-dark-200 focus:outline-none ${focusClass} transition-colors`;
  return (
    <>
      <div className={rowClass ? `${rowClass} flex gap-3 items-end` : 'flex gap-3 items-end'}>
        <div className="flex-1">
          <label className="block text-xs text-dark-400 mb-1">Period</label>
          <select
            value={period}
            onChange={e => onPeriodChange(e.target.value)}
            className={`w-full ${fieldClass}`}
          >
            {RECURRENCE_PERIODS.map(p => (
              <option key={p.value} value={p.value}>{p.label}</option>
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
      <div className={rowClass || undefined}>
        <label className="block text-xs text-dark-400 mb-1">
          Purge history after (days)
          <span className="text-[10px] text-dark-500 ml-1">— 0 = keep everything</span>
        </label>
        <input
          type="number"
          min={0}
          max={3650}
          value={retentionDays}
          onChange={e => onRetentionDaysChange(Math.max(0, Math.min(3650, parseInt(e.target.value) || 0)))}
          className={`w-32 ${fieldClass}`}
        />
      </div>
    </>
  );
}
