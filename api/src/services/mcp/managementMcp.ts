// ── POST /api/mcp/management — the task-management tool set ────────────────
//
// Reached with a scoped API key whose scope is `management` OR `admin` (the
// ladder is one-way: an admin key opens this surface, a management key never
// opens the admin one — services/apiKeyManager.ts owns that rule).
//
// Everything here is about TASKS. There is deliberately no agent, board,
// project or workflow mutation on this surface: a key handed to a planning
// bot, a chat integration or a cron should be able to file, move, delegate and
// close work without also being able to reshape the instance that runs it.
//
// Every tool resolves its tenant through services/mcp/actorScope.ts, which
// calls the SAME checkBoardAccess / checkAgentAccess the REST routes call, and
// every mutation goes through the same application function as its REST twin
// (`agentManager.addTask`, `applyTaskUpdate`, `agentManager.deleteTask`,
// `agentManager.restoreTask`). Nothing about access control is reimplemented
// here; if the REST rule changes, this surface changes with it.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getBoardsByUser, searchTasks } from '../database.js';
import {
  getTaskByIdPrefix,
  getTasksByStatusAndBoards,
  updateTaskFields,
} from '../database/tasks.js';
import { getReposForBoard } from '../database/boardRepos.js';
import { emitTaskUpdated } from '../taskMutations.js';
import { resolveWorkflowStatus } from '../workflow/columnIds.js';
import { normalizeRepoFullName, normalizeStoragePath } from '../taskRepos.js';
import { jsonOk, jsonError, taskMutationSharedShape } from '../mcpResponses.js';
import { applyTaskUpdate } from '../swarmApiMcp.js';
import { createMcpHttpHandler } from '../mcpHttpHandler.js';
import {
  actorBoardIds,
  notFound,
  requireAdminRole,
  scopedAgent,
  scopedBoard,
  scopedTask,
  type McpActor,
  type McpRecord,
} from './actorScope.js';
import type { AgentManager } from '../agentManager/index.js';

/** The task shape these tools hand back — never the raw row. */
function taskView(task: McpRecord) {
  return {
    id: task.id,
    title: task.title || null,
    text: task.text,
    status: task.status,
    boardId: task.boardId || null,
    agentId: task.agentId || null,
    assignee: task.assignee || null,
    project: task.project || null,
    taskType: task.taskType || null,
    priority: task.priority || null,
    repoFullName: task.repoFullName || null,
    storagePath: task.storagePath || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt || null,
    completedAt: task.completedAt || null,
  };
}

/**
 * Resolve a caller-supplied status against a board's workflow columns. Labels
 * win over ids so a caller can pass the user-facing column name, matching what
 * the swarm surface already accepts.
 */
function resolveBoardStatus(board: McpRecord, status: string): { status?: string; error?: string } {
  const columns = board?.workflow?.columns || [];
  const match = resolveWorkflowStatus(columns, status);
  if (match) return { status: match.id };
  return {
    error: `Invalid status "${status}" for board "${board?.name || board?.id}". Valid columns: ${columns
      .map((c: McpRecord) => c.id)
      .join(', ')}`,
  };
}

export function createManagementMcpServer(agentManager: AgentManager, actor: McpActor) {
  const server = new McpServer({ name: 'PulsarTeam Management', version: '1.0.0' });

  // ── list_boards ─────────────────────────────────────────────────────────
  server.tool(
    'list_boards',
    'List the boards you can reach (your own plus boards shared with you), with their workflow columns and the repositories already in use on them. Use this to discover valid board_id and status values before creating a task.',
    {},
    async () => {
      // Exactly `GET /api/boards`: own + shared, and NOT widened for an admin.
      // The instance-wide listing is a separate admin-only REST route; an API
      // key must not quietly turn one into the other.
      const boards = await getBoardsByUser(actor.userId);
      const result = await Promise.all(
        boards.map(async (b: McpRecord) => {
          let repos: { provider: string; fullName: string }[] = [];
          try {
            repos = (await getReposForBoard(b.id)).map(r => ({
              provider: r.provider,
              fullName: r.fullName,
            }));
          } catch {
            // best-effort — surface the board even if repo derivation fails
          }
          return {
            id: b.id,
            name: b.name,
            project_id: b.project_id || null,
            columns: (b.workflow?.columns || []).map((c: McpRecord) => ({
              id: c.id,
              label: c.label,
            })),
            repos,
          };
        })
      );
      return jsonOk({ count: result.length, boards: result });
    }
  );

  // ── list_agents ─────────────────────────────────────────────────────────
  server.tool(
    'list_agents',
    'List the agents you can reach, with their current status and project. Use this to discover agent ids for delegate_task.',
    {
      project: z.string().optional().describe('Filter agents by project name'),
      status: z.enum(['idle', 'busy', 'error']).optional().describe('Filter agents by status'),
    },
    async ({ project, status }) => {
      // The same call `GET /api/agents` makes — the visibility rule lives in
      // lib/agentAccess.ts (canSeeAgent) and is applied there, not here.
      const boardIds = await actorBoardIds(actor);
      let agents = agentManager.getAllForUser(actor.userId, actor.role, boardIds) as McpRecord[];
      if (project) agents = agents.filter(a => a.project === project);
      if (status) agents = agents.filter(a => a.status === status);
      return jsonOk({
        count: agents.length,
        agents: agents.map(a => ({
          id: a.id,
          name: a.name,
          role: a.role,
          status: a.status,
          project: a.project || null,
          boardId: a.boardId || null,
          enabled: a.enabled !== false,
        })),
      });
    }
  );

  // ── create_task ─────────────────────────────────────────────────────────
  server.tool(
    'create_task',
    'Create a task on a board you can edit. board_id is mandatory — use list_boards to discover it. The task is created unassigned; use delegate_task to give it to an agent.',
    {
      task: z.string().min(1).max(5000).describe('The task description'),
      board_id: z.string().describe('REQUIRED. Board UUID — see list_boards.'),
      title: z.string().max(500).optional().describe('Optional short title'),
      status: z
        .string()
        .optional()
        .describe(
          'Initial column — workflow column label preferred, column id also accepted. Defaults to the board first column.'
        ),
      project: z.string().max(200).optional().describe('Optional project name to tag the task'),
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
    },
    async ({
      task,
      board_id,
      title,
      status,
      project,
      repo_full_name,
      repo_provider,
      storage_path,
      storage_provider,
    }) => {
      // 'edit' on the board, i.e. the same level POST /api/tasks demands.
      const board = await scopedBoard(actor, board_id, 'edit');
      if (!board.ok) return board.error!;

      const repoFullName = normalizeRepoFullName(repo_full_name);
      if (repo_full_name && !repoFullName) {
        return jsonError(
          `Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format.`
        );
      }
      const storagePath = normalizeStoragePath(storage_path);

      let resolvedStatus = status;
      if (status && board.value?.workflow?.columns?.length) {
        const resolution = resolveBoardStatus(board.value, status);
        if (resolution.error) return jsonError(resolution.error);
        resolvedStatus = resolution.status;
      }

      // Board-level (no owner agent), exactly like the REST create: an API key
      // is not an agent, so there is no agent to own the task.
      const created = await agentManager.addTask(
        null,
        task,
        { type: 'mcp', scope: 'management' },
        resolvedStatus,
        {
          boardId: board.value.id,
          repoFullName,
          repoProvider: repoFullName ? repo_provider || 'github' : null,
          storagePath,
          storageProvider: storagePath ? storage_provider || 'onedrive' : null,
          skipAutoRefine: true,
        }
      );
      if (!created) return jsonError('Failed to create task.');

      if (title || project) {
        const fields: Record<string, unknown> = {};
        if (title) fields.title = title;
        if (project) fields.project = project;
        await updateTaskFields(created.id, fields);
        Object.assign(created, fields);
      }

      return jsonOk({ success: true, task: taskView(created) });
    }
  );

  // ── delegate_task ───────────────────────────────────────────────────────
  server.tool(
    'delegate_task',
    'Assign an existing task to an agent. Both the task and the agent must be ones you can edit. Pass agent_id as null or omit it to un-assign.',
    {
      task_id: z.string().describe('Task UUID (a unique id prefix also works)'),
      agent_id: z.string().nullable().optional().describe('Agent UUID to assign to, or null'),
    },
    async ({ task_id, agent_id }) => {
      const task = await getTaskByIdPrefix(task_id);
      const allowed = await scopedTask(actor, task, agentManager.agents, 'edit');
      if (!allowed.ok) return allowed.error!;

      if (agent_id) {
        // Same rule as PUT /api/tasks/:id's assignee branch, taken from the
        // canonical helper rather than re-derived: acting on an agent is an
        // 'edit' on that agent.
        const agent = agentManager.agents.get(agent_id);
        const reachable = await scopedAgent(actor, agent, 'edit');
        if (!reachable.ok) return reachable.error!;
      }

      const assignee = agent_id || null;
      await updateTaskFields(allowed.value.id, { assignee });
      allowed.value.assignee = assignee;
      emitTaskUpdated(agentManager, allowed.value, { stampUpdatedAt: true });

      return jsonOk({ success: true, task: taskView(allowed.value) });
    }
  );

  // ── update_task ─────────────────────────────────────────────────────────
  server.tool(
    'update_task',
    'Update a task AND/OR mark it finished. Change its status (board column), repository or storage path, and/or record completion with a `comment` summary (plus optional `commits`). At least one of status, repo_full_name, storage_path, comment or done must be provided.',
    {
      task_id: z.string().describe('Task UUID to update'),
      ...taskMutationSharedShape,
    },
    async ({ task_id, ...rest }) => {
      // Authorize BEFORE applyTaskUpdate: that function resolves the task by id
      // prefix across the whole instance by design (it backs the agent runtime),
      // so the tenant bound has to be proven here.
      const task = await getTaskByIdPrefix(task_id);
      const allowed = await scopedTask(actor, task, agentManager.agents, 'edit');
      if (!allowed.ok) return allowed.error!;

      // The identical function PUT /api/tasks/:id and the gateway MCP call.
      const result = await applyTaskUpdate(agentManager, { task_id: allowed.value.id, ...rest });
      if (!result.ok) return jsonError(result.error || 'Update failed');
      return jsonOk({
        success: true,
        completed: !!result.completed,
        task: taskView(result.task),
      });
    }
  );

  // ── delete_task ─────────────────────────────────────────────────────────
  server.tool(
    'delete_task',
    'Soft-delete a task you can edit. It can be brought back with restore_task.',
    { task_id: z.string().describe('Task UUID to delete') },
    async ({ task_id }) => {
      const task = await getTaskByIdPrefix(task_id);
      const allowed = await scopedTask(actor, task, agentManager.agents, 'edit');
      if (!allowed.ok) return allowed.error!;

      // Same guard DELETE /api/tasks/:id applies: a task a busy agent is
      // actively executing is not deletable out from under it.
      const owner = allowed.value.agentId ? agentManager.agents.get(allowed.value.agentId) : null;
      if (
        allowed.value.startedAt &&
        agentManager._isActiveTaskStatus(allowed.value.status) &&
        (owner as McpRecord)?.status === 'busy'
      ) {
        return jsonError('Task is being executed. Stop the agent first.');
      }

      const ok = await agentManager.deleteTask(allowed.value.agentId || null, allowed.value.id);
      if (!ok) return notFound('Task');
      return jsonOk({ success: true, task_id: allowed.value.id });
    }
  );

  // ── restore_task ────────────────────────────────────────────────────────
  server.tool(
    'restore_task',
    'Restore a soft-deleted task. Requires the admin role on the key owner, mirroring POST /api/tasks/:id/restore.',
    { task_id: z.string().describe('Task UUID to restore') },
    async ({ task_id }) => {
      // The REST route is requireRole('admin') because a deleted task carries
      // no readable board scope to judge against. Same answer here.
      const admin = requireAdminRole(actor, 'restore_task');
      if (!admin.ok) return admin.error!;

      const restored = await agentManager.restoreTask(task_id);
      if (!restored) return notFound('Deleted task');
      return jsonOk({ success: true, task: taskView(restored) });
    }
  );

  // ── get_task ────────────────────────────────────────────────────────────
  server.tool(
    'get_task',
    'Fetch one task by id, including its history. Only tasks on boards you can reach resolve.',
    { task_id: z.string().describe('Task UUID (a unique id prefix also works)') },
    async ({ task_id }) => {
      const task = await getTaskByIdPrefix(task_id);
      // 'read' here, not 'edit': seeing a task takes read on its board.
      const allowed = await scopedTask(actor, task, agentManager.agents, 'read');
      if (!allowed.ok) return allowed.error!;
      return jsonOk({ task: { ...taskView(allowed.value), history: allowed.value.history || [] } });
    }
  );

  // ── list_tasks ──────────────────────────────────────────────────────────
  server.tool(
    'list_tasks',
    'List tasks on the boards you can reach. Optionally narrow to one board and/or one workflow column.',
    {
      board_id: z.string().optional().describe('Restrict to a single board'),
      status: z.string().optional().describe('Workflow column id to filter on'),
      limit: z.number().int().min(1).max(500).optional().describe('Max tasks to return (200)'),
    },
    async ({ board_id, status, limit }) => {
      let boardIds: string[];
      if (board_id) {
        const board = await scopedBoard(actor, board_id, 'read');
        if (!board.ok) return board.error!;
        boardIds = [board.value.id];
      } else {
        boardIds = [...(await actorBoardIds(actor))];
      }
      // An empty board set means "nothing", never "everything" — that is why
      // the board ids are always passed explicitly.
      const tasks = await getTasksByStatusAndBoards(status || null, boardIds);
      const capped = tasks.slice(0, limit || 200);
      return jsonOk({
        count: capped.length,
        total: tasks.length,
        tasks: capped.map(taskView),
      });
    }
  );

  // ── search_tasks ────────────────────────────────────────────────────────
  server.tool(
    'search_tasks',
    'Search task history across the boards you can reach. Every filter is optional; the search never leaves your boards.',
    {
      query: z.string().optional().describe('Free-text match on task title/description'),
      board_id: z.string().optional().describe('Restrict to a single board'),
      status: z.string().optional().describe('Workflow column id'),
      repo_full_name: z.string().optional().describe('Filter on "owner/repo"'),
      created_after: z.string().optional().describe('ISO date lower bound on creation'),
      created_before: z.string().optional().describe('ISO date upper bound on creation'),
      only_completed: z.boolean().optional().describe('Only tasks that were completed'),
      limit: z.number().int().min(1).max(200).optional().describe('Max results (50)'),
      offset: z.number().int().min(0).optional().describe('Result offset for paging'),
    },
    async ({
      query,
      board_id,
      status,
      repo_full_name,
      created_after,
      created_before,
      only_completed,
      limit,
      offset,
    }) => {
      const scope = [...(await actorBoardIds(actor))];
      if (board_id) {
        // Narrowing must stay INSIDE the bound, so a board id the caller cannot
        // reach answers "not found" rather than silently widening the search.
        const board = await scopedBoard(actor, board_id, 'read');
        if (!board.ok) return board.error!;
      }
      // `boardIds` is the tenant bound searchTasks enforces in SQL; an empty
      // array matches nothing (services/database/tasks.ts).
      const result = await searchTasks({
        query: query || null,
        boardIds: scope,
        boardId: board_id || null,
        status: status || null,
        repoFullName: repo_full_name || null,
        createdAfter: created_after || null,
        createdBefore: created_before || null,
        onlyCompleted: only_completed ?? null,
        limit: limit ?? 50,
        offset: offset ?? 0,
      });
      return jsonOk({
        total: result.total,
        returned: result.returned,
        tasks: result.tasks.map(taskView),
      });
    }
  );

  return server;
}

/**
 * Express handler for POST /api/mcp/management.
 *
 * The actor comes from `req.user`, which `requireApiKeyScope` published after
 * re-reading the key owner from the database. A request that somehow arrives
 * without one is refused rather than run unscoped.
 */
export function createManagementMcpHandler(agentManager: AgentManager) {
  return createMcpHttpHandler('Management', ctx => {
    if (!ctx.user) {
      throw new Error('Management MCP requires an authenticated API key');
    }
    return createManagementMcpServer(agentManager, ctx.user);
  });
}
