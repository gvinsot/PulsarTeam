import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Play, Square, Trash2, RefreshCw, AlertTriangle, CheckCircle2, Clock3, Loader2, Radio } from 'lucide-react';
import { apiService } from '../services/api';

const STATUS_STYLES = {
  pending: 'bg-slate-500/20 text-slate-300 border-slate-500/30',
  in_progress: 'bg-blue-500/20 text-blue-300 border-blue-500/30',
  completed: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
  failed: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
};

const STATUS_ICONS = {
  pending: Clock3,
  in_progress: Loader2,
  completed: CheckCircle2,
  failed: AlertTriangle,
};

function ConfirmDialog({ open, title, description, confirmLabel = 'Confirm', cancelLabel = 'Cancel', onConfirm, onCancel }) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-dark-600 bg-dark-800 p-4 shadow-2xl">
        <h4 className="text-base font-semibold text-dark-100">{title}</h4>
        <p className="mt-2 text-sm text-dark-300">{description}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-lg border border-dark-600 px-3 py-1.5 text-sm text-dark-200 hover:bg-dark-700"
          >
            {cancelLabel}
          </button>
          <button
            onClick={onConfirm}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-500"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function ActionButton({ icon: Icon, label, onClick, variant = 'default', disabled = false }) {
  const base = 'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition disabled:opacity-50 disabled:cursor-not-allowed';
  const styles =
    variant === 'danger'
      ? 'border-red-500/40 bg-red-500/10 text-red-300 hover:bg-red-500/20'
      : 'border-dark-600 bg-dark-700/60 text-dark-100 hover:bg-dark-700';

  return (
    <button className={`${base} ${styles}`} onClick={onClick} disabled={disabled}>
      <Icon className="h-4 w-4" />
      {label}
    </button>
  );
}

export default function BroadcastPanel() {
  const [tasks, setTasks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirmState, setConfirmState] = useState({ open: false, action: null });

  const pollRef = useRef(null);

  const fetchTasks = async () => {
    try {
      setLoading(true);
      const data = await apiService.getTasks();
      setTasks(Array.isArray(data) ? data : []);
    } catch (e) {
      console.error('Failed to fetch tasks', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTasks();
  }, []);

  useEffect(() => {
    if (running) {
      pollRef.current = setInterval(fetchTasks, 2000);
    } else if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [running]);

  const groupedCounts = useMemo(() => {
    return tasks.reduce(
      (acc, t) => {
        const s = t.status || 'pending';
        acc[s] = (acc[s] || 0) + 1;
        return acc;
      },
      { pending: 0, in_progress: 0, completed: 0, failed: 0 }
    );
  }, [tasks]);

  const openConfirm = (action) => setConfirmState({ open: true, action });
  const closeConfirm = () => setConfirmState({ open: false, action: null });

  const clearCompleted = async () => {
    await apiService.clearTasksByStatus('completed');
    await fetchTasks();
  };

  const clearFailed = async () => {
    await apiService.clearTasksByStatus('failed');
    await fetchTasks();
  };

  const clearInProgress = async () => {
    await apiService.clearTasksByStatus('in_progress');
    await fetchTasks();
  };

  const confirmConfig = {
    clearCompleted: {
      title: 'Clear completed tasks?',
      description: 'This will remove all completed tasks from the list.',
      run: clearCompleted,
    },
    clearFailed: {
      title: 'Clear failed tasks?',
      description: 'This will remove all failed tasks from the list.',
      run: clearFailed,
    },
    clearInProgress: {
      title: 'Clear in-progress tasks?',
      description: 'This will remove all tasks currently in progress from the list.',
      run: clearInProgress,
    },
  };

  const currentConfirm = confirmState.action ? confirmConfig[confirmState.action] : null;

  return (
    <div className="rounded-xl border border-dark-700 bg-dark-900/70 p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-semibold text-dark-100 text-sm">Control Panel</h3>
        <div className="flex items-center gap-2">
          <ActionButton icon={RefreshCw} label="Refresh" onClick={fetchTasks} disabled={loading} />
          {!running ? (
            <ActionButton icon={Play} label="Start" onClick={() => setRunning(true)} />
          ) : (
            <ActionButton icon={Square} label="Stop" onClick={() => setRunning(false)} />
          )}
        </div>
      </div>

      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-4">
        {Object.entries(groupedCounts).map(([status, count]) => {
          const Icon = STATUS_ICONS[status] || Clock3;
          const spin = status === 'in_progress' ? 'animate-spin' : '';
          return (
            <div key={status} className={`rounded-lg border px-3 py-2 text-xs ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
              <div className="flex items-center gap-2">
                <Icon className={`h-3.5 w-3.5 ${spin}`} />
                <span className="capitalize">{status.replace('_', ' ')}</span>
              </div>
              <div className="mt-1 text-base font-semibold">{count}</div>
            </div>
          );
        })}
      </div>

      <div className="space-y-2">
        <h4 className="text-xs uppercase tracking-wide text-dark-400">Actions</h4>
        <div className="flex flex-wrap gap-2">
          <ActionButton icon={Trash2} label="Clear Completed" variant="danger" onClick={() => openConfirm('clearCompleted')} />
          <ActionButton icon={Trash2} label="Clear Failed" variant="danger" onClick={() => openConfirm('clearFailed')} />
          <ActionButton icon={Trash2} label="Clear In Progress" variant="danger" onClick={() => openConfirm('clearInProgress')} />
        </div>
      </div>

      <div className="mt-4 max-h-72 overflow-auto rounded-lg border border-dark-700">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-dark-800">
            <tr className="text-dark-300">
              <th className="px-3 py-2 font-medium">Task</th>
              <th className="px-3 py-2 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const status = task.status || 'pending';
              const Icon = STATUS_ICONS[status] || Clock3;
              return (
                <tr key={task.id} className="border-t border-dark-700/80">
                  <td className="px-3 py-2 text-dark-100">{task.title || task.id}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs ${STATUS_STYLES[status] || STATUS_STYLES.pending}`}>
                      <Icon className={`h-3 w-3 ${status === 'in_progress' ? 'animate-spin' : ''}`} />
                      {status}
                    </span>
                  </td>
                </tr>
              );
            })}
            {tasks.length === 0 && (
              <tr>
                <td colSpan={2} className="px-3 py-6 text-center text-dark-400">
                  <div className="inline-flex items-center gap-2">
                    <Radio className="h-4 w-4" />
                    No tasks
                  </div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmState.open}
        title={currentConfirm?.title || ''}
        description={currentConfirm?.description || ''}
        confirmLabel="Clear"
        cancelLabel="Cancel"
        onCancel={closeConfirm}
        onConfirm={async () => {
          if (currentConfirm?.run) {
            await currentConfirm.run();
          }
          closeConfirm();
        }}
      />
    </div>
  );
}