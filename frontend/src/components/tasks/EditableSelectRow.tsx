import { useState } from 'react';
import { X, Edit3 } from 'lucide-react';

// Inline-edit metadata row for TaskDetailModal: icon + label on the left;
// view mode renders the `view` badge plus an Edit3 pencil (or
// `pencilReplacement` when the underlying picker is unavailable); edit mode
// renders an autoFocus uncontrolled select that saves on change.
// `onSave` receives `e.target.value || null`. It may resolve without calling
// the API (no-op guard) — the editor still closes. If it throws, the editor
// stays open so the user can retry (the wrapper surfaces the error message).
export default function EditableSelectRow({
  icon: Icon,
  label,
  value,
  options,
  emptyOptionLabel = 'None',
  onSave,
  view,
  selectClassName,
  disableWhenEmpty = false,
  editTitle,
  pencilHoverClass = 'hover:text-indigo-400',
  pencilReplacement = null,
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <div className="flex items-center justify-between py-2 border-b border-dark-800">
      <div className="flex items-center gap-2 text-xs text-dark-400">
        <Icon className="w-3.5 h-3.5" />
        {label}
      </div>
      {editing ? (
        <div className="flex items-center gap-1.5">
          <select
            autoFocus
            defaultValue={value}
            onChange={async e => {
              setSaving(true);
              try {
                await onSave(e.target.value || null);
                setEditing(false);
              } catch {
                // error already surfaced by the onSave wrapper
              } finally {
                setSaving(false);
              }
            }}
            disabled={saving || (disableWhenEmpty && options.length === 0)}
            className={selectClassName}
          >
            <option value="">{emptyOptionLabel}</option>
            {options.map(o => (
              <option key={o.key ?? o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <button
            onClick={() => setEditing(false)}
            className="p-0.5 rounded text-dark-500 hover:text-dark-300 hover:bg-dark-700 transition-colors"
            title="Cancel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          {view}
          {pencilReplacement || (
            <button
              onClick={() => setEditing(true)}
              className={`p-0.5 rounded text-dark-500 ${pencilHoverClass} hover:bg-dark-700 transition-colors`}
              title={editTitle}
            >
              <Edit3 className="w-3 h-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
