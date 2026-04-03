import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { getAllBoards, getBoardById } from './database.js';

/**
 * Creates an MCP server exposing swarm management tools:
 * - list_agents: List all agents with their status
 * - get_agent_status: Get detailed status for a specific agent
 * - list_boards: List all task boards
 * - add_task: Add a task to an agent (with optional board targeting)
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
      const allAgents = Array.from(agentManager.agents.values());
      let agents = allAgents.filter(a => a.enabled !== false);

      if (project) {
        agents = agents.filter(a => a.project === project);
      }
      if (status) {
        agents = agents.filter(a => a.status === status);
      }

      const result = agents.map(a => ({
        id: a.id,
        name: a.name,
        role: a.role,
        status: a.status,
        project: a.project || null,
        currentTask: a.currentTask || null,
        openTasks: agentManager._getAgentTasks(a.id).filter(t => t.status !== 'done').length,
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
        agent = agentManager.agents.get(agent_id);
      } else if (agent_name) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.name.toLowerCase() === agent_name.toLowerCase()
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

      const result = {
        id: agent.id,
        name: agent.name,
        role: agent.role,
        description: agent.description,
        status: agent.status,
        project: agent.project || null,
        currentTask: agent.currentTask || null,
        enabled: agent.enabled !== false,
        todoList: agentManager._getAgentTasks(agent.id).map(t => ({
          id: t.id,
          text: t.text,
          status: t.status,
          project: t.project || null,
          boardId: t.boardId || null,
          createdAt: t.createdAt,
          completedAt: t.completedAt || null,
        })),
        metrics: {
          totalMessages: agent.metrics?.totalMessages || 0,
          totalTokensIn: agent.metrics?.totalTokensIn || 0,
          totalTokensOut: agent.metrics?.totalTokensOut || 0,
          totalErrors: agent.metrics?.totalErrors || 0,
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
    'List all task boards. Each board has its own workflow configuration. Use this to discover board IDs before adding tasks.',
    {},
    async () => {
      const boards = await getAllBoards();
      const result = boards.map(b => ({
        id: b.id,
        name: b.name,
        user: b.display_name || b.username || null,
        user_id: b.user_id,
        columns: (b.workflow?.columns || []).map(c => ({ id: c.id, label: c.label })),
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
    'Add a new task to an agent, optionally on a specific board. If there is only one board it is used automatically; otherwise provide board_id (use list_boards to find IDs).',
    {
      agent_id: z.string().optional().describe('Agent UUID'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id)'),
      task: z.string().describe('The task description'),
      project: z.string().optional().describe('Optional project to assign the task to'),
      status: z.string().optional().describe('Initial task status (any workflow column ID, defaults to "backlog")'),
      board_id: z.string().optional().describe('Board UUID to place the task on. If omitted and only one board exists, it is used automatically. Use list_boards to discover board IDs.'),
    },
    async ({ agent_id, agent_name, task, project, status, board_id }) => {
      console.log(`\u{1F4E5} [SwarmMCP] add_task called \u2014 agent_id: ${agent_id || '(none)'}, agent_name: ${agent_name || '(none)'}, project: ${project || '(none)'}, status: ${status || '(default)'}, board_id: ${board_id || '(auto)'}, task: ${task.slice(0, 100)}`);
      let agent = null;

      if (agent_id) {
        agent = agentManager.agents.get(agent_id);
      } else if (agent_name) {
        agent = Array.from(agentManager.agents.values()).find(
          a => a.name.toLowerCase() === agent_name.toLowerCase()
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

      // Resolve board_id: auto-pick if only one board exists
      let resolvedBoardId = board_id || null;
      if (!resolvedBoardId) {
        const boards = await getAllBoards();
        if (boards.length === 1) {
          resolvedBoardId = boards[0].id;
        } else if (boards.length > 1) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                error: 'Multiple boards exist. Please specify board_id. Use list_boards to see available boards.',
                boards: boards.map(b => ({ id: b.id, name: b.name, user: b.display_name || b.username })),
              }, null, 2),
            }],
            isError: true,
          };
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
      }

      const newTask = agentManager.addTask(agent.id, task, project || undefined, { type: 'mcp' }, status, { boardId: resolvedBoardId });
      console.log(`\u2705 [SwarmMCP] add_task \u2014 Task created for agent "${agent.name}" (${agent.id}) \u2014 task: ${newTask?.id}, project: ${project || '(none)'}, status: ${status || '(default)'}, board: ${resolvedBoardId || '(none)'}`);

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

  const messagesHandler = async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sessions.get(sessionId);

    if (!transport) {
      res.status(400).json({ error: 'No active SSE session for this sessionId' });
      return;
    }

    await transport.handlePostMessage(req, res, req.body);
  };

  return { sseHandler, messagesHandler };
}
