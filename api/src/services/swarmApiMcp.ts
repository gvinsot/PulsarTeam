import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAllBoards, getBoardById, searchTasks } from './database.js';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import { getTaskByIdPrefix, getTasksByAgent } from './database/tasks.js';
import { getReposForBoard } from './database/boardRepos.js';
import { resolveWorkflowStatus } from './workflow/columnIds.js';

// Format of "owner/repo" — same regex used by the REST endpoint.
const REPO_FULL_NAME_RE = /^[\w.-]+\/[\w.-]+$/;
const STORAGE_PATH_MAX = 500;

/** Validate and normalise a repo full-name string ("owner/repo") or null. */
function normalizeRepoFullName(value: any): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return REPO_FULL_NAME_RE.test(trimmed) ? trimmed : null;
}

/** Trim/length-cap a storage path coming from a remote caller, or null. */
function normalizeStoragePath(value: any): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, STORAGE_PATH_MAX);
}

/** Success envelope: pretty-printed JSON text content. */
const jsonOk = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
});

/** Error envelope: compact `{ error }` JSON text content flagged isError. */
const jsonError = (error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

/** Resolve an agent by UUID (agent_id) or case-insensitive name (agent_name). */
function findAgent(
  agentManager,
  { agent_id, agent_name }: { agent_id?: string; agent_name?: string },
) {
  if (agent_id) return agentManager.agents.get(agent_id) ?? null;
  if (agent_name) {
    return (Array.from(agentManager.agents.values()) as any[]).find(
      (a: any) => a.name.toLowerCase() === agent_name.toLowerCase()
    ) ?? null;
  }
  return null;
}

/**
 * Resolve `status` against a board's workflow columns. Labels are checked
 * first so callers can pass the user-facing column name; IDs remain the
 * fallback for compatibility.
 */
function resolveBoardStatus(board: any, boardLabel: string, status: string): { status?: string; error?: string } {
  const columns = board?.workflow?.columns || [];
  const match = resolveWorkflowStatus(columns, status);
  if (match) return { status: match.id };
  const validIds = columns.map((c: any) => c.id).join(', ');
  return { error: `Invalid status "${status}" for board "${board?.name || boardLabel}". Valid columns: ${validIds}` };
}

/**
 * Resolve the (agent, task) pair for update_task:
 *  - agent from agent_id/agent_name when provided, otherwise by scanning all
 *    agents' in-memory task lists for the task;
 *  - task from the resolved agent's in-memory list, falling back to a direct
 *    DB lookup. Unassigned tasks (the kind add_task creates) live only in the
 *    DB, never in the agentId-keyed in-memory store (`boardLevel: true`).
 *
 * When the DB copy names an owner missing from memory, the task is rehydrated
 * and `agent` may be REASSIGNED to the real owner — callers must use the
 * returned agent, not the one they resolved from the input parameters.
 */
async function locateTask(
  agentManager,
  { agent_id, agent_name, task_id }: { agent_id?: string; agent_name?: string; task_id: string },
): Promise<{ task: any; agent: any; boardLevel: boolean }> {
  // DB-first resolution by full id OR unique prefix (the short-id form agents
  // pass), regardless of owner — the DB is the single source of truth.
  const task = await getTaskByIdPrefix(task_id);
  if (!task) return { task: null, agent: null, boardLevel: false };
  // `agent` is the task's OWNER. When there is no owner agent available (an
  // unassigned board-level task, or an owner missing from memory) the owned
  // mutators — which require an existing owner agent — can't be used, so route
  // through the board-level path instead.
  const owner = (task as any).agentId ? agentManager.agents.get((task as any).agentId) : null;
  return { task, agent: owner, boardLevel: !owner };
}

/**
 * Apply an update_task mutation to an unassigned/board-only task: the
 * agentManager helpers all require an in-memory owner, so mutate the DB copy
 * directly and persist it — mirroring what PUT /tasks/:id does for these
 * tasks. Returns the mutated task.
 */
async function applyBoardLevelUpdate(
  agentManager,
  task: any,
  { repoUpdate, storageUpdate, status }: {
    repoUpdate?: { value: string | null; provider: string | null };
    storageUpdate?: { value: string | null; provider: string | null };
    status?: string;
  },
): Promise<any> {
  const now = new Date().toISOString();
  if (!task.history) task.history = [];
  if (repoUpdate) {
    task.history.push({ status: task.status, at: now, by: 'mcp', type: 'edit', field: 'repoFullName', oldValue: task.repoFullName || null, newValue: repoUpdate.value });
    task.repoFullName = repoUpdate.value;
    task.repoProvider = repoUpdate.value ? repoUpdate.provider : null;
  }
  if (storageUpdate) {
    task.history.push({ status: task.status, at: now, by: 'mcp', type: 'edit', field: 'storagePath', oldValue: task.storagePath || null, newValue: storageUpdate.value });
    task.storagePath = storageUpdate.value;
    task.storageProvider = storageUpdate.value ? storageUpdate.provider : null;
  }
  const statusChanged = status !== undefined && status !== task.status;
  if (statusChanged) {
    const previousAssignee = task.assignee || null;
    task.history.push({
      from: task.status,
      status,
      at: now,
      by: 'mcp',
      ...(previousAssignee ? { assignee: null, previousAssignee } : {}),
    });
    task.status = status;
    if (previousAssignee) task.assignee = null;
    // Clear execution state so the workflow engine starts fresh in the
    // new column (mirrors setTaskStatus / PUT /tasks/:id).
    task.startedAt = null;
    task.executionStatus = null;
    // A column move starts a fresh chain — drop the decide no-decision counter
    // (relocated off the task object in Phase 2) so a later re-entry into a
    // decide column isn't penalised by stale attempts. Mirrors setTaskStatus.
    agentManager._decideNoDecisionCounts?.delete(task.id);
    task.actionRunning = false;
    delete task.actionRunningAgentId;
    delete task.actionRunningMode;
    if (status === 'done') task.completedAt = now;
  }
  task.updatedAt = now;
  await agentManager.saveTaskDirectly({ ...task, agentId: task.agentId || null });
  if (task.assignee) {
    const assigneeAgent = agentManager.agents.get(task.assignee);
    task.assigneeName = assigneeAgent?.name || null;
    task.assigneeIcon = assigneeAgent?.icon || null;
  } else {
    task.assigneeName = null;
    task.assigneeIcon = null;
  }
  agentManager._emit('task:updated', { agentId: task.agentId || null, task });
  // Column-entry workflow actions (auto-assign / run_agent) only fire
  // through this hook — no loop ever rescans unassigned tasks, so
  // skipping it would leave the moved task inert in its new column.
  if (statusChanged && task.status !== 'error') {
    agentManager._checkAutoRefine({ ...task }, { by: 'mcp' });
  }
  return task;
}

/**
 * Core of the unified `update_task` MCP tool, shared by the Swarm API MCP and
 * the Pulsar Gateway MCP. Locates the task (with DB / board-level fallback and
 * owner rehydration), validates the requested status against the board workflow
 * and the repo/storage formats, optionally records task completion (summary
 * comment + linked commits + the execute-mode completion signal), applies the
 * status/repo/storage mutation, and returns a discriminated result. Callers wrap
 * the result in their own MCP envelope.
 *
 * A status move to a non-active column already resolves the workflow wait, so
 * the extra completion work is recording the summary/commits and, for execute
 * tasks whose chain advances the column later, firing the completion signal. We
 * run completion BEFORE the status mutation so the task is still active when
 * the execute wait/commit auto-detection look at it.
 */
export async function applyTaskUpdate(
  agentManager,
  { agent_id, agent_name, task_id, status, repo_full_name, repo_provider, storage_path, storage_provider, comment, commits, done }:
    {
      agent_id?: string; agent_name?: string; task_id: string; status?: string;
      repo_full_name?: string; repo_provider?: string; storage_path?: string; storage_provider?: string;
      comment?: string; commits?: string; done?: boolean;
    },
): Promise<{ ok: boolean; task?: any; agent?: any; boardLevel?: boolean; completed?: boolean; error?: string }> {
  // Resolve the agent (either parameter form is accepted, mirroring add_task)
  // and the task, with DB fallback/rehydration for unassigned or
  // not-yet-in-memory tasks.
  const { task, agent, boardLevel } = await locateTask(agentManager, { agent_id, agent_name, task_id });
  if (!task) {
    return { ok: false, error: `Task not found: ${task_id}` };
  }

  const hasMutation = status !== undefined || repo_full_name !== undefined || storage_path !== undefined;
  const wantsCompletion = Boolean((comment && comment.trim()) || (commits && commits.trim()) || done);

  // Validate at least one actionable field is provided. We treat "" as a valid
  // clear-signal for repo/storage, so explicitly check for undefined.
  if (!hasMutation && !wantsCompletion) {
    return { ok: false, error: 'Nothing to update. Provide a status, repo_full_name, storage_path, a comment, or done:true.' };
  }

  // Resolve status against the task's board workflow when provided. We fail
  // loudly — silently accepting an unknown status used to leave tasks stranded
  // in a column the board could not render or transition out of.
  let resolvedStatus = status;
  if (status !== undefined) {
    if (!task.boardId) {
      return { ok: false, error: `Cannot update status: task ${task_id} is not bound to a board.` };
    }
    const board = await getBoardById(task.boardId);
    if (!board?.workflow?.columns?.length) {
      return { ok: false, error: `Cannot update status: board "${board?.name || task.boardId}" has no workflow columns configured.` };
    }
    const statusResolution = resolveBoardStatus(board, task.boardId, status);
    if (statusResolution.error) {
      return { ok: false, error: statusResolution.error };
    }
    resolvedStatus = statusResolution.status;
  }

  // Validate repo format (empty string = clear, valid format = set, anything
  // else is rejected).
  let repoUpdate: { value: string | null; provider: string | null } | undefined;
  if (repo_full_name !== undefined) {
    if (repo_full_name === '' || repo_full_name === null) {
      repoUpdate = { value: null, provider: null };
    } else {
      const normalized = normalizeRepoFullName(repo_full_name);
      if (!normalized) {
        return { ok: false, error: `Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format or empty string to clear.` };
      }
      repoUpdate = { value: normalized, provider: repo_provider || 'github' };
    }
  }

  let storageUpdate: { value: string | null; provider: string | null } | undefined;
  if (storage_path !== undefined) {
    if (storage_path === '' || storage_path === null) {
      storageUpdate = { value: null, provider: null };
    } else {
      const normalized = normalizeStoragePath(storage_path);
      storageUpdate = { value: normalized, provider: storage_provider || 'onedrive' };
    }
  }

  console.log(`📝 [SwarmMCP] update_task — task ${task_id}, status: ${resolvedStatus ?? '(unchanged)'}, repo: ${repoUpdate ? (repoUpdate.value ?? '(cleared)') : '(unchanged)'}, storage: ${storageUpdate ? (storageUpdate.value ?? '(cleared)') : '(unchanged)'}, completion: ${wantsCompletion ? 'yes' : 'no'}`);

  // Completion FIRST (before the status move) so the task is still active when
  // the execute-mode wait / commit auto-detection inspect it. For an assigned
  // task this delegates to shared completion bookkeeping (append summary, link
  // commits, fire the execute completion signal). For an unassigned/board-level
  // task there is no execute wait, but we still record the summary on the card.
  // Credit the agent that ACTUALLY invoked update_task (the caller resolved from
  // agent_id / agent_name), NOT `agent` from locateTask — which gets reassigned
  // to the task's OWNER when the caller isn't the in-memory owner. Without this,
  // an agent moving a task it doesn't own had its summary attributed to the
  // owner (e.g. the comment showed the DevOps agent instead of the mover).
  const callerAgent = findAgent(agentManager, { agent_id, agent_name }) || agent;
  let completed = false;
  if (wantsCompletion) {
    if (!boardLevel && callerAgent) {
      const outcome = await agentManager.recordTaskCompletion(callerAgent.id, {
        comment: comment || '',
        explicitTaskId: task.id,
        commitsArg: (commits || '').trim(),
      });
      completed = Boolean(outcome?.isTerminal);
    } else if (comment && comment.trim()) {
      // Board-level task: append the summary as a note + persist (no agent /
      // no execute wait to signal). Mirrors appendTaskNote's card format.
      const now = new Date().toISOString();
      const actorName = callerAgent?.name || 'mcp';
      const detailBlock = `**[${actorName}]** ${comment.trim()}`;
      task.text = (task.text || '') + '\n\n---\n' + detailBlock;
      if (!task.history) task.history = [];
      task.history.push({ status: task.status, at: now, by: actorName, type: 'edit', field: 'text', oldValue: null, newValue: detailBlock });
      task.updatedAt = now;
      await agentManager.saveTaskDirectly({ ...task, agentId: task.agentId || null });
      agentManager._emit('task:updated', { agentId: task.agentId || null, task });
      completed = true;
    }
  }

  // Apply updates in a fixed order so the final task object reflects all
  // mutations regardless of which fields were provided.
  let updated: any = task;
  if (boardLevel) {
    updated = await applyBoardLevelUpdate(agentManager, task, { repoUpdate, storageUpdate, status: resolvedStatus });
  } else {
    if (repoUpdate) {
      updated = await agentManager.updateTaskRepo(agent.id, task_id, repoUpdate.value, repoUpdate.provider) || updated;
    }
    if (storageUpdate) {
      updated = await agentManager.updateTaskStorage(agent.id, task_id, storageUpdate.value, storageUpdate.provider) || updated;
    }
    if (resolvedStatus !== undefined) {
      // First arg is the owner; credit the status-change history to the caller.
      updated = await agentManager.setTaskStatus(agent.id, task_id, resolvedStatus, { by: callerAgent?.name }) || updated;
    }
  }

  return { ok: true, task: updated, agent, boardLevel, completed };
}

/**
 * Creates an MCP server exposing swarm management tools:
 * - list_agents: List all agents with their status
 * - get_agent_status: Get detailed status for a specific agent
 * - list_boards: List all task boards (and the repos in use on each)
 * - add_task: Add an unassigned task to a board (with optional repo / storage targeting)
 * - update_task: Update a task's status/repo/storage AND/OR mark it finished
 *   (summary comment + linked commits).
 * - search_tasks: Search task history
 *
 * The second parameter is the caller agent context (X-Agent-Id). add_task uses
 * it to record the creating agent as the new task's OWNER (agent_id) so the
 * task lives in the in-memory store and the workflow machinery (busy spinner,
 * assignment, etc.) works on it. The mutation tools (update_task/search_tasks)
 * take an explicit task_id and resolve the owning agent from the task itself.
 */
export function createSwarmApiMcpServer(agentManager, callerAgentId: string | null = null) {
  const server = new McpServer({
    name: 'Swarm API',
    version: '1.0.0',
  });

  // ── list_agents ────────────────────────────────────────────────────────
  server.tool(
    'list_agents',
    'List all agents in the swarm with their current status, role, and project assignment.',
    {
      project: z.string().optional().describe('Filter agents by project name'),
      status: z.enum(['idle', 'busy', 'error']).optional().describe('Filter agents by status'),
    },
    async ({ project, status }) => {
      const allAgents = Array.from(agentManager.agents.values()) as any[];
      let agents = allAgents.filter((a: any) => a.enabled !== false);

      if (project) {
        agents = agents.filter((a: any) => a.project === project);
      }
      if (status) {
        agents = agents.filter((a: any) => a.status === status);
      }

      const byAgent = await agentManager._tasksByAgentMap();
      const result = agents.map((a: any) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        project: a.project || null,
        currentTask: a.currentTask || null,
        openTasks: (byAgent.get(a.id) || []).filter((t: any) => t.status !== 'done').length,
        totalMessages: a.metrics?.totalMessages || 0,
      }));

      return jsonOk({ count: result.length, agents: result });
    }
  );

  // ── get_agent_status ───────────────────────────────────────────────────
  server.tool(
    'get_agent_status',
    'Get detailed status for a specific agent including current task, task list, and metrics.',
    {
      agent_id: z.string().optional().describe('Agent UUID'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id)'),
    },
    async ({ agent_id, agent_name }) => {
      const agent = findAgent(agentManager, { agent_id, agent_name });

      if (!agent) {
        return jsonError('Agent not found');
      }

      const agentAny = agent as any;
      const result = {
        id: agentAny.id,
        name: agentAny.name,
        role: agentAny.role,
        description: agentAny.description,
        status: agentAny.status,
        project: agentAny.project || null,
        currentTask: agentAny.currentTask || null,
        enabled: agentAny.enabled !== false,
        todoList: (await getTasksByAgent(agentAny.id)).map((t: any) => ({
          id: t.id,
          text: t.text,
          status: t.status,
          project: t.project || null,
          boardId: t.boardId || null,
          createdAt: t.createdAt,
          completedAt: t.completedAt || null,
        })),
        metrics: {
          totalMessages: agentAny.metrics?.totalMessages || 0,
          totalTokensIn: agentAny.metrics?.totalTokensIn || 0,
          totalTokensOut: agentAny.metrics?.totalTokensOut || 0,
          totalErrors: agentAny.metrics?.totalErrors || 0,
        },
      };

      return jsonOk(result);
    }
  );

  // ── list_boards ──────────────────────────────────────────────────────────
  server.tool(
    'list_boards',
    'List all task boards. Each board has its own workflow configuration and may have associated repositories or storage targets in use. Use this to discover board IDs and what repos/storage paths are valid before adding tasks.',
    {},
    async () => {
      const boards = await getAllBoards();
      // Hydrate each board with the distinct repos already in use on it. This
      // gives MCP callers a useful picker of valid repo_full_name values
      // without having to scan tasks themselves.
      const result = await Promise.all(boards.map(async (b: any) => {
        let repos: { provider: string; fullName: string }[] = [];
        try {
          const derived = await getReposForBoard(b.id);
          repos = derived.map(r => ({ provider: r.provider, fullName: r.fullName }));
        } catch {
          // best-effort — surface the board even if repo derivation fails
        }
        return {
          id: b.id,
          name: b.name,
          user: b.display_name || b.username || null,
          user_id: b.user_id,
          columns: (b.workflow?.columns || []).map((c: any) => ({ id: c.id, label: c.label })),
          repos,
        };
      }));

      return jsonOk({ count: result.length, boards: result });
    }
  );

  // ── add_task ───────────────────────────────────────────────────────────
  server.tool(
    'add_task',
    'Add a new task to a board. board_id is mandatory — use list_boards to discover board IDs. The task is created unassigned (no assignee) so any agent can be assigned to it later from the board column; you (the calling agent) are recorded as the task owner. A repository or storage path can also be bound to the task.',
    {
      task: z.string().describe('The task description'),
      project: z.string().optional().describe('Optional project to assign the task to'),
      status: z.string().optional().describe('Initial task status (workflow column label preferred, column ID also accepted; defaults to the board first column/backlog)'),
      board_id: z.string().describe('REQUIRED. Board UUID to place the task on. Use list_boards to discover board IDs.'),
      repo_full_name: z.string().optional().describe('Repository the task targets, in "owner/repo" format (e.g. "myorg/myapp").'),
      repo_provider: z.string().optional().describe('Repository provider \u2014 defaults to "github" when repo_full_name is set.'),
      storage_path: z.string().optional().describe('Storage location (e.g. OneDrive folder path) the task should target.'),
      storage_provider: z.string().optional().describe('Storage provider \u2014 defaults to "onedrive" when storage_path is set.'),
    },
    async ({ task, project, status, board_id, repo_full_name, repo_provider, storage_path, storage_provider }) => {
      // Validate repo / storage upfront so we return a clear error instead of
      // silently dropping the value (the REST endpoint coerces invalid repos
      // to null, but for the MCP an explicit failure is friendlier to LLMs).
      const repoFullName = normalizeRepoFullName(repo_full_name);
      if (repo_full_name !== undefined && repo_full_name !== null && repo_full_name !== '' && !repoFullName) {
        return jsonError(`Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format.`);
      }
      const storagePath = normalizeStoragePath(storage_path);

      console.log(`\u{1F4E5} [SwarmMCP] add_task called \u2014 project: ${project || '(none)'}, status: ${status || '(default)'}, board_id: ${board_id}, repo: ${repoFullName || '(none)'}, storage: ${storagePath || '(none)'}, task: ${task.slice(0, 100)}`);

      // board_id is now mandatory — validate it exists. We no longer auto-pick
      // the "best" board for the project: the caller must choose explicitly so
      // unassigned-task placement is unambiguous.
      if (!board_id) {
        return jsonError('board_id is required. Use list_boards to discover available board IDs.');
      }
      const resolvedBoardId: string = board_id;
      const resolvedBoard: any = await getBoardById(resolvedBoardId);
      if (!resolvedBoard) {
        return jsonError(`Board not found: ${resolvedBoardId}. Use list_boards to discover valid IDs.`);
      }

      // Resolve status against the resolved board's workflow columns. The
      // task is rejected (rather than silently accepted) when the caller
      // passes a column that does not exist on the target board.
      let resolvedStatus = status;
      if (status && resolvedBoard?.workflow?.columns?.length) {
        const statusResolution = resolveBoardStatus(resolvedBoard, resolvedBoardId, status);
        if (statusResolution.error) {
          return jsonError(statusResolution.error);
        }
        resolvedStatus = statusResolution.status;
      }

      // Own the task to the calling agent when we have a valid one, so it lands
      // in the in-memory store and the workflow machinery (busy/assignee) works.
      // Falls back to a board-level task (no owner) when there's no agent context
      // (e.g. an external API caller). skipAutoRefine preserves the prior
      // behaviour of NOT auto-running the workflow on creation — the task still
      // waits to be moved/picked up, it's just now owned + in memory.
      const ownerId = callerAgentId && agentManager.agents.get(callerAgentId) ? callerAgentId : null;
      const newTask = await agentManager.addTask(ownerId, task, { type: 'mcp' }, resolvedStatus, {
        boardId: resolvedBoardId,
        repoFullName,
        repoProvider: repoFullName ? (repo_provider || 'github') : null,
        storagePath,
        storageProvider: storagePath ? (storage_provider || 'onedrive') : null,
        skipAutoRefine: true,
      });
      if (!newTask) {
        return jsonError('Failed to create task. Verify board_id is valid.');
      }
      console.log(`\u2705 [SwarmMCP] add_task \u2014 Task created (owner=${ownerId || 'none'}, unassigned) \u2014 task: ${newTask.id}, project: ${project || '(none)'}, status: ${resolvedStatus || '(default)'}, board: ${resolvedBoardId}, repo: ${repoFullName || '(none)'}, storage: ${storagePath || '(none)'}`);

      return jsonOk({
        success: true,
        task: newTask,
        agent: ownerId,
        board_id: resolvedBoardId,
      });
    }
  );

  // ── update_task ─────────────────────────────────────────────────────────
  // The task-mutation+completion tool. Moving a task to a non-active column
  // finishes workflow waits; pass `comment` (and optionally `commits`) to also
  // record a summary and link commits.
  server.tool(
    'update_task',
    'Update a task AND/OR mark it finished. Change its status (board column), repository, or storage path, and/or record completion by passing a `comment` summary (plus optional `commits`). To finish a task: move it to the next column with a comment — e.g. update_task({ task_id, status: "Done", comment: "what you did" }). To clear a repo/storage binding, pass an empty string. At least one of status, repo_full_name, storage_path, comment, or done must be provided.',
    {
      agent_id: z.string().optional().describe('Agent UUID owning the task'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id)'),
      task_id: z.string().describe('Task UUID to update'),
      status: z.string().optional().describe('New status (workflow column label preferred, column ID also accepted, e.g. "Backlog", "in_progress", "Done")'),
      comment: z.string().optional().describe('Completion summary appended onto the task card so the requester sees what was done. Providing it marks the task finished (commit and push your code first).'),
      commits: z.string().optional().describe('Optional already-pushed commits to link, comma-separated "hash:message, hash:message". Pushed commits are auto-linked even if omitted.'),
      done: z.boolean().optional().describe('Set true to signal the task is finished when you have no status change or comment to add (rarely needed — a status move or comment already finishes it).'),
      repo_full_name: z.string().optional().describe('New repository in "owner/repo" format. Pass an empty string to unbind the task from any repo.'),
      repo_provider: z.string().optional().describe('Repository provider — defaults to "github" when repo_full_name is set.'),
      storage_path: z.string().optional().describe('New storage location (e.g. OneDrive folder path). Pass an empty string to unbind the task from any storage.'),
      storage_provider: z.string().optional().describe('Storage provider — defaults to "onedrive" when storage_path is set.'),
    },
    async ({ agent_id, agent_name, task_id, status, comment, commits, done, repo_full_name, repo_provider, storage_path, storage_provider }) => {
      const r = await applyTaskUpdate(agentManager, {
        agent_id, agent_name, task_id, status, comment, commits, done, repo_full_name, repo_provider, storage_path, storage_provider,
      });
      if (r.ok) {
        return jsonOk({
          success: true,
          completed: Boolean(r.completed),
          task: r.task,
          agent: r.boardLevel ? null : { id: r.agent.id, name: r.agent.name },
        });
      } else {
        return jsonError(r.error || 'Failed to update task.');
      }
    }
  );

  // ── search_tasks ────────────────────────────────────────────────────────
  server.tool(
    'search_tasks',
    'Search the task history with optional free-text query and filters (agent, project, board, status, repo, date ranges). Returns up to `limit` tasks (default 50, max 200) ordered newest-first, with a `total` count of matches. Use to find what an agent has done, dig up similar past tasks, audit completion, or trace a bug across history.',
    {
      query: z.string().optional().describe('Free-text search applied case-insensitively to task title, body, and error message.'),
      agent_id: z.string().optional().describe('Restrict to tasks owned by or assigned to this agent UUID.'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id).'),
      project: z.string().optional().describe('Filter by project name (case-insensitive exact match).'),
      board_id: z.string().optional().describe('Filter by board UUID.'),
      status: z.string().optional().describe('Filter by workflow column ID (e.g. "done", "in_progress").'),
      repo_full_name: z.string().optional().describe('Filter by repository in "owner/repo" form.'),
      created_after: z.string().optional().describe('ISO timestamp — only tasks created at or after this moment.'),
      created_before: z.string().optional().describe('ISO timestamp — only tasks created at or before this moment.'),
      completed_after: z.string().optional().describe('ISO timestamp — only tasks completed at or after this moment.'),
      completed_before: z.string().optional().describe('ISO timestamp — only tasks completed at or before this moment.'),
      only_completed: z.boolean().optional().describe('If true, only return tasks that have a completion timestamp.'),
      include_deleted: z.boolean().optional().describe('If true, also include soft-deleted tasks (default: false).'),
      limit: z.number().optional().describe('Max rows returned (1–200, default 50).'),
      offset: z.number().optional().describe('Skip first N rows for pagination (default 0).'),
    },
    async ({
      query, agent_id, agent_name, project, board_id, status, repo_full_name,
      created_after, created_before, completed_after, completed_before,
      only_completed, include_deleted, limit, offset,
    }) => {
      // Resolve agent_name → agent_id when only the name was given. An
      // unknown agent_id is deliberately passed straight through to
      // searchTasks (zero results), only the name branch errors on miss.
      let resolvedAgentId = agent_id || null;
      if (!resolvedAgentId && agent_name) {
        const agent = findAgent(agentManager, { agent_name });
        if (!agent) {
          return jsonError(`Agent not found: ${agent_name}`);
        }
        resolvedAgentId = agent.id;
      }

      const { total, returned, tasks } = await searchTasks({
        query: query || null,
        agentId: resolvedAgentId,
        project: project || null,
        boardId: board_id || null,
        status: status || null,
        repoFullName: repo_full_name || null,
        createdAfter: created_after || null,
        createdBefore: created_before || null,
        completedAfter: completed_after || null,
        completedBefore: completed_before || null,
        onlyCompleted: only_completed ?? null,
        includeDeleted: include_deleted ?? null,
        limit: limit ?? null,
        offset: offset ?? null,
      });

      // Build a name lookup so callers can read agent_name without a second hop.
      const agentNameById = new Map<string, string>();
      for (const a of agentManager.agents.values()) {
        agentNameById.set((a as any).id, (a as any).name);
      }

      const slim = tasks.map((t: any) => ({
        id: t.id,
        title: t.title || (t.text ? t.text.slice(0, 120) : null),
        text: t.text || '',
        status: t.status,
        agent_id: t.agentId,
        agent_name: agentNameById.get(t.agentId) || null,
        assignee_id: t.assignee || null,
        assignee_name: t.assignee ? (agentNameById.get(t.assignee) || null) : null,
        project: t.project || null,
        board_id: t.boardId || null,
        repo_full_name: t.repoFullName || null,
        repo_html_url: t.repoHtmlUrl || null,
        storage_path: t.storagePath || null,
        commit_count: Array.isArray(t.commits) ? t.commits.length : 0,
        history_count: Array.isArray(t.history) ? t.history.length : 0,
        error: t.error || null,
        created_at: t.createdAt,
        started_at: t.startedAt || null,
        completed_at: t.completedAt || null,
        deleted_at: t.deletedAt || null,
      }));

      return jsonOk({ total, returned, tasks: slim });
    }
  );

  return server;
}

/**
 * Creates an Express request handler for the Swarm API MCP endpoint (Streamable HTTP).
 *
 * The X-Agent-Id header is still passed through to the server builder for
 * call-site compatibility, but the task tools no longer depend on it — each
 * resolves the owning agent from the explicit task_id. boardId is ignored.
 */
export function createSwarmApiMcpHandler(agentManager) {
  return createMcpHttpHandler('Swarm API', ({ agentId }) =>
    createSwarmApiMcpServer(agentManager, agentId));
}
