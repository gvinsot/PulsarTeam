// ── Task attachments → the executing runner ─────────────────────────────────
//
// Called right after the workspace is prepared, on both task paths (the task
// loop in agentManager/tasks.ts and the workflow decide action). The runner
// keeps `$HOME/task-files/<taskId>/` in step with the task's attachments:
// detached files are pruned, and only the files it lacks (or holds with other
// content) are sent, one at a time, so a resumed task costs one round-trip.
//
// A delivery failure throws: an agent silently working without the files the
// user attached would produce the wrong result with no hint why.

import { listTaskAttachments, getTaskAttachmentData } from '../database/taskAttachments.js';
import type { MaterializedAttachment, TaskAttachment } from '../../lib/taskAttachments.js';
import type { TaskFileRef } from './executionProvider.js';
import { errorMessage } from '../../lib/errors.js';

export interface TaskFilesExecutionManager {
  syncTaskFiles?(
    agentId: string,
    taskId: string,
    files: TaskFileRef[]
  ): Promise<{ dir: string; missing: string[] } | null>;
  writeTaskFile?(agentId: string, taskId: string, name: string, data: Buffer): Promise<string>;
}

type AttachmentStore = {
  list: (taskId: string) => Promise<TaskAttachment[]>;
  read: (taskId: string, attachmentId: string) => Promise<{ data: Buffer } | null>;
};

const dbStore: AttachmentStore = {
  list: listTaskAttachments,
  read: getTaskAttachmentData,
};

/**
 * Mirror the task's attachments onto the agent's runner and return what the
 * prompt should list. Returns [] when the task has none and nothing was ever
 * copied, or when the agent has no runner able to hold files.
 */
export async function deliverTaskAttachments(
  executionManager: TaskFilesExecutionManager | null | undefined,
  agentId: string,
  taskId: string,
  store: AttachmentStore = dbStore
): Promise<MaterializedAttachment[]> {
  if (!executionManager?.syncTaskFiles || !executionManager.writeTaskFile) return [];
  const attachments = await store.list(taskId);
  let sync: { dir: string; missing: string[] } | null;
  try {
    sync = await executionManager.syncTaskFiles(
      agentId,
      taskId,
      attachments.map(a => ({ name: a.filename, sha256: a.sha256 }))
    );
  } catch (err) {
    // No attachment → nothing lost if a runner without the route cannot prune.
    if (attachments.length === 0) return [];
    throw new Error(
      `Could not deliver the task's attached files to the runner: ${errorMessage(err)}`
    );
  }
  if (!sync) return [];

  const missing = new Set(sync.missing);
  const delivered: MaterializedAttachment[] = [];
  for (const a of attachments) {
    let path = `${sync.dir.replace(/\/+$/, '')}/${a.filename}`;
    if (missing.has(a.filename)) {
      const full = await store.read(taskId, a.id);
      if (!full) continue; // detached meanwhile
      try {
        path = await executionManager.writeTaskFile(agentId, taskId, a.filename, full.data);
      } catch (err) {
        throw new Error(
          `Could not deliver attached file "${a.filename}" to the runner: ${errorMessage(err)}`
        );
      }
    }
    delivered.push({ filename: a.filename, mimeType: a.mimeType, size: a.size, path });
  }
  return delivered;
}
