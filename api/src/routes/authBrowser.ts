import { Router } from 'express';
import { z } from 'zod';
import { sessionUser } from '../middleware/auth.js';
import {
  isInternalServiceSession,
  checkAgentIdAccess,
  checkBoardIdAccess,
} from '../lib/agentAccess.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { BrowserCommandError, LINKEDIN_ORIGIN } from '../services/authBrowser.js';
import { browserCommand, browserConfigured, type BrowserScope } from '../services/authBrowser.js';

// Never accept cookie domains, alternate storage origins or arbitrary browser state.
const storageSchema = z
  .object({
    cookies: z
      .array(
        z
          .object({
            name: z.string().min(1).max(256),
            value: z.string().max(8192),
            path: z.string().startsWith('/').max(2000),
            expires: z.number().finite().min(-1).max(253402300799),
            httpOnly: z.boolean(),
            sameSite: z.enum(['Strict', 'Lax', 'None']),
          })
          .strict()
      )
      .max(200),
    localStorage: z
      .array(
        z
          .object({
            name: z.string().max(1000),
            value: z.string().max(65536),
          })
          .strict()
      )
      .max(200),
  })
  .strict();

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
    operation: z.enum(['status', 'prepare_import', 'import', 'activate', 'takeover', 'disconnect']),
    // Site-pinned plugin (LinkedIn): its own session slot, and the site is not selectable.
    site: z.enum(['linkedin']).optional(),
    sessionId: z.string().uuid().optional(),
    url: z.string().url().max(4000).optional(),
    storage: storageSchema.optional(),
  })
  .strict()
  .refine(s => Boolean(s.agentId) !== Boolean(s.boardId), 'Choisissez un agent ou un board.');

export function authBrowserRoutes() {
  const router = Router();
  // Normal session + CSRF through the selected app tab; no public upload endpoint.
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
      const parsed = schema.safeParse(req.body);
      // Validation errors must never echo imported credentials.
      if (!parsed.success || Buffer.byteLength(JSON.stringify(req.body)) > 512_000) {
        res.status(400).json({ error: 'Commande ou session à transférer invalide.' });
        return;
      }
      const input = parsed.data;
      if (
        (input.operation === 'import') !== Boolean(input.storage) ||
        (input.operation === 'import' && !input.sessionId)
      ) {
        res.status(400).json({ error: 'Transfert de session invalide.' });
        return;
      }
      const scope: BrowserScope = {
        ...(input.agentId
          ? { type: 'agent' as const, id: input.agentId }
          : { type: 'board' as const, id: input.boardId! }),
        ...(input.site ? { site: input.site } : {}),
      };
      if (input.site === 'linkedin' && input.url && new URL(input.url).origin !== LINKEDIN_ORIGIN) {
        res.status(400).json({ error: 'Ce plugin se connecte uniquement à www.linkedin.com.' });
        return;
      }
      // Importing or inspecting a shared session requires edit access.
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
        agentId: _agent,
        boardId: _board,
        site: _site,
        ...params
      } = input;
      try {
        const result = await browserCommand(scope, operation, {
          ...params,
          ...(input.site === 'linkedin' && operation === 'prepare_import'
            ? { url: `${LINKEDIN_ORIGIN}/` }
            : {}),
          session_id: sessionId,
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
