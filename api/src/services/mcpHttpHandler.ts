import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

/**
 * Agent context extracted from the request headers (set by MCPManager for
 * per-agent calls). Servers that don't need agent context simply ignore it.
 */
export type McpHandlerContext = {
  agentId: string | null;
  boardId: string | null;
};

/**
 * Create an Express handler for an internal MCP endpoint (Streamable HTTP).
 * This bridges HTTP requests to the MCP server: POST-only check, per-request
 * transport + server, and a uniform catch-log-500 error shape.
 *
 * @param label - Log label, e.g. 'Gmail' → "[Gmail MCP] Error:".
 * @param buildServer - Builds the MCP server for one request, given the
 *   X-Agent-Id / X-Board-Id header values.
 */
export function createMcpHttpHandler(
  label: string,
  buildServer: (ctx: McpHandlerContext) => McpServer,
) {
  return async (req: any, res: any) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Method not allowed' });
      return;
    }
    try {
      // Read agent context from custom headers (set by MCPManager for per-agent calls)
      const agentId = (req.headers['x-agent-id'] as string) || null;
      const boardId = (req.headers['x-board-id'] as string) || null;

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const server = buildServer({ agentId, boardId });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err: any) {
      console.error(`[${label} MCP] Error:`, err);
      if (!res.headersSent) {
        res.status(500).json({ error: err.message });
      }
    }
  };
}
