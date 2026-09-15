// ── Creating a task on a board, for every key-authenticated surface ─────────
//
// Three doors lead here and they must not drift apart:
//
//   • `create_task` on /api/mcp/management  — the board is a tool argument
//   • `create_task` on /api/mcp/insert      — the board comes from the key
//   • `POST /api/insert/tasks`              — the board comes from the key
//
// So the field set (`createTaskFieldsShape`), its validation and the write
// (`createBoardTask`) live once, here. The API documentation is generated from
// the same shape (services/apiDocs.ts), so what the docs promise is what the
// endpoints accept.
//
// Authorization is NOT decided here: every caller hands in a board it already
// resolved at 'edit' level through actorScope.ts / middleware/apiKeyAuth.ts.

import { z } from 'zod';
import { getProjectById } from '../database.js';
import { resolveWorkflowStatus } from '../workflow/columnIds.js';
import { normalizeRepoFullName, normalizeStoragePath } from '../taskRepos.js';
import type { AgentManager } from '../agentManager/index.js';
import { taskEditShape } from './schemas.js';
import { editTaskMetadata, taskView } from './taskOperations.js';
import type { McpActor, McpRecord } from './actorScope.js';
import { errorMessage } from '../../lib/errors.js';

/** Every field a caller may set when creating a task, board excluded. */
export const createTaskFieldsShape = {
  task: z
    .string()
    .min(1)
    .max(5000)
    .describe('The task text. Used as the description when `description` is omitted.'),
  ...taskEditShape,
  status: z
    .string()
    .optional()
    .describe(
      'Initial column — workflow column label preferred, column id also accepted. Defaults to the board first column.'
    ),
  repo_full_name: z
    .string()
    .optional()
    .describe('Repository the task targets, in "owner/repo" format.'),
  repo_provider: z.string().optional().describe('Defaults to "github" when a repo is set.'),
  storage_path: z.string().optional().describe('Storage location the task should target.'),
  storage_provider: z
    .string()
    .optional()
    .describe('Defaults to "onedrive" when a storage path is set.'),
};

export const createTaskFieldsSchema = z.object(createTaskFieldsShape);
export type CreateTaskFields = z.infer<typeof createTaskFieldsSchema>;

/** Who created the task, as stored on `task.source`. */
export interface TaskInsertSource {
  type: 'mcp' | 'api';
  scope: 'management' | 'insert';
  apiKeyId?: string;
}

/**
 * Same result shape as the rest of this layer (see ScopedLookup): one
 * interface, because api/'s tsc does not narrow the negative branch of a
 * discriminated union.
 */
export interface TaskInsertResult {
  ok: boolean;
  task?: Record<string, unknown>;
  error?: string;
  /**
   * `invalid` — a caller mistake (bad column, bad repo…): nothing was written,
   * 400 on REST. `failed` — the server failed: 500 on REST, so an integration
   * retries. When the failure came AFTER the task row was written, `taskId`
   * names it, so a retrying caller can tell a partial success from nothing.
   */
  kind?: 'invalid' | 'failed';
  taskId?: string;
}

/**
 * Resolve a caller-supplied status against a board's workflow columns. Labels
 * win over ids so a caller can pass the user-facing column name, matching what
 * the swarm surface already accepts.
 */
export function resolveBoardStatus(
  board: McpRecord,
  status: string
): { status?: string; error?: string } {
  const columns = board?.workflow?.columns || [];
  const match = resolveWorkflowStatus(columns, status);
  if (match) return { status: match.id };
  return {
    error: `Invalid status "${status}" for board "${board?.name || board?.id}". Valid columns: ${columns
      .map((c: McpRecord) => c.id)
      .join(', ')}`,
  };
}

/**
 * Create one board-level (unassigned) task on `board`.
 *
 * `project`, when given, is the management surface's legacy consistency check
 * against the board's project; the project itself is always inherited.
 */
export async function createBoardTask(
  agentManager: AgentManager,
  actor: McpActor,
  board: McpRecord,
  fields: CreateTaskFields & { project?: string },
  source: TaskInsertSource
): Promise<TaskInsertResult> {
  const {
    task,
    title,
    description,
    priority,
    due_date,
    task_type,
    is_manual,
    status,
    project,
    repo_full_name,
    repo_provider,
    storage_path,
    storage_provider,
  } = fields;

  const boardProject = board.project_id ? await getProjectById(board.project_id) : null;
  if (project && project !== boardProject?.name) {
    return {
      ok: false,
      kind: 'invalid',
      error: 'project must match the board project; attach the board to the project first.',
    };
  }

  const repoFullName = normalizeRepoFullName(repo_full_name);
  if (repo_full_name && !repoFullName) {
    return {
      ok: false,
      kind: 'invalid',
      error: `Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format.`,
    };
  }
  const storagePath = normalizeStoragePath(storage_path);

  let resolvedStatus = status;
  if (status && board?.workflow?.columns?.length) {
    const resolution = resolveBoardStatus(board, status);
    if (resolution.error) return { ok: false, kind: 'invalid', error: resolution.error };
    resolvedStatus = resolution.status;
  }

  // Board-level (no owner agent), exactly like the REST create: an API key is
  // not an agent, so there is no agent to own the task.
  const created = await agentManager.addTask(null, description ?? task, source, resolvedStatus, {
    boardId: board.id,
    repoFullName,
    repoProvider: repoFullName ? repo_provider || 'github' : null,
    storagePath,
    storageProvider: storagePath ? storage_provider || 'onedrive' : null,
    skipAutoRefine: true,
  });
  if (!created) return { ok: false, kind: 'failed', error: 'Failed to create task.' };

  const metadata: Record<string, unknown> = {};
  if (title !== undefined) metadata.title = title;
  if (priority !== undefined) metadata.priority = priority;
  if (due_date !== undefined) metadata.dueDate = due_date;
  if (task_type !== undefined) metadata.taskType = task_type;
  if (is_manual !== undefined) metadata.isManual = is_manual;
  if (Object.keys(metadata).length) {
    try {
      Object.assign(created, await editTaskMetadata(agentManager, created, metadata, actor));
    } catch (err) {
      return {
        ok: false,
        kind: 'failed',
        taskId: created.id,
        error: `Task ${created.id} was created but its metadata could not be saved: ${errorMessage(err)}`,
      };
    }
  }

  created.project = boardProject?.name || null;
  return { ok: true, task: taskView(created) };
}
