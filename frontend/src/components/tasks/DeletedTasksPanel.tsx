import { useState, useEffect, useMemo } from 'react';
import { Trash2, X, Loader2, RotateCcw, Archive, ChevronLeft, ChevronRight } from 'lucide-react';
import { getDeletedTasks, restoreTask as restoreTaskApi, hardDeleteTask as hardDeleteTaskApi } from '../../api';

const PAGE_SIZE = 20;

export default function DeletedTasksPanel({ onClose, onRestored }) {
  const [deletedTasks, setDeletedTasks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);
  const [page, setPage] = useState(1);

  const totalPages = Math.max(1, Math.ceil(deletedTasks.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pagedTasks = useMemo(
    () => deletedTasks.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [deletedTasks, currentPage]
  );

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const tasks = await getDeletedTasks();
        if (!cancelled) setDeletedTasks(tasks);
      } catch (err) {
        console.error('Failed to load deleted tasks:', err.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const handleRestore = async (taskId) => {
    setActionLoading(taskId);
    try {
      await restoreTaskApi(taskId);
      setDeletedTasks(prev => prev.filter(t => t.id !== taskId));
      onRestored();
    } catch (err) {
      console.error('Failed to restore task:', err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleHardDelete = async (taskId) => {
    setActionLoading(taskId);
    try {
      await hardDeleteTaskApi(taskId);
      setDeletedTasks(prev => prev.filter(t => t.id !== taskId));
      setConfirmDelete(null);
    } catch (err) {
      console.error('Failed to permanently delete task:', err.message);
    } finally {
      setActionLoading(null);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-dark-900 border border-dark-700 rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col shadow-2xl"
           onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-dark-700">
          <div className="flex items-center gap-2">
            <Archive className="w-4 h-4 text-dark-400" />
            <h2 className="text-sm font-semibold text-dark-200">Deleted Tasks</h2>
            <span className="text-xs text-dark-500">({deletedTasks.length})</span>
          </div>
          <button onClick={onClose} className="p-1 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-dark-400 animate-spin" />
            </div>
          ) : deletedTasks.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-dark-500">
              <Trash2 className="w-8 h-8 mb-2 opacity-30" />
              <span className="text-sm">No deleted tasks</span>
            </div>
          ) : (
            <div className="space-y-2">
              {pagedTasks.map(task => (
                <div key={task.id}
                  className="flex items-center justify-between px-4 py-3 bg-dark-800 border border-dark-700 rounded-lg hover:border-dark-600 transition-colors">
                  <div className="flex-1 min-w-0 mr-4">
                    <p className="text-sm text-dark-200 truncate">{task.text || task.title || 'Untitled'}</p>
                    <div className="flex items-center gap-3 mt-1">
                      {task.project && (
                        <span className="text-xs text-indigo-400/70">{task.project}</span>
                      )}
                      {task.deletedAt && (
                        <span className="text-xs text-dark-500">
                          Deleted {new Date(task.deletedAt).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 flex-shrink-0">
                    {/* Restore button */}
                    <button
                      onClick={() => handleRestore(task.id)}
                      disabled={actionLoading === task.id}
                      className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-emerald-400
                        bg-emerald-500/10 border border-emerald-500/20 rounded-lg
                        hover:bg-emerald-500/20 transition-colors disabled:opacity-50"
                      title="Restore task"
                    >
                      {actionLoading === task.id ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <RotateCcw className="w-3 h-3" />
                      )}
                      Restore
                    </button>
                    {/* Permanent delete button */}
                    {confirmDelete === task.id ? (
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleHardDelete(task.id)}
                          disabled={actionLoading === task.id}
                          className="px-2 py-1.5 text-xs font-medium text-red-400
                            bg-red-500/20 border border-red-500/30 rounded-lg
                            hover:bg-red-500/30 transition-colors disabled:opacity-50"
                        >
                          {actionLoading === task.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : 'Confirm'}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(null)}
                          className="px-2 py-1.5 text-xs text-dark-400 hover:text-dark-200
                            bg-dark-700 rounded-lg hover:bg-dark-600 transition-colors"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setConfirmDelete(task.id)}
                        className="flex items-center gap-1 px-2.5 py-1.5 text-xs text-red-400/70
                          hover:text-red-400 hover:bg-red-500/10 rounded-lg transition-colors"
                        title="Delete permanently"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Pagination footer */}
        {!loading && deletedTasks.length > PAGE_SIZE && (
          <div className="flex items-center justify-between px-6 py-3 border-t border-dark-700">
            <span className="text-xs text-dark-500">
              Showing {(currentPage - 1) * PAGE_SIZE + 1}–
              {Math.min(currentPage * PAGE_SIZE, deletedTasks.length)} of {deletedTasks.length}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(p => Math.max(1, p - 1))}
                disabled={currentPage === 1}
                className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700
                  transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                title="Previous page"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <span className="text-xs text-dark-400 px-2">
                Page {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                disabled={currentPage === totalPages}
                className="p-1.5 rounded-lg text-dark-400 hover:text-dark-200 hover:bg-dark-700
                  transition-colors disabled:opacity-30 disabled:hover:bg-transparent"
                title="Next page"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
