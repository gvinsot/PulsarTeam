import type { Request, Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { checkAgentIdAccess, checkBoardIdAccess } from '../lib/agentAccess.js';
import { errorMessage } from '../lib/errors.js';

/**
 * Agent context for one MCP request.
 *
 * It arrives as the X-Agent-Id / X-Board-Id request headers, which are
 * CLIENT-SUPPLIED — the MCP client in services/mcpManager.ts sets them, but so
 * can anyone else holding a session. The handler below therefore authorizes
 * them (lib/agentAccess.ts) before they ever reach `buildServer`; a context
 * that survives that check is one the caller is entitled to act under.
 *
 * Servers that don't need agent context simply ignore it.
 */
export type McpHandlerContext = {
  agentId: string | null;
  boardId: string | null;
};

/** First value of a possibly-repeated header, trimmed, or null when absent. */
function headerValue(raw: string | string[] | undefined): string | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Create an Express handler for an internal MCP endpoint (Streamable HTTP).
 * This bridges HTTP requests to the MCP server: POST-only check, agent-context
 * authorization, per-request transport + server, and a uniform catch-log-500
 * error shape.
 *
 * ── Why the authorization is here ────────────────────────────────────────────
 * The 16 internal MCP endpoints are mounted in src/index.ts as
 * `app.all(path, authenticateToken, handler)`. That proves WHO is calling; it
 * proved nothing about WHICH agent they may call as. The agent id is what
 * selects an agent's stored OAuth tokens (Gmail, Slack, Drive, GitHub…) and,
 * for /api/local-folder/mcp, which user's desktop bridge the file tools reach,
 * so an unchecked X-Agent-Id let any authenticated account act as any agent on
 * the instance. Both headers are now checked at 'edit' level: an MCP call is
 * always an action taken AS the agent, never a read of it.
 *
 * A request that sends NEITHER header is untouched — most MCP servers are
 * global and take no agent context, and the external Swarm API mount
 * (/api/swarm/mcp, API-key auth) is one of them.
 *
 * @param label - Log label, e.g. 'Gmail' → "[Gmail MCP] Error:".
 * @param buildServer - Builds the MCP server for one request, given the
 *   authorized X-Agent-Id / X-Board-Id header values.
 */
export function createMcpHttpHandler(
  label: string,
  buildServer: (ctx: McpHandlerContext) => McpServer
) {
  return async (req: Request, res: Response): Promise<void> => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      const agentId = headerValue(req.headers['x-agent-id']);
      const boardId = headerValue(req.headers['x-board-id']);

      if (agentId || boardId) {
        // Claimed agent context needs a session to be judged against. The
        // API-key mount (/api/swarm/mcp) attaches none, so a caller on that
        // path cannot claim an agent — it must address tasks by id instead,
        // which is what the Swarm API tools already do.
        const user = req.user;
        if (!user) {
          res.status(403).json({ error: 'Agent context requires an authenticated session' });
          return;
        }
        if (agentId) {
          const access = await checkAgentIdAccess(agentId, user, 'edit');
          if (!access.ok) {
            console.warn(
              `⛔ [${label} MCP] Rejected X-Agent-Id ${agentId} for ${user.username || 'unknown'}: ${access.error}`
            );
            res.status(access.status || 403).json({ error: access.error });
            return;
          }
        }
        if (boardId) {
          const access = await checkBoardIdAccess(boardId, user, 'edit');
          if (!access.ok) {
            console.warn(
              `⛔ [${label} MCP] Rejected X-Board-Id ${boardId} for ${user.username || 'unknown'}: ${access.error}`
            );
            res.status(access.status || 403).json({ error: access.error });
            return;
          }
        }
      }

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer({ agentId, boardId });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error(`[${label} MCP] Error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: errorMessage(err) });
      }
    }
  };
}
