import { useState, useEffect } from 'react';
import {
  Trash2, X, Plus, Settings, ArrowRight, Zap, User,
  FolderKanban, Save, Check, Layers, Code, Loader2, ChevronLeft, ChevronRight,
} from 'lucide-react';
import { api } from '../../api';
import {
  AVAILABLE_COLORS, ACTION_OPTIONS, createAction, getActionKey, validTransition,
} from './taskConstants';

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
    const roles = [...new Set((agents || []).map(a => a.role).filter(Boolean))];
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
    const roles = [...new Set((agents || []).map(a => a.role).filter(Boolean))];
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

// ── Color picker (swatches instead of color names) ───────────────────────────

function ColorPicker({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const current = AVAILABLE_COLORS.find(c => c.hex === value);
  return (
    <div className="relative flex-shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="w-5 h-5 rounded border border-dark-500 cursor-pointer hover:ring-2 hover:ring-white/20"
        style={{ backgroundColor: value }}
        title={current ? `Color: ${current.label}` : 'Column color'}
      />
      {open && (
        <>
          {/* click-away catcher */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-7 z-20 flex gap-1.5 p-2 bg-dark-700 border border-dark-600 rounded-lg shadow-xl">
            {AVAILABLE_COLORS.map(c => (
              <button
                key={c.hex}
                type="button"
                onClick={() => { onChange(c.hex); setOpen(false); }}
                className={`w-5 h-5 rounded-full transition-transform hover:scale-110 ${
                  value === c.hex
                    ? 'ring-2 ring-white ring-offset-1 ring-offset-dark-700'
                    : 'ring-1 ring-dark-500'
                }`}
                style={{ backgroundColor: c.hex }}
                title={c.label}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── WorkflowEditor ──────────────────────────────────────────────────────────

export default function WorkflowEditor({ workflow, agents, onClose, onSave }) {
  const [cols, setCols] = useState(() => JSON.parse(JSON.stringify(workflow.columns)));
  const [transitions, setTransitions] = useState(() => {
    const raw = JSON.parse(JSON.stringify(workflow.transitions));
    return raw.filter(validTransition);
  });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [showJson, setShowJson] = useState(false);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState(null);

  const enabledAgents = (agents || []).filter(a => a.enabled !== false);
  const availableRoles = [...new Set<string>(enabledAgents.map(a => a.role).filter(Boolean))].sort();

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave({ columns: cols, transitions, version: workflow.version });
      onClose();
    } catch (err) {
      setSaveError(err?.message || 'Failed to save workflow');
    } finally {
      setSaving(false);
    }
  };

  // ── Column helpers ──
  // The column id stays stable on rename (only the label changes): existing
  // task statuses and change_status targets reference the id, so re-deriving
  // it from the label would strand them on a nonexistent column.
  const updateCol = (idx, patch) => setCols(prev => prev.map((c, i) => i === idx ? { ...c, ...patch } : c));
  const removeCol = (idx) => {
    const removed = cols[idx];
    setCols(prev => prev.filter((_, i) => i !== idx));
    setTransitions(prev => prev.filter(t => t.from !== removed.id));
  };
  const addCol = () => {
    setCols(prev => {
      const ids = new Set(prev.map(c => c.id));
      let id = 'new_step';
      let n = 2;
      while (ids.has(id)) id = `new_step_${n++}`;
      return [...prev, { id, label: 'New Step', color: '#6b7280' }];
    });
  };
  // ── Column reorder helper ──
  const moveCol = (idx: number, direction: -1 | 1) => {
    setCols(prev => {
      const targetIdx = idx + direction;
      if (targetIdx < 0 || targetIdx >= prev.length) return prev;
      const arr = [...prev];
      [arr[idx], arr[targetIdx]] = [arr[targetIdx], arr[idx]];
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
                <div key={idx} className="flex flex-col min-w-[240px] flex-1 relative">
                  {/* Column header card */}
                  <div className="bg-dark-800 rounded-lg px-3 py-2.5 space-y-2">
                    <div className="flex items-center gap-1">
                      <button onClick={() => moveCol(idx, -1)} disabled={idx === 0}
                        className="p-0.5 text-dark-400 hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-dark-400 flex-shrink-0"
                        title="Move column left">
                        <ChevronLeft className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => moveCol(idx, 1)} disabled={idx === cols.length - 1}
                        className="p-0.5 text-dark-400 hover:text-indigo-400 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-dark-400 flex-shrink-0"
                        title="Move column right">
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>
                      <ColorPicker value={col.color} onChange={hex => updateCol(idx, { color: hex })} />
                      <input value={col.label} onChange={e => updateCol(idx, { label: e.target.value })}
                        className="flex-1 bg-transparent text-sm font-medium text-dark-200 outline-none min-w-0" placeholder="Column name" />
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
                      onChange={e => updateTransition(idx, { trigger: e.target.value })}
                      className="w-full px-2 py-1 bg-dark-700 border border-dark-600 rounded text-xs text-dark-200">
                      <option value="on_enter">On enter (immediate)</option>
                      <option value="condition">When conditions met (periodic)</option>
                    </select>
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
                              {ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
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

                            {/* Agent selector for assign_agent_individual */}
                            {action.type === 'assign_agent_individual' && (
                              <select value={action.agentId || ''}
                                onChange={e => updateAction(idx, ai, { agentId: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">None (unassign)</option>
                                {enabledAgents.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                              </select>
                            )}

                            {/* Target status for change_status */}
                            {action.type === 'change_status' && (
                              <select value={action.target || ''}
                                onChange={e => updateAction(idx, ai, { target: e.target.value })}
                                className="px-1.5 py-0.5 bg-dark-700 border border-dark-600 rounded text-[10px] text-dark-200">
                                <option value="">Select status...</option>
                                <option value="__next__">→ Next column (auto)</option>
                                {cols.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
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
          <div className="flex items-center gap-2">
            {saveError && (
              <span className="text-xs text-red-400 max-w-[40vw] truncate" title={saveError}>{saveError}</span>
            )}
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
