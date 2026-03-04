import { useCallback } from 'react';
import { useTaskStore } from '../store/tasks';

export function useTasks() {
  const clearCompletedTasks = useTaskStore((s) => s.clearCompletedTasks);
  const clearFailedTasks = useTaskStore((s) => s.clearFailedTasks);
  const clearInProgressTasks = useTaskStore((s) => s.clearInProgressTasks);

  return {
    clearCompletedTasks: useCallback(() => clearCompletedTasks(), [clearCompletedTasks]),
    clearFailedTasks: useCallback(() => clearFailedTasks(), [clearFailedTasks]),
    clearInProgressTasks: useCallback(() => clearInProgressTasks(), [clearInProgressTasks]),
  };
}