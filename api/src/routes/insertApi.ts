import express from 'express';
import rateLimit from 'express-rate-limit';
import { asyncHandler } from '../lib/asyncHandler.js';
import { validateBody } from '../lib/validate.js';
import { checkBoardAccess } from '../middleware/authz.js';
import type { AgentManager } from '../services/agentManager/index.js';
import { createBoardTask, createTaskFieldsSchema } from '../services/mcp/taskInsertion.js';
import { insertBoardView } from '../services/mcp/insertMcp.js';

/** Per-key ceiling on top of the global per-IP limiter in src/index.ts. */
export const INSERT_RATE_LIMIT_PER_MINUTE = 60;

/**
 * /api/insert — the REST twin of /api/mcp/insert, for webhooks, forms, cron
 * jobs and scripts that do not speak MCP.
 *
 *   GET  /api/insert/board  — the key's board: name and workflow columns
 *   POST /api/insert/tasks  — create one task on that board
 *
 * Mounted behind `requireApiKeyScope('insert')` (src/index.ts), which resolves
 * the key's owner AND re-proves the owner can still edit the key's board. The
 * board is never read from the request: it is the one the key was minted for.
 *
 * The request body is `createTaskFieldsSchema`, the very shape management and
 * insert `create_task` publish, and the API documentation is generated from it
 * (services/apiDocs.ts).
 */
export function insertApiRoutes(agentManager: AgentManager) {
  const router = express.Router();

  // Keyed on the API key, not the IP: several integrations behind one NAT must
  // not starve each other, and one leaked key must not borrow another's budget.
  router.use(
    rateLimit({
      windowMs: 60 * 1000,
      max: INSERT_RATE_LIMIT_PER_MINUTE,
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: req => `insert-key:${req.apiKey?.id ?? 'unknown'}`,
      message: { error: 'Too many requests for this API key, please slow down.' },
    })
  );

  /** The key's board, re-read live. The guard proved access a moment ago. */
  async function keyBoard(req: express.Request) {
    const access = await checkBoardAccess(
      req.apiKey?.boardId,
      req.user!.userId,
      req.user!.role,
      'edit'
    );
    return access.ok ? access.board : null;
  }

  router.get(
    '/board',
    asyncHandler(async (req, res) => {
      const board = await keyBoard(req);
      if (!board)
        return res.status(403).json({ error: "API key owner can no longer edit this key's board" });
      res.json({ board: insertBoardView(board, req.apiKey!.allowedColumns) });
    })
  );

  router.post(
    '/tasks',
    validateBody(createTaskFieldsSchema),
    asyncHandler(async (req, res) => {
      const board = await keyBoard(req);
      if (!board)
        return res.status(403).json({ error: "API key owner can no longer edit this key's board" });

      const created = await createBoardTask(
        agentManager,
        req.user!,
        board,
        req.body,
        { type: 'api', scope: 'insert', apiKeyId: req.apiKey!.id },
        { allowedColumns: req.apiKey!.allowedColumns }
      );
      if (!created.ok) {
        return res
          .status(created.kind === 'invalid' ? 400 : 500)
          .json({ error: created.error, ...(created.taskId ? { task_id: created.taskId } : {}) });
      }
      res.status(201).json({ success: true, task: created.task });
    })
  );

  return router;
}
