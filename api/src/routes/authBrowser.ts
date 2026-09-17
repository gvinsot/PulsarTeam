import { Router } from 'express';
import { z } from 'zod';
import { sessionUser } from '../middleware/auth.js';
import {
  isInternalServiceSession,
  checkAgentIdAccess,
  checkBoardIdAccess,
} from '../lib/agentAccess.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { BrowserCommandError } from '../services/authBrowser.js';
import { browserCommand, browserConfigured, type BrowserScope } from '../services/authBrowser.js';

const schema = z
  .object({
    agentId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,200}$/)
      .optional(),
    boardId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,200}$/)
      .optional(),
    operation: z.enum([
      'status',
      'start',
      'frame',
      'click',
      'text',
      'key',
      'wheel',
      'back',
      'home',
      'activate',
      'takeover',
      'disconnect',
    ]),
    sessionId: z.string().uuid().optional(),
    url: z.string().url().max(4000).optional(),
    loginOrigins: z.array(z.string().url().max(500)).max(10).optional(),
    text: z.string().max(4000).optional(),
    x: z.number().int().min(0).max(1279).optional(),
    y: z.number().int().min(0).max(799).optional(),
    delta: z.number().int().min(-1400).max(1400).optional(),
  })
  .strict()
  .refine(s => Boolean(s.agentId) !== Boolean(s.boardId), 'Choisissez un agent ou un board.');

export function authBrowserRoutes() {
  const router = Router();
  // POST even for frames/status: never cache or embed a login screenshot via URL.
  router.post(
    '/control',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const user = sessionUser(req, res);
      if (!user) return;
      if (!user.userId || isInternalServiceSession(user) || req.apiKey) {
        res
          .status(403)
          .json({ error: 'Une session utilisateur est requise pour connecter le navigateur.' });
        return;
      }
      const input = schema.parse(req.body);
      const scope: BrowserScope = input.agentId
        ? { type: 'agent', id: input.agentId }
        : { type: 'board', id: input.boardId! };
      // A screenshot of a login page is sensitive, even when ostensibly reading.
      const access =
        scope.type === 'agent'
          ? await checkAgentIdAccess(scope.id, user, 'edit')
          : await checkBoardIdAccess(scope.id, user, 'edit');
      if (!access.ok) {
        res.status(access.status || 403).json({ error: access.error });
        return;
      }
      if (input.operation === 'status' && !browserConfigured()) {
        res.json({ configured: false, exists: false, connected: false });
        return;
      }
      const {
        operation,
        sessionId,
        loginOrigins,
        agentId: _agent,
        boardId: _board,
        ...params
      } = input;
      try {
        const result = await browserCommand(scope, operation, {
          ...params,
          session_id: sessionId,
          login_origins: loginOrigins,
          controller: user.userId,
        });
        res.json({ ...result, configured: true });
      } catch (error) {
        if (error instanceof BrowserCommandError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res
          .status(503)
          .json({ error: 'Le service de navigateur est indisponible ou non configuré.' });
      }
    })
  );
  return router;
}
