import { create } from 'zustand';

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
}

interface TaskState {
  tasks: Task[];
  clearCompletedTasks: () => void;
  clearFailedTasks: () => void;
  clearInProgressTasks: () => void;
}

export const useTaskStore = create<TaskState>((set) => ({
  tasks: [],
  clearCompletedTasks: () =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.status !== 'completed'),
    })),
  clearFailedTasks: () =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.status !== 'failed'),
    })),
  clearInProgressTasks: () =>
    set((state) => ({
      tasks: state.tasks.filter((task) => task.status !== 'in_progress'),
    })),
}));