import express from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { asyncHandler } from '../lib/asyncHandler.js';
import { sessionUser } from '../middleware/auth.js';
import { checkAgentIdAccess, checkBoardIdAccess } from '../lib/agentAccess.js';
import type { SessionClaims } from '../middleware/session.js';
import { getUserById } from '../services/database.js';
import type { MCPManager } from '../services/mcpManager.js';
import type { SkillManager } from '../services/skillManager.js';
import { searchRegistry, getRegistryServer } from '../services/mcpRegistry.js';
import {
  beginRemoteOAuth,
  finishRemoteOAuth,
  remoteClientMetadata,
  REMOTE_CALLBACK_PATH,
  REMOTE_METADATA_PATH,
  remoteKeyHeaders,
  useRemoteClient,
} from '../services/remoteMcp.js';
import {
  readRemoteCredentials,
  writeRemoteCredentials,
  peekRemoteFlow,
  consumeRemoteFlow,
  withRemoteLock,
  disconnectRemote,
  type RemoteScope,
} from '../services/remoteMcpStore.js';
import { sendOAuthResult } from './oauthHelper.js';

const scopeSchema = z
  .object({
    agentId: z.string().min(1).max(200).optional(),
    boardId: z.string().min(1).max(200).optional(),
  })
  .refine(s => Boolean(s.agentId) !== Boolean(s.boardId), 'Choisissez un agent ou un board.');
function scopeFrom(raw: unknown): RemoteScope {
  const data = scopeSchema.parse(raw);
  return data.agentId ? { type: 'agent', id: data.agentId } : { type: 'board', id: data.boardId! };
}
async function checkScope(scope: RemoteScope, user: SessionClaims, level: 'read' | 'edit') {
  return scope.type === 'agent'
    ? checkAgentIdAccess(scope.id, user, level)
    : checkBoardIdAccess(scope.id, user, level);
}
async function authorize(
  req: express.Request,
  res: express.Response,
  raw: unknown,
  level: 'read' | 'edit'
) {
  const user = sessionUser(req, res);
  if (!user?.userId) return null;
  const scope = scopeFrom(raw);
  const access = await checkScope(scope, user, level);
  if (!access.ok) {
    res.status(access.status || 403).json({ error: access.error });
    return null;
  }
  return { scope, user };
}
function origin(req: express.Request) {
  return `${req.protocol}://${req.get('host')}`;
}

export function remoteMcpPublicRoutes(manager: MCPManager) {
  const router = express.Router();
  router.get('/oauth/client-metadata', (req, res) => {
    const base = origin(req);
    res.json({
      client_id: `${base}${REMOTE_METADATA_PATH}`,
      ...remoteClientMetadata(`${base}${REMOTE_CALLBACK_PATH}`),
    });
  });
  router.get(
    '/oauth/callback',
    asyncHandler(async (req, res) => {
      const state = typeof req.query.state === 'string' ? req.query.state : '';
      let serverId: string | undefined;
      try {
        const pending = await peekRemoteFlow(state);
        if (!pending)
          throw new Error('Autorisation expirée ou déjà utilisée. Recommencez la connexion.');
        serverId = pending.serverId;
        await withRemoteLock(pending.serverId, pending.scope, async () => {
          const flow = await consumeRemoteFlow(state);
          if (!flow) throw new Error('Autorisation expirée ou déjà utilisée.');
          if (req.query.error) throw new Error('Autorisation refusée par le fournisseur.');
          const code = z.string().min(1).max(8000).parse(req.query.code);
          const user = await getUserById(flow.userId);
          if (!user) throw new Error('Compte utilisateur introuvable.');
          const access = await checkScope(
            flow.scope,
            { userId: user.id, username: user.username, role: user.role } as SessionClaims,
            'edit'
          );
          if (!access.ok) throw new Error('Vous n’avez plus accès à cet agent ou board.');
          const server = manager.getById(flow.serverId);
          if (
            !server ||
            server.remoteAuth !== 'oauth' ||
            server.url !== flow.credentials.url ||
            server.enabled === false
          )
            throw new Error('Configuration MCP modifiée. Recommencez la connexion.');
          const expectedIssuer = flow.credentials.discovery?.authorizationServerMetadata?.issuer;
          if (req.query.iss && req.query.iss !== expectedIssuer)
            throw new Error('OAuth issuer mismatch');
          await finishRemoteOAuth(flow.credentials, code);
          await writeRemoteCredentials(flow.serverId, flow.scope, flow.credentials);
        });
        sendOAuthResult(res, 'MCP', 'remote-mcp-oauth-callback', true, null, { service: serverId });
      } catch {
        // Do not render upstream error bodies (possibly HTML or secrets) in the popup.
        sendOAuthResult(
          res,
          'MCP',
          'remote-mcp-oauth-callback',
          false,
          'Connexion impossible, refusée ou expirée. Vérifiez la configuration puis réessayez.',
          { service: serverId }
        );
      }
    })
  );
  return router;
}

export function remoteMcpRoutes(manager: MCPManager, skills: SkillManager) {
  const router = express.Router();
  router.get(
    '/catalog',
    asyncHandler(async (req, res) => {
      const query = z
        .object({ search: z.string().max(200).optional(), cursor: z.string().max(2000).optional() })
        .parse(req.query);
      res.json(await searchRegistry(query.search, query.cursor));
    })
  );
  router.post(
    '/catalog/install',
    asyncHandler(async (req, res) => {
      const user = sessionUser(req, res);
      if (!user?.userId) return;
      const input = z
        .object({
          name: z.string().max(300),
          version: z.string().max(200),
          remoteIndex: z.number().int().min(0),
          mode: z.enum(['oauth', 'api_key']),
        })
        .parse(req.body);
      const entry = await getRegistryServer(input.name, input.version);
      const remote = entry.remotes[input.remoteIndex];
      if (!remote) return res.status(400).json({ error: 'Endpoint MCP introuvable.' });
      const key = createHash('sha256')
        .update(JSON.stringify([entry.name, entry.version, remote.url, input.mode]))
        .digest('hex');
      let server = manager.getAll().find(s => s.registryKey === key);
      if (!server)
        server = await manager.create({
          name: `${entry.name} [${key.slice(0, 8)}]`,
          url: remote.url,
          description: entry.description,
          remoteAuth: input.mode,
          registryKey: key,
        });
      const plugin = await skills.create(
        {
          name: entry.title,
          description: entry.description,
          category: 'general',
          icon: '🔌',
          instructions: `Use the ${entry.title} MCP tools when relevant to the user's request.`,
          mcps: [
            {
              id: server.id,
              name: server.name,
              url: server.url,
              remoteAuth: input.mode,
              authMode: input.mode === 'oauth' ? 'oauth' : 'bearer',
            },
          ],
          registry: { name: entry.name, version: entry.version },
          shared: false,
        },
        user.userId
      );
      res.status(201).json(plugin);
    })
  );
  router.get(
    '/:id/status',
    asyncHandler(async (req, res) => {
      const ctx = await authorize(req, res, req.query, 'read');
      if (!ctx) return;
      const server = manager.getById(req.params.id);
      if (!server?.remoteAuth) return res.status(404).json({ error: 'MCP distant introuvable' });
      const record = await readRemoteCredentials(server.id, ctx.scope);
      const matches = record && record.url === server.url && record.mode === server.remoteAuth;
      res.json({
        configured: true,
        connected: !!(
          record &&
          matches &&
          (record.apiKey ||
            (record.tokens?.access_token &&
              (!record.expiresAt || record.expiresAt > Date.now() || record.tokens.refresh_token)))
        ),
        mode: server.remoteAuth,
      });
    })
  );
  router.post(
    '/:id/auth-url',
    asyncHandler(async (req, res) => {
      const ctx = await authorize(req, res, req.body, 'edit');
      if (!ctx) return;
      const server = manager.getById(req.params.id);
      if (!server || server.remoteAuth !== 'oauth' || server.enabled === false)
        return res.status(400).json({ error: 'OAuth MCP indisponible' });
      const clientId = z.string().trim().min(1).max(2000).optional().parse(req.body.clientId);
      const clientSecret = z.string().min(1).max(8000).optional().parse(req.body.clientSecret);
      if (clientSecret && !clientId)
        return res.status(400).json({ error: 'Client ID requis avec un secret OAuth.' });
      res.json(
        await beginRemoteOAuth(
          server,
          ctx.scope,
          ctx.user.userId,
          `${origin(req)}${REMOTE_CALLBACK_PATH}`,
          clientId,
          clientSecret
        )
      );
    })
  );
  router.post(
    '/:id/api-key',
    asyncHandler(async (req, res) => {
      const ctx = await authorize(req, res, req.body, 'edit');
      if (!ctx) return;
      const server = manager.getById(req.params.id);
      if (!server || server.remoteAuth !== 'api_key' || server.enabled === false)
        return res.status(400).json({ error: 'Clé API MCP indisponible' });
      const key = z
        .object({
          apiKey: z.string().min(1).max(8000),
          headerName: z.string().min(1).max(100).default('Authorization'),
          prefix: z.enum(['', 'Bearer ']).default('Bearer '),
        })
        .parse(req.body);
      const record = { ...key, url: server.url, mode: 'api_key' as const };
      remoteKeyHeaders(record);
      await withRemoteLock(server.id, ctx.scope, () =>
        writeRemoteCredentials(server.id, ctx.scope, record)
      );
      res.json({ success: true });
    })
  );
  router.post(
    '/:id/test',
    asyncHandler(async (req, res) => {
      const ctx = await authorize(req, res, req.body, 'edit');
      if (!ctx) return;
      const server = manager.getById(req.params.id);
      if (!server?.remoteAuth || server.enabled === false)
        return res.status(404).json({ error: 'MCP distant introuvable' });
      const count = await useRemoteClient(server, ctx.scope, async client => client.tools.length);
      res.json({ success: true, toolCount: count });
    })
  );
  router.post(
    '/:id/disconnect',
    asyncHandler(async (req, res) => {
      const ctx = await authorize(req, res, req.body, 'edit');
      if (!ctx) return;
      await disconnectRemote(req.params.id, ctx.scope);
      res.json({ success: true });
    })
  );
  return router;
}
