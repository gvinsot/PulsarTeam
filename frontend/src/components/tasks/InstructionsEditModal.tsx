import { useState, useMemo } from 'react';
import { X, Edit3, User, Loader2, Save } from 'lucide-react';

export default function InstructionsEditModal({ columnLabel, instructions, agents, onClose, onSave }) {
  const [items, setItems] = useState(() => instructions.map(i => ({ ...i })));
  const [label, setLabel] = useState(columnLabel || '');
  const [saving, setSaving] = useState(false);

  const roles = useMemo(() => [...new Set((agents || []).filter(a => a.enabled !== false).map(a => a.role).filter(Boolean))].sort(), [agents]);

  const updateField = (idx, field, value) => setItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(items, label);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="w-[900px] max-h-[90vh] bg-dark-900 border border-dark-700 rounded-2xl shadow-2xl flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Edit3 className="w-4 h-4 text-indigo-400" />
            <span className="text-sm font-semibold text-dark-100">Instructions —</span>
            <input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder="Column name"
              title="Column name"
              className="text-sm font-semibold text-dark-100 bg-dark-800 border border-dark-700 rounded px-2 py-1 outline-none focus:border-indigo-500 transition-colors"
            />
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
                className="w-full bg-dark-800 border border-dark-600 rounded-lg px-3 py-2.5 text-sm text-dark-200 placeholder-dark-500 resize-y min-h-[180px] focus:outline-none focus:border-indigo-500 transition-colors"
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
