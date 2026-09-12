import type { AgentManager } from './agentManager/index.js';
import type { Task } from './database/tasks.js';
import { updateTaskFields } from './database.js';
import { setTaskSignal } from './agentManager/tasks.js';
import { isCliRunner } from './runners.js';
import { errorMessage } from '../lib/errors.js';
import { emitTaskUpdated } from './taskMutations.js';
import { getAgentRunningTaskId } from './workflow/agentSelector.js';

function requestTaskCliInterrupt(mgr: AgentManager, task: Task): void {
  const executorId = task.actionRunningAgentId || task.assignee || task.agentId;
  if (!executorId || !mgr?.executionManager) return;
  const executor = mgr.agents.get(executorId);
  const provider = mgr.executionManager.getProviderType?.(executorId);
  if (executor && !isCliRunner(executor) && (!provider || provider === 'sandbox')) return;
  const interrupt =
    mgr.executionManager.interruptCliTerminalSessions ||
    mgr.executionManager.interruptTerminalSession;
  if (!interrupt) return;
  Promise.resolve(interrupt.call(mgr.executionManager, executorId))
    .then((sent: boolean) => {
      if (sent) {
        console.log(
          `🛑 [Execution] Sent CLI interrupt to task executor ${executor?.name || executorId}`
        );
      }
    })
    .catch((err: unknown) => {
      console.warn(
        `⚠️ [Execution] CLI interrupt failed for task executor ${executorId}: ${errorMessage(err)}`
      );
    });
}

/** Caller must authorize the task and its live executor before calling. */
export async function stopTaskExecution(mgr: AgentManager, task: Task, by: string) {
  const executorId = task.actionRunningAgentId || task.assignee || task.agentId;
  const reservedTask = executorId ? getAgentRunningTaskId(executorId) : null;
  // A stale assignment must never interrupt a different task on that agent.
  if (
    (!reservedTask || reservedTask === task.id) &&
    (task.actionRunning || task.startedAt || reservedTask === task.id)
  ) {
    requestTaskCliInterrupt(mgr, task);
    if (executorId) mgr.abortControllers?.get(executorId)?.abort();
  }
  setTaskSignal(task.id, 'stopped', true);
  const updated = await updateTaskFields(task.id, {
    actionRunning: false,
    actionRunningAgentId: null,
    actionRunningMode: null,
    executionStatus: 'stopped',
    startedAt: null,
    history: [
      ...(task.history || []),
      {
        at: new Date().toISOString(),
        by,
        type: 'stopped',
        status: task.status,
      },
    ],
  });
  if (!updated) throw new Error('Failed to persist task stop');
  emitTaskUpdated(mgr, updated);
  return updated;
}
