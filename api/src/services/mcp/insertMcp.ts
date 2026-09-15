// ── POST /api/mcp/insert — create tasks on ONE board, nothing else ──────────
//
// Reached only with an `insert` key (services/apiKeyManager.ts). That key is
// bound to a board when it is minted, so the board is never a tool argument:
// there is no id to guess and nothing else to reach. The guard has already
// re-proved the owner can edit that board (middleware/apiKeyAuth.ts); the tools
// re-resolve it anyway, both to read its live workflow and so that a server
// built without that guard still fails closed.
//
// Two tools, deliberately:
//   • get_board   — the board's name and columns, so a caller can pick a valid
//                   `status`. Board metadata only: no task is ever readable.
//   • create_task — the same field set and write as management `create_task`
//                   and `POST /api/insert/tasks` (services/mcp/taskInsertion.ts).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { jsonError, jsonOk } from '../mcpResponses.js';
import { createMcpHttpHandler } from '../mcpHttpHandler.js';
import type { AgentManager } from '../agentManager/index.js';
import { scopedBoard, type McpActor, type McpRecord } from './actorScope.js';
import { allowedBoardColumns, createBoardTask, createTaskFieldsShape } from './taskInsertion.js';

/**
 * What an insert key may learn about its own board: its name and the columns
 * the key may write to — not the ones it may not.
 */
export function insertBoardView(board: McpRecord, allowedColumns?: string[] | null) {
  const columns = allowedBoardColumns(board, allowedColumns) || board.workflow?.columns || [];
  return {
    id: board.id,
    name: board.name,
    columns: columns.map((c: McpRecord) => ({ id: c.id, label: c.label })),
  };
}

export interface InsertKeyContext {
  /** The key id, recorded on every task it creates. */
  apiKeyId: string;
  /** The board the key is bound to. */
  boardId: string;
  /** Column ids the key may write to; null = every column. */
  allowedColumns?: string[] | null;
}

export function createInsertMcpServer(
  agentManager: AgentManager,
  actor: McpActor,
  key: InsertKeyContext
) {
  const server = new McpServer({ name: 'PulsarTeam Insert', version: '1.0.0' });

  server.tool(
    'get_board',
    "Describe the board this key inserts into: its name and workflow columns. Use a column label or id as create_task's status.",
    {},
    async () => {
      const board = await scopedBoard(actor, key.boardId, 'edit');
      if (!board.ok) return board.error!;
      return jsonOk({ board: insertBoardView(board.value, key.allowedColumns) });
    }
  );

  server.tool(
    'create_task',
    "Create a task on this key's board. The task is created unassigned; status defaults to the board first column.",
    createTaskFieldsShape,
    async fields => {
      const board = await scopedBoard(actor, key.boardId, 'edit');
      if (!board.ok) return board.error!;
      const created = await createBoardTask(
        agentManager,
        actor,
        board.value,
        fields,
        { type: 'mcp', scope: 'insert', apiKeyId: key.apiKeyId },
        { allowedColumns: key.allowedColumns }
      );
      if (!created.ok) return jsonError(created.error || 'Failed to create task.');
      return jsonOk({ success: true, task: created.task });
    }
  );

  return server;
}

/** Express handler for POST /api/mcp/insert. */
export function createInsertMcpHandler(agentManager: AgentManager) {
  return createMcpHttpHandler('Insert', ctx => {
    if (!ctx.user || !ctx.apiKey?.boardId) {
      throw new Error('Insert MCP requires a board-bound insert API key');
    }
    return createInsertMcpServer(agentManager, ctx.user, {
      apiKeyId: ctx.apiKey.id,
      boardId: ctx.apiKey.boardId,
      allowedColumns: ctx.apiKey.allowedColumns ?? null,
    });
  });
}
