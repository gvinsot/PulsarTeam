import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useI18n } from '../i18n';

interface WorkflowColumn {
  id: string;
  title: string;
  position: number;
  color?: string | null;
}

const COLOR_PRESETS = [
  { value: '#9aa0a6', label: 'Gray' },
  { value: '#5b9bff', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#eab308', label: 'Yellow' },
  { value: '#f97316', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#a855f7', label: 'Purple' },
  { value: '#06b6d4', label: 'Cyan' },
  { value: '#ec4899', label: 'Pink' },
];

function ColumnColorSelect({ value, onChange, ariaLabel }: { value?: string | null; onChange: (v: string) => void; ariaLabel?: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const current = value || COLOR_PRESETS[0].value;
  const selectedLabel = COLOR_PRESETS.find((c) => c.value.toLowerCase() === current.toLowerCase())?.label || current;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="color-picker" ref={wrapRef}>
      <button
        type="button"
        className="color-picker-btn"
        aria-label={ariaLabel ? `${ariaLabel}: ${selectedLabel}` : `Color: ${selectedLabel}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="color-swatch lg" style={{ background: current }} />
      </button>
      {open && (
        <div className="color-picker-popover" role="listbox">
          {COLOR_PRESETS.map((c) => {
            const isSelected = c.value.toLowerCase() === current.toLowerCase();
            return (
              <button
                key={c.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                aria-label={c.label}
                title={c.label}
                className={`color-picker-option${isSelected ? ' selected' : ''}`}
                onClick={() => { onChange(c.value); setOpen(false); }}
              >
                <span className="color-swatch lg" style={{ background: c.value }} />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export default function AdminWorkflows() {
  const { t } = useI18n();
  const [columns, setColumns] = useState<WorkflowColumn[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');
  const [newColor, setNewColor] = useState<string>(COLOR_PRESETS[0].value);

  useEffect(() => {
    void loadColumns();
  }, []);

  const loadColumns = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.getWorkflowColumns();
      setColumns(data);
    } catch (e: any) {
      setError(e?.message || 'Failed to load workflow');
    } finally {
      setLoading(false);
    }
  };

  const onAdd = async () => {
    const title = newTitle.trim();
    if (!title) return;
    try {
      await api.createWorkflowColumn({ title, color: newColor });
      setNewTitle('');
      setNewColor(COLOR_PRESETS[0].value);
      await loadColumns();
    } catch (e: any) {
      setError(e?.message || 'Failed to add column');
    }
  };

  const onRename = async (id: string, title: string) => {
    setSavingId(id);
    try {
      await api.updateWorkflowColumn(id, { title });
      await loadColumns();
    } catch (e: any) {
      setError(e?.message || 'Failed to rename column');
    } finally {
      setSavingId(null);
    }
  };

  const onChangeColor = async (id: string, color: string) => {
    setSavingId(id);
    try {
      await api.updateWorkflowColumn(id, { color });
      await loadColumns();
    } catch (e: any) {
      setError(e?.message || 'Failed to update color');
    } finally {
      setSavingId(null);
    }
  };

  const onMove = async (id: string, dir: -1 | 1) => {
    const idx = columns.findIndex((c) => c.id === id);
    if (idx < 0) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= columns.length) return;
    const reordered = [...columns];
    const [item] = reordered.splice(idx, 1);
    reordered.splice(newIdx, 0, item);
    setColumns(reordered);
    try {
      await api.reorderWorkflowColumns(reordered.map((c) => c.id));
    } catch (e: any) {
      setError(e?.message || 'Failed to reorder');
      await loadColumns();
    }
  };

  const onRemove = async (id: string) => {
    if (!confirm('Delete this column?')) return;
    try {
      await api.deleteWorkflowColumn(id);
      await loadColumns();
    } catch (e: any) {
      setError(e?.message || 'Failed to delete column');
    }
  };

  if (loading) return <div className="muted">{t('boardSettings.loadingWorkflow')}</div>;

  return (
    <div className="admin-workflows">
      {error && <div className="error-banner">{error}</div>}
      <h3>{t('boardSettings.workflowSection')}</h3>
      <p className="muted small">{t('boardSettings.workflowSubtitle')}</p>

      <div className="workflow-add">
        <input
          type="text"
          placeholder={t('boardSettings.newColumnPlaceholder')}
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="input"
        />
        <ColumnColorSelect value={newColor} onChange={setNewColor} ariaLabel="New column color" />
        <button onClick={onAdd} className="btn primary">{t('boardSettings.addColumn')}</button>
      </div>

      <ul className="workflow-list">
        {columns.map((c, idx) => (
          <li key={c.id} className="workflow-item">
            <span className="color-swatch" style={{ background: c.color || '#9aa0a6' }} aria-hidden />
            <input
              type="text"
              defaultValue={c.title}
              onBlur={(e) => {
                const v = e.target.value.trim();
                if (v && v !== c.title) onRename(c.id, v);
              }}
              className="input"
              disabled={savingId === c.id}
            />
            <ColumnColorSelect value={c.color || ''} onChange={(v) => onChangeColor(c.id, v)} ariaLabel={`Color for ${c.title}`} />
            <button onClick={() => onMove(c.id, -1)} disabled={idx === 0} className="btn">↑</button>
            <button onClick={() => onMove(c.id, 1)} disabled={idx === columns.length - 1} className="btn">↓</button>
            <button onClick={() => onRemove(c.id)} className="btn danger">{t('common.delete')}</button>
          </li>
        ))}
      </ul>
    </div>
  );
}