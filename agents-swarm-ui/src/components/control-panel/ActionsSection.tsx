import React from 'react';
import { Trash2 } from 'lucide-react';
import { ClearButton } from './ClearButton';
import { useTasks } from '../../hooks/useTasks';

export function ActionsSection() {
  const { clearCompletedTasks, clearFailedTasks, clearInProgressTasks } = useTasks();

  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium">Actions</h3>
      <div className="flex flex-wrap gap-2">
        <ClearButton
          label="Clear Completed"
          confirmTitle="Clear completed tasks?"
          confirmDescription="This will remove all completed tasks from the list."
          onConfirm={clearCompletedTasks}
          icon={<Trash2 className="h-4 w-4" />}
        />
        <ClearButton
          label="Clear Failed"
          confirmTitle="Clear failed tasks?"
          confirmDescription="This will remove all failed tasks from the list."
          onConfirm={clearFailedTasks}
          icon={<Trash2 className="h-4 w-4" />}
        />
        <ClearButton
          label="Clear In Progress"
          confirmTitle="Clear in-progress tasks?"
          confirmDescription="This will remove all tasks currently in progress from the list."
          onConfirm={clearInProgressTasks}
          icon={<Trash2 className="h-4 w-4" />}
        />
      </div>
    </div>
  );
}