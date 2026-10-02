// ─── The task an agent is working on right now ──────────────────────────────
//
// Used when an agent calls update_task (gateway MCP, native tool) without a
// task id, to decide which task its summary, commits and column move belong to.
// Getting this wrong lands an agent's work on somebody else's card, so only
// facts are trusted:
//   1. the run this process is executing for the agent (in-process reservation);
//   2. the agent's run claim in the database (this environment only — the
//      sibling stack sharing the database runs its own tasks with the same
//      agents);
//   3. otherwise, an active task assigned to it — but only when there is
//      exactly ONE. "The oldest active task it is assigned to or owns" picked
//      the board container agent's oldest todo card for every agent call made
//      outside a live run.
import { getTaskById, getTaskByActionRunningAgent, getTasksByAssignee } from '../database.js';
import { getAgentRunningTaskId } from '../workflow/agentSelector.js';
import { getCurrentEnvironment } from '../../lib/environment.js';
import type { Task } from '../database/tasks.js';

export async function resolveAgentCurrentTask(
  agentManager: { _isActiveTaskStatus(status: string): boolean },
  agentId: string
): Promise<Task | null> {
  const env = getCurrentEnvironment();
  const inEnv = (t: Task) => (t.environment || 'prod') === env;

  const reservedId = getAgentRunningTaskId(agentId);
  if (reservedId) {
    const reserved = await getTaskById(reservedId);
    if (reserved && !reserved.isTemplate) return reserved;
  }

  const running = await getTaskByActionRunningAgent(agentId, env);
  if (running && agentManager._isActiveTaskStatus(running.status)) return running;

  const candidates = (await getTasksByAssignee(agentId)).filter(
    t => inEnv(t) && agentManager._isActiveTaskStatus(t.status)
  );
  return candidates.length === 1 ? candidates[0] : null;
}
