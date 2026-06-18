import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createMcpHttpHandler } from './mcpHttpHandler.js';
import { applyTaskUpdate } from './swarmApiMcp.js';
import { BUILTIN_MCP_SERVERS } from '../data/mcpServers.js';
import { getBoardById } from './database.js';

/**
 * Pulsar Gateway MCP — the SINGLE MCP server injected into every CLI runner
 * agent (claude-code / codex / opencode / openclaw / hermes). It replaces the
 * old per-plugin static MCP wiring with two always-on capabilities:
 *
 *  1. Task control that is ALWAYS available regardless of attached plugins:
 *     - update_current_task  — move the agent's current task between board
 *       columns (auto-resolves the active task, like task_execution_complete).
 *     - task_execution_complete — signal the current task is finished.
 *
 *  2. A dynamic plugin layer. Plugins / MCP servers can be attached to the
 *     agent OR to the board at any time, so instead of freezing a tool list at
 *     spawn we expose:
 *     - list_mcps      — enumerate the MCP servers currently available to this
 *       agent (agent plugins ∪ board plugins ∪ direct agent MCPs ∪ Swarm API),
 *       WITH each tool's JSON input schema so the model can call them correctly.
 *     - call_mcp_tool  — invoke a tool on one of those servers. Auth + routing
 *       (per-agent API keys, internal JWT, X-Agent-Id / X-Board-Id board OAuth)
 *       is delegated to mcpManager.callToolByNameForAgent — the same audited
 *       path the native chat agent uses.
 *
 * `callerAgentId` / `callerBoardId` come from the X-Agent-Id / X-Board-Id
 * headers that mcpManager.getClaudeMcpConfigForAgent writes into the runner's
 * native MCP config at spawn (the gateway is declared agentContext:true in
 * INTERNAL_MCP_SERVERS so those headers always flow).
 */

/** Success envelope: pretty-printed JSON text content. */
const jsonOk = (obj: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(obj, null, 2) }],
});

/** Error envelope: compact `{ error }` JSON text content flagged isError. */
const jsonError = (error: string) => ({
  content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
  isError: true as const,
});

/** The gateway's own server id — never list/proxy itself. */
const GATEWAY_SERVER_ID = 'mcp-pulsar-gateway';
/** Always-available swarm management server (list_agents, add_task, …). */
const SWARM_API_SERVER_ID = 'mcp-swarm-api';

/**
 * Resolve the set of MCP server ids this agent may use, mirroring the native
 * chat dispatch gate (agentManager/tools/handlers.ts): agent plugins ∪ board
 * plugins ∪ direct agent.mcpServers, plus the always-on Swarm API server. The
 * gateway itself is excluded.
 */
async function resolveAvailableServerIds(
  skillManager: any,
  agent: any,
  boardId: string | null,
): Promise<Set<string>> {
  const ids = new Set<string>([SWARM_API_SERVER_ID]);

  const agentSkillIds: string[] = Array.isArray(agent.skills) ? agent.skills : [];
  let boardPluginIds: string[] = [];
  const effectiveBoardId = agent.boardId || boardId;
  if (effectiveBoardId) {
    try {
      const board = await getBoardById(effectiveBoardId);
      if (board && Array.isArray(board.plugins)) boardPluginIds = board.plugins;
    } catch { /* board may not exist */ }
  }

  for (const sid of new Set([...agentSkillIds, ...boardPluginIds])) {
    const plugin = skillManager ? skillManager.getById(sid) : null;
    if (plugin && Array.isArray((plugin as any).mcpServerIds)) {
      for (const mid of (plugin as any).mcpServerIds) ids.add(mid);
    }
  }
  for (const mid of (agent.mcpServers || [])) ids.add(mid);

  ids.delete(GATEWAY_SERVER_ID);
  return ids;
}

/**
 * Resolve the agent's current/active task id, using the same priority order as
 * applyTaskExecutionComplete: a task actively running via this agent, then a
 * task assigned to it, then its own active task. Returns null when none.
 */
function resolveCurrentTaskId(agentManager: any, agentId: string): string | null {
  let found = agentManager._findTaskAcross(
    (t: any) => t.actionRunningAgentId === agentId && agentManager._isActiveTaskStatus(t.status),
  );
  if (!found) {
    found = agentManager._findTaskAcross(
      (t: any) => agentManager._isActiveTaskStatus(t.status) && t.assignee === agentId,
    );
  }
  if (found) return found.task.id;

  const own = agentManager._getAgentTasks(agentId).find((t: any) => agentManager._isActiveTaskStatus(t.status));
  return own ? own.id : null;
}

/** Resolve a server name or id to a known server id without auto-registering it. */
function resolveServerId(mcpManager: any, nameOrId: string): string | null {
  const wanted = String(nameOrId || '').toLowerCase();
  for (const s of mcpManager.servers.values()) {
    if (s.name && s.name.toLowerCase() === wanted) return s.id;
    if (s.id && s.id.toLowerCase() === wanted) return s.id;
  }
  // Fallback to the static builtin catalog for servers not yet registered in
  // the live server map (matches mcpManager.findBuiltinMcpServer semantics).
  const builtin = BUILTIN_MCP_SERVERS.find(
    (b) => b.id.toLowerCase() === wanted || b.name.toLowerCase() === wanted,
  );
  return builtin ? builtin.id : null;
}

export function createPulsarGatewayMcpServer(
  agentManager: any,
  mcpManager: any,
  skillManager: any,
  callerAgentId: string | null = null,
  callerBoardId: string | null = null,
) {
  const server = new McpServer({ name: 'Pulsar Gateway', version: '1.0.0' });

  // ── update_current_task ──────────────────────────────────────────────────
  server.tool(
    'update_current_task',
    'Move YOUR current task to a different board column (status), or rebind its repo/storage. The task is auto-detected from your active assignment — you do not need a task_id. Use this whenever your work changes column (e.g. moving to "In Review" or "Done").',
    {
      status: z.string().optional().describe('Target column — workflow column label preferred (e.g. "In Review", "Done"); the column id is also accepted.'),
      repo_full_name: z.string().optional().describe('New repository in "owner/repo" format. Empty string clears the binding.'),
      repo_provider: z.string().optional().describe('Repository provider — defaults to "github" when repo_full_name is set.'),
      storage_path: z.string().optional().describe('New storage location (e.g. OneDrive folder path). Empty string clears the binding.'),
      storage_provider: z.string().optional().describe('Storage provider — defaults to "onedrive" when storage_path is set.'),
      task_id: z.string().optional().describe('Optional — target a specific task instead of your auto-detected current one.'),
    },
    async ({ status, repo_full_name, repo_provider, storage_path, storage_provider, task_id }) => {
      if (!callerAgentId) {
        return jsonError('No agent context. update_current_task is only available to CLI runner agents.');
      }
      let resolvedTaskId = (task_id || '').trim();
      if (!resolvedTaskId) {
        const current = resolveCurrentTaskId(agentManager, callerAgentId);
        if (!current) {
          return jsonError('No active task found to update. Pass task_id explicitly, or ensure you have an in-progress task assigned to you.');
        }
        resolvedTaskId = current;
      }

      const r = await applyTaskUpdate(agentManager, {
        agent_id: callerAgentId,
        task_id: resolvedTaskId,
        status,
        repo_full_name,
        repo_provider,
        storage_path,
        storage_provider,
      });
      if (r.ok) {
        return jsonOk({ success: true, task: r.task });
      } else {
        return jsonError(r.error || 'Failed to update task.');
      }
    }
  );

  // ── task_execution_complete ──────────────────────────────────────────────
  // Native (not proxied) so it resolves the calling agent from callerAgentId,
  // shares agentManager.applyTaskExecutionComplete with the chat path, and
  // stays available even when the agent has no plugins.
  server.tool(
    'task_execution_complete',
    'Signal that you have finished executing your currently assigned task. You MUST call this when your work is done — until you do, the system considers the task still in progress and keeps sending reminders. Commit and push your code first.',
    {
      comment: z.string().describe('A brief summary of what was accomplished. Appended onto the task so the requester sees it.'),
      task_id: z.string().optional().describe('Task UUID to mark complete. Optional — auto-detected from your active task when omitted.'),
      commits: z.string().optional().describe('Optional already-pushed commits to link, comma-separated "hash:message, hash:message". Pushed commits are auto-linked even if omitted.'),
    },
    async ({ comment, task_id, commits }) => {
      const agentId = (callerAgentId || '').trim();
      if (!agentId) {
        return jsonError('No agent context. task_execution_complete is only available to CLI runner agents.');
      }
      const outcome = await agentManager.applyTaskExecutionComplete(agentId, {
        comment: comment || '',
        explicitTaskId: (task_id || '').trim(),
        commitsArg: (commits || '').trim(),
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: outcome.success,
            completed: Boolean(outcome.isTerminal),
            task_id: outcome.taskId || null,
            message: outcome.result,
          }, null, 2),
        }],
        ...(outcome.success ? {} : { isError: true as const }),
      };
    }
  );

  // ── list_mcps ─────────────────────────────────────────────────────────────
  server.tool(
    'list_mcps',
    'List the MCP servers currently available to you and the tools each one exposes (with input schemas). Plugins can be attached to you or to your board at any time, so ALWAYS call this first to discover what you can do — then invoke a tool with call_mcp_tool. Servers reported under "unavailable" need a credential that is not configured yet.',
    {},
    async () => {
      if (!callerAgentId) {
        return jsonError('No agent context. list_mcps is only available to CLI runner agents.');
      }
      const agent = agentManager.agents.get(callerAgentId);
      if (!agent) return jsonError(`Agent not found: ${callerAgentId}`);

      const allowedIds = await resolveAvailableServerIds(skillManager, agent, callerBoardId);
      const { tools, unavailable } = await mcpManager.getToolsForAgent(
        [...allowedIds],
        callerAgentId,
        agent.mcpAuth || {},
      );

      // Group the flat tool list by server.
      const byServer = new Map<string, { server: string; server_id: string; tools: any[] }>();
      for (const t of tools) {
        let entry = byServer.get(t.serverId);
        if (!entry) {
          entry = { server: t.serverName, server_id: t.serverId, tools: [] };
          byServer.set(t.serverId, entry);
        }
        entry.tools.push({
          name: t.name,
          description: t.description || '',
          input_schema: t.inputSchema || {},
        });
      }

      const mcps = [...byServer.values()];
      return jsonOk({
        count: mcps.length,
        mcps,
        unavailable: (unavailable || []).map((u: any) => ({
          server: u.serverName,
          server_id: u.serverId,
          status: u.status,
          reason: u.reason,
        })),
        hint: 'Invoke a tool with call_mcp_tool({ server, tool, args }). For board column moves use update_current_task; when finished use task_execution_complete.',
      });
    }
  );

  // ── call_mcp_tool ─────────────────────────────────────────────────────────
  server.tool(
    'call_mcp_tool',
    'Invoke a tool on one of the MCP servers reported by list_mcps. Routing and authentication (per-agent keys, board OAuth) are handled for you. Call list_mcps first to learn the exact server name, tool name, and argument schema.',
    {
      server: z.string().describe('MCP server name (or id) exactly as returned by list_mcps.'),
      tool: z.string().describe('Tool name on that server, as returned by list_mcps.'),
      args: z.record(z.string(), z.any()).optional().describe('Arguments object matching the tool\'s input schema.'),
    },
    async ({ server: serverName, tool: toolName, args }) => {
      if (!callerAgentId) {
        return jsonError('No agent context. call_mcp_tool is only available to CLI runner agents.');
      }
      const agent = agentManager.agents.get(callerAgentId);
      if (!agent) return jsonError(`Agent not found: ${callerAgentId}`);

      const resolvedId = resolveServerId(mcpManager, serverName);
      const allowedIds = await resolveAvailableServerIds(skillManager, agent, callerBoardId);
      if (!resolvedId || !allowedIds.has(resolvedId)) {
        return jsonError(`MCP server "${serverName}" is not available to you. Call list_mcps to see what you can use.`);
      }

      try {
        const result = await mcpManager.callToolByNameForAgent(
          serverName,
          toolName,
          args || {},
          callerAgentId,
          agent.mcpAuth || {},
          agent.boardId || callerBoardId || null,
        );
        const content: any[] = [{ type: 'text', text: result.result ?? '' }];
        if (Array.isArray(result.images)) {
          for (const img of result.images) {
            content.push({ type: 'image', data: img.data, mimeType: img.mediaType });
          }
        }
        return { content, ...(result.success ? {} : { isError: true as const }) };
      } catch (err: any) {
        return jsonError(`call_mcp_tool failed for ${serverName} → ${toolName}: ${err?.message || 'unknown error'}`);
      }
    }
  );

  return server;
}

/**
 * Express handler for the Pulsar Gateway MCP endpoint (Streamable HTTP).
 * X-Agent-Id / X-Board-Id are extracted by createMcpHttpHandler and passed to
 * the server builder so task tools and the proxy resolve the right agent/board.
 */
export function createPulsarGatewayMcpHandler(agentManager: any, mcpManager: any, skillManager: any) {
  return createMcpHttpHandler('Pulsar Gateway', ({ agentId, boardId }) =>
    createPulsarGatewayMcpServer(agentManager, mcpManager, skillManager, agentId, boardId));
}
