import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { getAllBoards, getBoardById, getBoardWithMostTasksForProject } from './database.js';
import { getReposForBoard } from './database/boardRepos.js';

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

/**
 * Creates an MCP server exposing swarm management tools:
 * - list_agents: List all agents with their status
 * - get_agent_status: Get detailed status for a specific agent
 * - list_boards: List all task boards (and the repos in use on each)
 * - add_task: Add a task to an agent (with optional board / repo / storage targeting)
 * - update_task: Update an existing task's status, repo, or storage binding
 */
export function createSwarmApiMcpServer(agentManager) {
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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: result.length, agents: result }, null, 2),
        }],
      };
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
      let agent = null;

      if (agent_id) {
        agent = agentManager.agents.get(agent_id) as any;
      } else if (agent_name) {
        agent = (Array.from(agentManager.agents.values()) as any[]).find(
          (a: any) => a.name.toLowerCase() === agent_name.toLowerCase()
        );
      }

      if (!agent) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Agent not found' }),
          }],
          isError: true,
        };
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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
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

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ count: result.length, boards: result }, null, 2),
        }],
      };
    }
  );

  // ── add_task ───────────────────────────────────────────────────────────
  server.tool(
    'add_task',
    'Add a new task to an agent, optionally on a specific board, and optionally bound to a specific repository or storage path. If there is only one board it is used automatically; otherwise provide board_id (use list_boards to find IDs).',
    {
      agent_id: z.string().optional().describe('Agent UUID'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id)'),
      task: z.string().describe('The task description'),
      project: z.string().optional().describe('Optional project to assign the task to'),
      status: z.string().optional().describe('Initial task status (any workflow column ID, defaults to "backlog")'),
      board_id: z.string().optional().describe('Board UUID to place the task on. If omitted and only one board exists, it is used automatically. Use list_boards to discover board IDs.'),
      repo_full_name: z.string().optional().describe('Repository the agent should work on for this task, in "owner/repo" format (e.g. "myorg/myapp"). When set, this scopes the task to that repo regardless of the agent default project.'),
      repo_provider: z.string().optional().describe('Repository provider \u2014 defaults to "github" when repo_full_name is set.'),
      storage_path: z.string().optional().describe('Storage location (e.g. OneDrive folder path) the task should target.'),
      storage_provider: z.string().optional().describe('Storage provider \u2014 defaults to "onedrive" when storage_path is set.'),
    },
    async ({ agent_id, agent_name, task, project, status, board_id, repo_full_name, repo_provider, storage_path, storage_provider }) => {
      // Validate repo / storage upfront so we return a clear error instead of
      // silently dropping the value (the REST endpoint coerces invalid repos
      // to null, but for the MCP an explicit failure is friendlier to LLMs).
      const repoFullName = normalizeRepoFullName(repo_full_name);
      if (repo_full_name !== undefined && repo_full_name !== null && repo_full_name !== '' && !repoFullName) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: `Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format.` }),
          }],
          isError: true,
        };
      }
      const storagePath = normalizeStoragePath(storage_path);

      console.log(`\u{1F4E5} [SwarmMCP] add_task called \u2014 agent_id: ${agent_id || '(none)'}, agent_name: ${agent_name || '(none)'}, project: ${project || '(none)'}, status: ${status || '(default)'}, board_id: ${board_id || '(auto)'}, repo: ${repoFullName || '(none)'}, storage: ${storagePath || '(none)'}, task: ${task.slice(0, 100)}`);
      let agent: any = null;

      if (agent_id) {
        agent = agentManager.agents.get(agent_id) as any;
      } else if (agent_name) {
        agent = (Array.from(agentManager.agents.values()) as any[]).find(
          (a: any) => a.name.toLowerCase() === agent_name.toLowerCase()
        );
      }

      if (!agent) {
        console.warn(`\u26A0\uFE0F [SwarmMCP] add_task \u2014 Agent not found: agent_id="${agent_id || ''}", agent_name="${agent_name || ''}"`);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'Agent not found' }),
          }],
          isError: true,
        };
      }

      // Resolve board_id: pick the board with the most tasks for the project,
      // fall back to single board or default board
      let resolvedBoardId = board_id || null;
      let resolvedBoard: any = null;
      if (!resolvedBoardId) {
        const boards = await getAllBoards();
        if (boards.length === 1) {
          resolvedBoardId = boards[0].id;
          resolvedBoard = boards[0];
        } else if (boards.length > 1) {
          // Find the board with the most tasks for this project
          const taskProject = project || agent.project;
          if (taskProject) {
            const bestBoardId = await getBoardWithMostTasksForProject(taskProject);
            if (bestBoardId) {
              resolvedBoardId = bestBoardId;
              resolvedBoard = boards.find(b => b.id === bestBoardId) || null;
              console.log(`📋 [SwarmMCP] Auto-resolved board for project "${taskProject}": ${resolvedBoardId}`);
            }
          }
          // Fallback: use the default board if no project match found
          if (!resolvedBoardId) {
            const defaultBoard = boards.find(b => b.is_default);
            resolvedBoardId = defaultBoard ? defaultBoard.id : boards[0].id;
            resolvedBoard = defaultBoard || boards[0];
            console.log(`📋 [SwarmMCP] No project-specific board found, using fallback: ${resolvedBoardId}`);
          }
        }
      } else {
        // Validate board exists
        const board = await getBoardById(resolvedBoardId);
        if (!board) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: `Board not found: ${resolvedBoardId}` }),
            }],
            isError: true,
          };
        }
        resolvedBoard = board;
      }

      // Validate status against the resolved board's workflow columns. The
      // task is rejected (rather than silently accepted) when the caller
      // passes a column that does not exist on the target board.
      if (status && resolvedBoard?.workflow?.columns?.length) {
        const columns = resolvedBoard.workflow.columns;
        const match = columns.find((c: any) => c.id?.toLowerCase() === status.toLowerCase());
        if (!match) {
          const validIds = columns.map((c: any) => c.id).join(', ');
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ error: `Invalid status "${status}" for board "${resolvedBoard.name || resolvedBoardId}". Valid columns: ${validIds}` }),
            }],
            isError: true,
          };
        }
      }

      const newTask = agentManager.addTask(agent.id, task, { type: 'mcp' }, status, {
        boardId: resolvedBoardId,
        repoFullName,
        repoProvider: repoFullName ? (repo_provider || 'github') : null,
        storagePath,
        storageProvider: storagePath ? (storage_provider || 'onedrive') : null,
      });
      console.log(`\u2705 [SwarmMCP] add_task \u2014 Task created for agent "${agent.name}" (${agent.id}) \u2014 task: ${newTask?.id}, project: ${project || '(none)'}, status: ${status || '(default)'}, board: ${resolvedBoardId || '(none)'}, repo: ${repoFullName || '(none)'}, storage: ${storagePath || '(none)'}`);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            task: newTask,
            agent: { id: agent.id, name: agent.name },
            board_id: resolvedBoardId,
          }, null, 2),
        }],
      };
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
      status: z.string().optional().describe('New status (any workflow column ID, e.g. "backlog", "in_progress", "done")'),
      repo_full_name: z.string().optional().describe('New repository in "owner/repo" format. Pass an empty string to unbind the task from any repo.'),
      repo_provider: z.string().optional().describe('Repository provider — defaults to "github" when repo_full_name is set.'),
      storage_path: z.string().optional().describe('New storage location (e.g. OneDrive folder path). Pass an empty string to unbind the task from any storage.'),
      storage_provider: z.string().optional().describe('Storage provider — defaults to "onedrive" when storage_path is set.'),
    },
    async ({ agent_id, agent_name, task_id, status, repo_full_name, repo_provider, storage_path, storage_provider }) => {
      // Resolve the agent (either parameter form is accepted, mirroring add_task)
      let agent: any = null;
      if (agent_id) {
        agent = agentManager.agents.get(agent_id) as any;
      } else if (agent_name) {
        agent = (Array.from(agentManager.agents.values()) as any[]).find(
          (a: any) => a.name.toLowerCase() === agent_name.toLowerCase()
        );
      } else {
        // No agent given — locate the task across all agents.
        for (const a of agentManager.agents.values()) {
          const t = agentManager._getAgentTasks((a as any).id).find((tt: any) => tt.id === task_id);
          if (t) { agent = a; break; }
        }
      }
      if (!agent) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: 'Agent not found' }) }],
          isError: true,
        };
      }

      const task = agentManager._getAgentTasks(agent.id).find((t: any) => t.id === task_id);
      if (!task) {
        return {
          content: [{ type: 'text', text: JSON.stringify({ error: `Task not found: ${task_id}` }) }],
          isError: true,
        };
      }

      // Validate at least one mutating field is provided. We treat "" as a
      // valid clear-signal for repo/storage, so explicitly check for undefined.
      if (status === undefined && repo_full_name === undefined && storage_path === undefined) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ error: 'At least one of status, repo_full_name, storage_path must be provided.' }),
          }],
          isError: true,
        };
      }

      // Validate status against the task's board workflow when provided. We
      // intentionally fail loudly here — silently accepting an unknown
      // status used to leave tasks stranded in a column the board could not
      // render or transition out of.
      if (status !== undefined && task.boardId) {
        const board = await getBoardById(task.boardId);
        const columns = board?.workflow?.columns;
        if (columns?.length) {
          const match = columns.find((c: any) => c.id?.toLowerCase() === status.toLowerCase());
          if (!match) {
            const validIds = columns.map((c: any) => c.id).join(', ');
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ error: `Invalid status "${status}" for board "${board?.name || task.boardId}". Valid columns: ${validIds}` }),
              }],
              isError: true,
            };
          }
        }
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
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ error: `Invalid repo_full_name: "${repo_full_name}". Expected "owner/repo" format or empty string to clear.` }),
              }],
              isError: true,
            };
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

      console.log(`📝 [SwarmMCP] update_task — task ${task_id}, status: ${status ?? '(unchanged)'}, repo: ${repoUpdate ? (repoUpdate.value ?? '(cleared)') : '(unchanged)'}, storage: ${storageUpdate ? (storageUpdate.value ?? '(cleared)') : '(unchanged)'}`);

      // Apply updates in a fixed order so the final task object reflects all
      // mutations regardless of which fields were provided.
      let updated: any = task;
      if (repoUpdate) {
        updated = agentManager.updateTaskRepo(agent.id, task_id, repoUpdate.value, repoUpdate.provider) || updated;
      }
      if (storageUpdate) {
        updated = agentManager.updateTaskStorage(agent.id, task_id, storageUpdate.value, storageUpdate.provider) || updated;
      }
      if (status !== undefined) {
        updated = agentManager.setTaskStatus(agent.id, task_id, status) || updated;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            task: updated,
            agent: { id: agent.id, name: agent.name },
          }, null, 2),
        }],
      };
    }
  );

  return server;
}

/**
 * Creates an Express request handler for the Swarm API MCP endpoint (Streamable HTTP).
 */
export function createSwarmApiMcpHandler(agentManager) {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = createSwarmApiMcpServer(agentManager);
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[Swarm API MCP] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  };
}

/**
 * Creates Express request handlers for the legacy SSE MCP transport.
 * - GET  /sse      → establishes the SSE stream
 * - POST /messages → receives JSON-RPC messages from the client
 */
export function createSwarmApiMcpSseHandlers(agentManager) {
  const sessions = new Map();

  const sseHandler = async (req, res) => {
    console.log('[Swarm API MCP] SSE connection established (legacy transport)');
    const transport = new SSEServerTransport('/api/swarm/mcp/messages', res);
    sessions.set(transport.sessionId, transport);

    res.on('close', () => {
      console.log(`[Swarm API MCP] SSE session ${transport.sessionId} closed`);
      sessions.delete(transport.sessionId);
    });

    const server = createSwarmApiMcpServer(agentManager);
    await server.connect(transport);
  };

  const messagesHandler = async (req: any, res: any) => {
    const sessionId = req.query.sessionId as string;
    const transport = sessions.get(sessionId);

    if (!transport) {
      res.status(400).json({ error: 'No active SSE session for this sessionId' });
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  };

  return { sseHandler, messagesHandler };
}
