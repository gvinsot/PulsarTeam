import crypto from 'crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

/**
 * Creates an MCP server exposing swarm management tools:
 * - list_agents: List all agents with their status
 * - get_agent_status: Get detailed status for a specific agent
 * - add_task: Add a task/todo to an agent
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
        pendingTasks: (a.todoList || []).filter(t => t.status === 'pending').length,
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
    'Get detailed status for a specific agent including current task, todo list, and metrics.',
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
        todoList: (agent.todoList || []).map(t => ({
          id: t.id,
          text: t.text,
          status: t.status,
          project: t.project || null,
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

  // ── add_task ───────────────────────────────────────────────────────────
  server.tool(
    'add_task',
    'Add a new task (todo) to an agent. The agent will automatically pick it up when idle.',
    {
      agent_id: z.string().optional().describe('Agent UUID'),
      agent_name: z.string().optional().describe('Agent name (alternative to agent_id)'),
      task: z.string().describe('The task description'),
      project: z.string().optional().describe('Optional project to assign the task to'),
    },
    async ({ agent_id, agent_name, task, project }) => {
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

      const todo = agentManager.addTodo(agent.id, task, project || undefined);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            todo,
            agent: { id: agent.id, name: agent.name },
          }, null, 2),
        }],
      };
    }
  );

  return server;
}

/**
 * Creates an Express request handler for the Swarm API MCP endpoint.
 */
export function createSwarmApiMcpHandler(agentManager) {
  const mcpServer = createSwarmApiMcpServer(agentManager);
  const transports = new Map();

  return async (req, res) => {
    try {
      if (req.method === 'GET') {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        transports.set(transport.sessionId, transport);

        res.on('close', () => {
          transports.delete(transport.sessionId);
        });

        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const sessionId = req.headers['mcp-session-id'];
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId);
        await transport.handleRequest(req, res, req.body);
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      transports.set(transport.sessionId, transport);

      res.on('close', () => {
        transports.delete(transport.sessionId);
      });

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error('[Swarm API MCP] Error:', error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    }
  };
}
