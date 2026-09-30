import type express from 'express';
import { getWorkflowForBoard } from '../../services/configManager.js';
import { isValidRepoFullName } from '../../services/taskRepos.js';
import { resolveSessionToken } from '../../middleware/session.js';
import { detectEnvironment } from '../../lib/environment.js';
import type { AgentManager } from '../../services/agentManager/index.js';

/**
 * The UI's task creation, shared by its two doors:
 *
 *   • `POST /api/agents/:id/tasks`  — the agent is only the task's container
 *   • `POST /api/boards/:id/tasks`  — no agent: a board-level task
 *                                     (agent_id NULL), so a board that has no
 *                                     agent yet can still receive tasks
 *
 * Authorization is NOT decided here: each route has already checked edit access
 * to the agent or to the board. The body fields are the same on both doors.
 *
 * Returns the created task, or null when addTask refused (unknown agent, or a
 * board-level task without a board).
 */
export async function createTaskFromRequest(
  agentManager: AgentManager,
  req: express.Request,
  { agentId, boardId }: { agentId: string | null; boardId: string | undefined }
) {
  const {
    text,
    source,
    status,
    repoFullName,
    repoProvider,
    secondaryRepos,
    contextFiles,
    storageProvider,
    storagePath,
    recurrence,
    taskType,
    isManual,
  } = req.body;

  const resolvedSource = source || {
    type: resolveSessionToken(req)?.source === 'bearer' ? 'api' : 'user',
    name: req.user?.username || undefined,
  };
  let resolvedStatus = status && typeof status === 'string' ? status : undefined;

  // When no status is provided, resolve default from the board's first column
  // so the task lands in the correct column
  if (!resolvedStatus && boardId) {
    try {
      const wf = await getWorkflowForBoard(boardId);
      if (wf?.columns && wf.columns.length > 0) {
        resolvedStatus = wf.columns[0].id;
      }
    } catch {
      /* fall through to addTask default */
    }
  }

  // Repo is the canonical "owner/repo" the picker captured from the
  // board's GitHub plugin — validate format only (full validation against
  // the OAuth scope happens at clone time).
  const resolvedRepoFullName: string | null = isValidRepoFullName(repoFullName)
    ? repoFullName
    : null;
  const resolvedRepoProvider = resolvedRepoFullName ? repoProvider || 'github' : null;

  // Storage path comes from the board's OneDrive plugin picker.
  const resolvedStoragePath: string | null =
    typeof storagePath === 'string' && storagePath.trim().length > 0
      ? storagePath.trim().slice(0, 500)
      : null;
  const resolvedStorageProvider = resolvedStoragePath ? storageProvider || 'onedrive' : null;

  const environment = detectEnvironment(req.hostname);
  console.log(
    `[CreateTask] POST ${agentId ? '/agents/:id/tasks' : '/boards/:id/tasks'} — agent="${agentId || '(board-level)'}", status="${status}", boardId="${boardId}", repo="${resolvedRepoFullName || ''}", storage="${resolvedStoragePath || ''}" env="${environment}" text="${(text || '').slice(0, 60)}"`
  );
  const task = await agentManager.addTask(agentId, text, resolvedSource, resolvedStatus, {
    boardId,
    repoFullName: resolvedRepoFullName,
    repoProvider: resolvedRepoProvider,
    // Validated + deduped + primary-excluded inside addTask (normalizeSecondaryRepos)
    secondaryRepos: secondaryRepos,
    contextFiles,
    storagePath: resolvedStoragePath,
    storageProvider: resolvedStorageProvider,
    recurrence: recurrence || undefined,
    taskType: taskType || undefined,
    isManual: isManual || false,
    environment,
  });
  if (task) {
    console.log(
      `[CreateTask] Task created: id=${task.id} status="${task.status}" boardId="${task.boardId}"`
    );
  }
  return task;
}
