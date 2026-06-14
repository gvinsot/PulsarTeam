import express from 'express';
import {
  storeOAuthToken, getOAuthToken, deleteOAuthToken,
} from '../../services/database.js';
import type { OAuthProvider, ScopeType } from '../../services/database.js';

/**
 * Shared scaffolding for the "simple credential connector" plugin routes
 * (wordpress, jira, s3): /status, /connect (probe → store → log), /disconnect.
 *
 * Unlike oauthProviderRoutes (full OAuth2 with refresh), these providers use
 * static credentials (Basic Auth / API token / access keys) supplied directly
 * by the user. The only per-provider differences are the credential probe, the
 * /status identity fields, the success-log suffix, and the connect error mapping
 * — everything else (scope resolution, store-with-verify, disconnect) is shared.
 *
 * Resolution policy: agent → board (no user fallback; these are agent/board only).
 */

/** Storage scope for the credential connectors: agent → board, else null. */
export function resolveScope(
  agentId: string | null,
  boardId: string | null,
): { scopeType: ScopeType; scopeId: string } | null {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return null;
}

/** Resolve a provider's stored credentials with the agent → board fallback. */
export function getProviderCredentials<T>(
  provider: OAuthProvider,
  agentId: string | null,
  boardId: string | null = null,
): T | null {
  if (agentId) {
    const token = getOAuthToken(provider, 'agent', agentId);
    if (token) return token.meta as T;
  }
  if (boardId) {
    const token = getOAuthToken(provider, 'board', boardId);
    if (token) return token.meta as T;
  }
  return null;
}

/** Result of a successful credential probe in connect(). */
export interface ConnectSuccess {
  accessToken: string;
  meta: Record<string, any>;
  /** Extra fields merged into the /connect success JSON (alongside success/agentId/boardId). */
  extra?: Record<string, any>;
  /** Provider-specific success-log tail, e.g. `→ ${cleanUrl} (${me.name})`. */
  logSuffix: string;
}

/** Result of a failed probe / validation in connect(). */
export interface ConnectFailure {
  error: string;
  status?: number;
}

export type ConnectResult = ConnectSuccess | ConnectFailure;

export interface CredentialConnectorOptions {
  provider: OAuthProvider;
  /** Log label, e.g. 'WordPress' | 'Jira' | 'S3' (NOT capitalize(provider)). */
  label: string;
  /** Provider identity fields merged into the /status JSON. */
  statusFields: (meta: Record<string, any> | null | undefined) => Record<string, any>;
  /**
   * Validate the body and probe the credentials. Returns either the data to
   * store (accessToken/meta/extra/logSuffix) or a {error,status} to send.
   * Required-field validation lives here and returns {error, status: 400}.
   */
  connect: (body: any) => Promise<ConnectResult>;
  /**
   * Maps a thrown error (probe failure, store-persist failure) to the response
   * status + message. Preserves each provider's exact catch behavior.
   */
  onError: (err: any) => { status: number; message: string };
}

function isFailure(r: ConnectResult): r is ConnectFailure {
  return (r as ConnectFailure).error !== undefined;
}

export function credentialConnectorRoutes(opts: CredentialConnectorOptions): express.Router {
  const router = express.Router();
  const { provider, label } = opts;

  router.get('/status', (req, res) => {
    const agentId = (req.query.agentId as string) || null;
    const boardId = (req.query.boardId as string) || null;
    if (!agentId && !boardId) {
      return res.json({ connected: false, agentId: null, boardId: null });
    }
    const scope = resolveScope(agentId, boardId);
    if (!scope) return res.json({ connected: false });
    const token = getOAuthToken(provider, scope.scopeType, scope.scopeId);
    res.json({
      connected: !!token,
      ...opts.statusFields(token?.meta),
      agentId,
      boardId,
    });
  });

  router.post('/connect', async (req, res) => {
    const body = req.body || {};
    const { agentId, boardId } = body;

    try {
      const result = await opts.connect(body);
      if (isFailure(result)) {
        return res.status(result.status ?? 400).json({ error: result.error });
      }

      const scope = resolveScope(agentId, boardId)!;
      await storeOAuthToken({
        provider,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        accessToken: result.accessToken,
        meta: result.meta,
      }, { throwOnPersistError: true });

      const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
      console.log(`✅ [${label}] Credentials stored for ${target} ${result.logSuffix}`);
      res.json({ success: true, agentId, boardId, ...(result.extra || {}) });
    } catch (err: any) {
      console.error(`[${label}] Connection test failed:`, err);
      const { status, message } = opts.onError(err);
      res.status(status).json({ error: message });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    if (!agentId && !boardId) {
      return res.status(400).json({ error: 'agentId or boardId is required' });
    }
    const scope = resolveScope(agentId, boardId)!;
    await deleteOAuthToken(provider, scope.scopeType, scope.scopeId);
    const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
    console.log(`🔌 [${label}] Disconnected ${target}`);
    res.json({ success: true });
  });

  return router;
}
