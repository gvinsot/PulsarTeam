import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAllBoards, getBoardById, searchTasks } from './database.js';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import { getTaskById } from './database/tasks.js';
import { getReposForBoard } from './database/boardRepos.js';
import { resolveWorkflowStatus } from './workflow/index.js';

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
  let agent: any = null;
  if (agent_id || agent_name) {
    agent = findAgent(agentManager, { agent_id, agent_name });
  } else {
    // No agent given — locate the task across all agents.
    for (const a of agentManager.agents.values()) {
      const t = agentManager._getAgentTasks((a as any).id).find((tt: any) => tt.id === task_id);
      if (t) { agent = a; break; }
    }
  }

  let task: any = agent
    ? agentManager._getAgentTasks(agent.id).find((t: any) => t.id === task_id)
    : null;

  // Unassigned tasks (the kind add_task creates) live only in the DB,
  // never in the agentId-keyed in-memory store — fall back to a direct
  // lookup so they stay updatable.
  let boardLevel = false;
  if (!task) {
    const dbTask = await getTaskById(task_id);
    if (dbTask?.agentId) {
      // The task has an owner missing from memory — rehydrate and retry
      // the normal in-memory path under the owning agent.
      await agentManager._ensureTaskInMemory(dbTask.agentId, task_id);
      const owner = agentManager.agents.get(dbTask.agentId);
      if (owner) {
        agent = owner;
        task = agentManager._getAgentTasks(owner.id).find((t: any) => t.id === task_id) || null;
      }
      if (!task) {
        task = dbTask;
        boardLevel = true;
      }
    } else if (dbTask) {
      task = dbTask;
      boardLevel = true;
    }
  }

  return { task, agent, boardLevel };
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
 * Creates an MCP server exposing swarm management tools:
 * - list_agents: List all agents with their status
 * - get_agent_status: Get detailed status for a specific agent
 * - list_boards: List all task boards (and the repos in use on each)
 * - add_task: Add an unassigned task to a board (with optional repo / storage targeting)
 * - update_task: Update an existing task's status, repo, or storage binding
 * - task_execution_complete: Signal that the calling agent finished its task
 *
 * `callerAgentId` is the agent the MCP request is acting on behalf of, resolved
 * from the `X-Agent-Id` header (set automatically when this MCP is wired into a
 * CLI runner agent — see mcpManager.getClaudeMcpConfigForAgent). It scopes
 * task_execution_complete to the right agent; it is null for external (API-key)
 * callers, where that tool requires an explicit agent_id.
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

      const result = agents.map((a: any) => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        project: a.project || null,
        currentTask: a.currentTask || null,
        openTasks: agentManager._getAgentTasks(a.id).filter((t: any) => t.status !== 'done').length,
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
        todoList: agentManager._getAgentTasks(agentAny.id).map((t: any) => ({
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
    'Add a new task to a board. board_id is mandatory — use list_boards to discover board IDs. Tasks are always created unassigned on the board; any agent can pick them up later from the board column. A repository or storage path can also be bound to the task.',
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

      const newTask = agentManager.addTask(null, task, { type: 'mcp' }, resolvedStatus, {
        boardId: resolvedBoardId,
        repoFullName,
        repoProvider: repoFullName ? (repo_provider || 'github') : null,
        storagePath,
        storageProvider: storagePath ? (storage_provider || 'onedrive') : null,
      });
      if (!newTask) {
        return jsonError('Failed to create task. Verify board_id is valid.');
      }
      console.log(`\u2705 [SwarmMCP] add_task \u2014 Task created (unassigned) \u2014 task: ${newTask.id}, project: ${project || '(none)'}, status: ${resolvedStatus || '(default)'}, board: ${resolvedBoardId}, repo: ${repoFullName || '(none)'}, storage: ${storagePath || '(none)'}`);

      return jsonOk({
        success: true,
        task: newTask,
        agent: null,
        board_id: resolvedBoardId,
      });
    }
  );

  // ── update_task ─────────────────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update an existing task: change status, repository, or storage path. To clear a repo or storage binding, pass an empty string. At least one of status, repo_full_name, storage_path must be provided.',
    {
      agent_id: z.string().optional().describe('Agent UUID owning the task'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id)'),
      task_id: z.string().describe('Task UUID to update'),
      status: z.string().optional().describe('New status (workflow column label preferred, column ID also accepted, e.g. "Backlog", "in_progress", "Done")'),
      repo_full_name: z.string().optional().describe('New repository in "owner/repo" format. Pass an empty string to unbind the task from any repo.'),
      repo_provider: z.string().optional().describe('Repository provider — defaults to "github" when repo_full_name is set.'),
      storage_path: z.string().optional().describe('New storage location (e.g. OneDrive folder path). Pass an empty string to unbind the task from any storage.'),
      storage_provider: z.string().optional().describe('Storage provider — defaults to "onedrive" when storage_path is set.'),
    },
    async ({ agent_id, agent_name, task_id, status, repo_full_name, repo_provider, storage_path, storage_provider }) => {
      // Resolve the agent (either parameter form is accepted, mirroring
      // add_task) and the task, with DB fallback/rehydration for unassigned
      // or not-yet-in-memory tasks.
      const { task, agent, boardLevel } = await locateTask(agentManager, { agent_id, agent_name, task_id });
      if (!task) {
        return jsonError(`Task not found: ${task_id}`);
      }

      // Validate at least one mutating field is provided. We treat "" as a
      // valid clear-signal for repo/storage, so explicitly check for undefined.
      if (status === undefined && repo_full_name === undefined && storage_path === undefined) {
        return jsonError('At least one of status, repo_full_name, storage_path must be provided.');
      }

      // Resolve status against the task's board workflow when provided.
      // We fail loudly — silently accepting an unknown status used to
      // leave tasks stranded in a column the board could not render or
      // transition out of.
      let resolvedStatus = status;
      if (status !== undefined) {
        if (!task.boardId) {
          return jsonError(`Cannot update status: task ${task_id} is not bound to a board.`);
        }
        const board = await getBoardById(task.boardId);
        if (!board?.workflow?.columns?.length) {
          return jsonError(`Cannot update status: board "${board?.name || task.boardId}" has no workflow columns configured.`);
        }
        const statusResolution = resolveBoardStatus(board, task.boardId, status);
        if (statusResolution.error) {
          return jsonError(statusResolution.error);
        }
        resolvedStatus = statusResolution.status;
      }

      // Validate repo format (empty string = clear, valid format = set,
      // anything else is rejected).
      let repoUpdate: { value: string | null; provider: string | null } | undefined;
      if (repo_full_name !== undefined) {
        if (repo_full_name === '' || repo_full_name === null) {
          repoUpdate = { value: null, provider: null };
        } else {
          const normalized = normalizeRepoFullName(repo_full_name);
          if (!normalized) {
            return jsonError(`Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format or empty string to clear.`);
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

      console.log(`📝 [SwarmMCP] update_task — task ${task_id}, status: ${resolvedStatus ?? '(unchanged)'}, repo: ${repoUpdate ? (repoUpdate.value ?? '(cleared)') : '(unchanged)'}, storage: ${storageUpdate ? (storageUpdate.value ?? '(cleared)') : '(unchanged)'}`);

      // Apply updates in a fixed order so the final task object reflects all
      // mutations regardless of which fields were provided.
      let updated: any = task;
      if (boardLevel) {
        updated = await applyBoardLevelUpdate(agentManager, task, { repoUpdate, storageUpdate, status: resolvedStatus });
      } else {
        if (repoUpdate) {
          updated = agentManager.updateTaskRepo(agent.id, task_id, repoUpdate.value, repoUpdate.provider) || updated;
        }
        if (storageUpdate) {
          updated = agentManager.updateTaskStorage(agent.id, task_id, storageUpdate.value, storageUpdate.provider) || updated;
        }
        if (resolvedStatus !== undefined) {
          updated = agentManager.setTaskStatus(agent.id, task_id, resolvedStatus) || updated;
        }
      }

      return jsonOk({
        success: true,
        task: updated,
        agent: boardLevel ? null : { id: agent.id, name: agent.name },
      });
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

  // ── task_execution_complete ──────────────────────────────────────────────
  // CLI runner agents (claude-code/codex/opencode/openclaw/hermes) invoke MCP
  // tools rather than emitting the @task_execution_complete text syntax our
  // chat parser understands, so this is THE way they signal a task is done.
  // It shares agentManager.applyTaskExecutionComplete with the native tool, so
  // behaviour (completion signal, summary appended to the task, commit linking)
  // is identical across both paths.
  server.tool(
    'task_execution_complete',
    'Signal that you have finished executing your currently assigned task. You MUST call this when your work is done — until you do, the system considers the task still in progress and keeps sending reminders. Commit and push your code first.',
    {
      comment: z.string().describe('A brief summary of what was accomplished. Appended onto the task so the requester sees it.'),
      task_id: z.string().optional().describe('Task UUID to mark complete. Optional — auto-detected from your active task when omitted.'),
      agent_id: z.string().optional().describe('Agent UUID acting. Optional — inferred from the request context for CLI runner agents; only needed for external API-key callers.'),
      commits: z.string().optional().describe('Optional already-pushed commits to link, comma-separated "hash:message, hash:message". Pushed commits are auto-linked even if omitted.'),
    },
    async ({ comment, task_id, agent_id, commits }) => {
      const agentId = (agent_id || callerAgentId || '').trim();
      if (!agentId) {
        return jsonError('No agent context. Provide agent_id (external callers) — CLI runner agents are resolved automatically.');
      }

      const outcome = await agentManager.applyTaskExecutionComplete(agentId, {
        comment: comment || '',
        explicitTaskId: (task_id || '').trim(),
        commitsArg: (commits || '').trim(),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: outcome.success,
            completed: Boolean(outcome.isTerminal),
            task_id: outcome.taskId || null,
            message: outcome.result,
          }, null, 2),
        }],
        ...(outcome.success ? {} : { isError: true }),
      };
    }
  );

  return server;
}

/**
 * Creates an Express request handler for the Swarm API MCP endpoint (Streamable HTTP).
 *
 * X-Agent-Id is injected when this MCP is wired into a CLI runner agent
 * (mcpManager.getClaudeMcpConfigForAgent), scoping task_execution_complete
 * to the calling agent. Absent for external API-key callers. The server
 * builder takes (agentManager, callerAgentId) and ignores boardId.
 */
export function createSwarmApiMcpHandler(agentManager) {
  return createMcpHttpHandler('Swarm API', ({ agentId }) =>
    createSwarmApiMcpServer(agentManager, agentId));
}
