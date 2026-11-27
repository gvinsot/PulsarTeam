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
import {
  browserCommand,
  browserConfigured,
  browserSessionKey,
  browserStateEnvironment,
  listBrowserSessions,
  type BrowserScope,
  type BrowserStatus,
} from '../services/authBrowser.js';
import { browserCredentials } from '../schemas/authBrowserSessions.js';
import {
  browserCredentialKeys,
  deleteBrowserCredentials,
  saveBrowserCredentials,
} from '../services/database/authBrowserSessions.js';

// No arbitrary cookie domains/storage origins. The sole domain marker preserves
// Instagram parent-cookie provenance for the worker's fixed publishing API host.
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
            domain: z.literal('.instagram.com').optional(),
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
    operation: z.enum([
      'status',
      'prepare_import',
      'import',
      'activate',
      'takeover',
      'disconnect',
      'set_lifetime',
      'set_credentials',
      'clear_credentials',
      'relogin',
    ]),
    sessionId: z.string().uuid().optional(),
    // Which of the scope's websites a session command targets (its origin).
    site: z.string().url().max(300).optional(),
    url: z.string().url().max(4000).optional(),
    storage: storageSchema.optional(),
    // `set_lifetime`: the worker's LIFETIME_HOURS.
    lifetimeHours: z
      .union([z.literal(8), z.literal(24), z.literal(168), z.literal(720)])
      .optional(),
    // `set_credentials`: validated again by browserCredentials before storage.
    credentials: z
      .object({
        username: z.string().max(500),
        password: z.string().max(1000),
        totpSecret: z.string().max(200).optional(),
        loginUrl: z.string().max(4000).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine(s => Boolean(s.agentId) !== Boolean(s.boardId), 'Choose an agent or a board.');

const CREDENTIAL_OPERATIONS = new Set(['set_credentials', 'clear_credentials']);

/** Flag the websites whose sign-in credentials are stored. Best effort. */
async function withAutoLogin(scope: BrowserScope, sessions: BrowserStatus[]) {
  const environment = browserStateEnvironment();
  const keyOf = (s: BrowserStatus) => (s.site ? browserSessionKey(scope, s.site) : '');
  let stored = new Set<string>();
  if (environment) {
    try {
      stored = await browserCredentialKeys(environment, sessions.map(keyOf).filter(Boolean));
    } catch {
      // Status stays available when the database is not.
    }
  }
  return sessions.map(s => ({ ...s, autoLogin: stored.has(keyOf(s)) }));
}

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
        res.status(403).json({ error: 'A user session is required to connect the browser.' });
        return;
      }
      const parsed = schema.safeParse(req.body);
      // Validation errors must never echo imported credentials.
      if (!parsed.success || Buffer.byteLength(JSON.stringify(req.body)) > 512_000) {
        res.status(400).json({ error: 'Invalid command or session data.' });
        return;
      }
      const input = parsed.data;
      if (
        input.storage?.cookies.some(cookie => cookie.domain) &&
        (!input.url || new URL(input.url).origin !== 'https://www.instagram.com')
      ) {
        res.status(400).json({ error: 'Invalid cookie scope for this website.' });
        return;
      }
      if (input.operation === 'import' && !input.url) {
        res.status(400).json({
          error:
            'Update the PulsarTeam extension, then transfer the session from the signed-in website page.',
        });
        return;
      }
      if (
        (input.operation === 'import') !== Boolean(input.storage) ||
        (input.operation === 'import' && !input.sessionId)
      ) {
        res.status(400).json({ error: 'Invalid session transfer.' });
        return;
      }
      const scope: BrowserScope = {
        ...(input.agentId
          ? { type: 'agent' as const, id: input.agentId }
          : { type: 'board' as const, id: input.boardId! }),
      };
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
        lifetimeHours,
        credentials,
        ...params
      } = input;
      if ((operation === 'set_lifetime') !== Boolean(lifetimeHours)) {
        res.status(400).json({ error: 'Choose a supported session lifetime.' });
        return;
      }
      if ((operation === 'set_credentials') !== Boolean(credentials)) {
        res.status(400).json({ error: 'Invalid sign-in credentials.' });
        return;
      }
      try {
        if (operation === 'status') {
          // One entry per website shared with this agent or board.
          const sessions = await withAutoLogin(
            scope,
            await listBrowserSessions(scope, user.userId)
          );
          res.json({
            configured: true,
            exists: sessions.length > 0,
            connected: sessions.some(s => s.connected),
            sessions,
          });
          return;
        }
        if (CREDENTIAL_OPERATIONS.has(operation)) {
          const environment = browserStateEnvironment();
          if (!environment) {
            res.status(503).json({
              error: 'Automatic sign-in requires persistent browser sessions (APP_ENVIRONMENT).',
            });
            return;
          }
          // Only the user who shared this website session manages its
          // credentials: the worker reports canControl for that user alone.
          const origin = params.site ? new URL(params.site).origin : '';
          const session = (await listBrowserSessions(scope, user.userId)).find(
            s =>
              Boolean(origin) &&
              s.site === origin &&
              s.sessionId === sessionId &&
              s.canControl &&
              s.phase !== 'pending'
          );
          if (!session || !sessionId) {
            res.status(403).json({
              error: 'Only the user who shared this website can manage its automatic sign-in.',
            });
            return;
          }
          const key = browserSessionKey(scope, origin);
          if (operation === 'clear_credentials') {
            await deleteBrowserCredentials(environment, key);
            res.json({ ...session, autoLogin: false, configured: true });
            return;
          }
          const stored = browserCredentials.safeParse({
            username: credentials?.username,
            password: credentials?.password,
            ...(credentials?.totpSecret?.trim() ? { totp_secret: credentials.totpSecret } : {}),
            ...(credentials?.loginUrl?.trim() ? { login_url: credentials.loginUrl.trim() } : {}),
          });
          // Never echo the submitted values, not even in validation details.
          if (
            !stored.success ||
            (stored.data.login_url && new URL(stored.data.login_url).origin !== origin)
          ) {
            res.status(400).json({
              error:
                'Invalid sign-in credentials. The sign-in page must be on the shared website and the TOTP secret in base32.',
            });
            return;
          }
          await saveBrowserCredentials(environment, key, stored.data);
          // Resets the failure counter and signs in now if the website already
          // rejected the session.
          const result = await browserCommand(scope, 'relogin', {
            site: origin,
            session_id: sessionId,
            controller: user.userId,
          });
          res.json({ ...result, autoLogin: true, configured: true });
          return;
        }
        const result = await browserCommand(scope, operation, {
          ...params,
          ...(lifetimeHours ? { lifetime_hours: lifetimeHours } : {}),
          session_id: sessionId,
          controller: user.userId,
        });
        const environment = browserStateEnvironment();
        if (operation === 'disconnect' && params.site && environment) {
          // The worker deletes them with its snapshot; this also covers a
          // worker running without persistence.
          await deleteBrowserCredentials(environment, browserSessionKey(scope, params.site)).catch(
            () => undefined
          );
        }
        res.json({ ...result, configured: true });
      } catch (error) {
        if (error instanceof BrowserCommandError) {
          res.status(error.status).json({ error: error.message });
          return;
        }
        res.status(503).json({ error: 'The browser service is unavailable or not configured.' });
      }
    })
  );
  return router;
}
