import type { AgentManager } from './agentManager/index.js';
import type { Task } from './database/tasks.js';
import { updateTaskFields, markTaskCommitRunEnded } from './database.js';
import { getCurrentEnvironment } from '../lib/environment.js';
import { setTaskSignal } from './agentManager/tasks.js';
import { isCliRunner } from './runners.js';
import { errorMessage } from '../lib/errors.js';
import { emitTaskUpdated } from './taskMutations.js';
import { getAgentRunningTaskId } from './workflow/agentSelector.js';

function requestTaskCliInterrupt(mgr: AgentManager, task: Task): void {
  const executorId = task.actionRunningAgentId || task.assignee;
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
  // The executor is whoever holds the run claim (every run claims its task); an
  // assignee without a claim only counts if this process is running it. The
  // owner is never interrupted on the task's behalf: it may be working on
  // something else entirely.
  const executorId = task.actionRunningAgentId || task.assignee || null;
  const reservedTask = executorId ? getAgentRunningTaskId(executorId) : null;
  // Judged on the task as the caller saw it, before the write below clears it.
  const wasRunning = !!task.actionRunning;
  const interruptTarget = { ...task };
  // Persist the stop FIRST: the run's wait reacts to the signal below by ending
  // and clearing its 'watching' status, and must find 'stopped' already there.
  const updated = await updateTaskFields(task.id, {
    actionRunning: false,
    actionRunningAgentId: null,
    actionRunningMode: null,
    actionHeartbeatAt: null,
    executionStatus: 'stopped',
    startedAt: null,
    historyAppend: [
      {
        at: new Date().toISOString(),
        by,
        type: 'stopped',
        status: task.status,
      },
    ],
  });
  if (!updated) throw new Error('Failed to persist task stop');
  // The run's commit window closes here; a run that died with it is recovered
  // by the commit sweeper up to this point.
  await markTaskCommitRunEnded(task.id);
  // A stale assignment must never interrupt a different task on that agent. Nor
  // may a task of the sibling stack: its run lives there (it sees the persisted
  // Stop on its next poll), and this stack's terminal of that agent is busy with
  // something else, if anything.
  const ownRun = (task.environment || 'prod') === getCurrentEnvironment();
  if (
    ownRun &&
    (!reservedTask || reservedTask === task.id) &&
    (wasRunning || reservedTask === task.id)
  ) {
    requestTaskCliInterrupt(mgr, interruptTarget);
    if (executorId) mgr.abortControllers?.get(executorId)?.abort();
  }
  setTaskSignal(task.id, 'stopped', true);
  emitTaskUpdated(mgr, updated);
  return updated;
}
