// ─── Cloud storage changes made by a task ───────────────────────────────────
//
// The Google Drive and OneDrive MCP write tools (upload_file, create_folder,
// delete_item) call recordTaskStorageChange after a successful write. The
// write is put on the task the agent is RUNNING at that moment — the
// in-process reservation, else the agent's run claim in this environment —
// and nothing else: outside a live run there is no fact tying a Drive write to
// a card, and guessing would show one task's files on another.
//
// Recording is best effort: it never fails the tool call that triggered it.
import { appendTaskStorageChange, getTaskByActionRunningAgent, getTaskById } from './database.js';
import { getAgentRunningTaskId } from './workflow/agentSelector.js';
import { getCurrentEnvironment } from '../lib/environment.js';
import { errorMessage } from '../lib/errors.js';
import type { Task, TaskStorageChange } from './database/tasks.js';

export type StorageChangeInput = Omit<TaskStorageChange, 'count' | 'at' | 'agentId'>;

type TaskUpdatedNotifier = (task: Task) => void;
let notifyTaskUpdated: TaskUpdatedNotifier | null = null;

/** index.ts wires this to emitTaskUpdated so open task modals refresh live. */
export function setStorageChangeNotifier(notifier: TaskUpdatedNotifier | null) {
  notifyTaskUpdated = notifier;
}

/** The task an agent is running right now, or null outside a run. */
export async function resolveRunningTask(agentId: string): Promise<Task | null> {
  const reservedId = getAgentRunningTaskId(agentId);
  if (reservedId) {
    const reserved = await getTaskById(reservedId);
    if (reserved && !reserved.isTemplate) return reserved;
  }
  return getTaskByActionRunningAgent(agentId, getCurrentEnvironment());
}

/** Join a Drive parent path and an item name into "/parent/name". */
export function joinStoragePath(parentPath: string | null | undefined, name: string) {
  const parent = (parentPath || '/').replace(/\/+$/, '');
  return `${parent.startsWith('/') ? parent : `/${parent}`}/${name}`.replace(/^\/\//, '/');
}

/**
 * Record one Drive/OneDrive write against the agent's running task. Returns
 * the updated task, or null when nothing was recorded (no agent, no live run,
 * DB unavailable or failing).
 */
export async function recordTaskStorageChange(
  agentId: string | null,
  change: StorageChangeInput
): Promise<Task | null> {
  if (!agentId) return null;
  try {
    const task = await resolveRunningTask(agentId);
    if (!task) return null;
    const updated = await appendTaskStorageChange(task.id, {
      ...change,
      agentId,
      at: new Date().toISOString(),
    });
    if (updated) notifyTaskUpdated?.(updated);
    return updated;
  } catch (err) {
    console.warn(
      `⚠️ [StorageChanges] Could not record ${change.provider} ${change.action} of "${change.path}": ${errorMessage(err)}`
    );
    return null;
  }
}
