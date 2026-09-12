import { getTasksByBoard, getTaskTemplates, updateTaskFields } from '../database.js';
import { emitTaskUpdated } from '../taskMutations.js';
import type { AgentManager } from '../agentManager/index.js';
import type { ColumnRename } from './columnIds.js';

export async function applyColumnRenamesToBoardTasks(
  agentManager: AgentManager,
  boardId: string,
  renames: ColumnRename[],
  by: string
) {
  if (!renames.length) return;

  const renameMap = new Map(renames.map(r => [r.from, r.to]));
  const [tasks, templates] = await Promise.all([
    getTasksByBoard(boardId),
    getTaskTemplates(boardId),
  ]);
  const now = new Date().toISOString();

  for (const task of tasks) {
    const nextStatus = renameMap.get(task.status);
    const nextErrorFromStatus = task.errorFromStatus
      ? renameMap.get(task.errorFromStatus)
      : undefined;
    if (!nextStatus && !nextErrorFromStatus) continue;

    const history = Array.isArray(task.history) ? [...task.history] : [];
    if (nextStatus) {
      history.push({
        at: now,
        by,
        type: 'workflow_column_rename',
        from: task.status,
        status: nextStatus,
      });
    }

    const fields: Record<string, unknown> = { history };
    if (nextStatus) fields.status = nextStatus;
    if (nextErrorFromStatus) fields.errorFromStatus = nextErrorFromStatus;

    const updated = await updateTaskFields(task.id, fields);
    if (!updated) throw new Error(`Failed to migrate task ${task.id} to its renamed column`);
    emitTaskUpdated(agentManager, updated);
  }

  // Rules are not returned by the task listing. Their future runs must also
  // enter the renamed column, without resetting cadence or occurrence counters.
  for (const template of templates) {
    const originalStatus = template.recurrence?.originalStatus;
    const next = originalStatus ? renameMap.get(originalStatus) : undefined;
    if (!next) continue;
    const updated = await updateTaskFields(template.id, {
      status: renameMap.get(template.status) || template.status,
      recurrence: { ...template.recurrence, originalStatus: next },
    });
    if (!updated) throw new Error(`Failed to migrate recurring rule ${template.id}`);
  }
}
