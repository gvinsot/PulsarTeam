import express from 'express';
import {
  storeOAuthToken,
  getOAuthToken,
  hasOAuthToken,
  deleteOAuthToken,
} from '../services/database.js';
import type { OAuthProvider, OAuthTokenRecord } from '../services/database.js';
import { resolveScope } from './oauthHelper.js';
import { sessionUser } from '../middleware/auth.js';
import {
  checkAgentIdAccess,
  checkBoardIdAccess,
  type AgentAccessLevel,
} from '../lib/agentAccess.js';
import { asyncHandler } from '../lib/asyncHandler.js';

/**
 * Shared scaffolding for the per-provider OAuth plugin routes
 * (/status, /auth-url, /disconnect) and the token-refresh flow.
 *
 * Each provider file (gdrive, gmail, onedrive, outlook, github, slack)
 * declares an OAuthProviderSpec describing what actually differs between
 * providers — config getter, consent-URL shape, state generation, identity
 * field on /status — and gets identical handler behavior for the rest.
 */

export interface OAuthProviderSpec<TConfig extends { clientId: string; clientSecret: string }> {
  provider: OAuthProvider;
  /** Log prefix, e.g. 'Gdrive' | 'OneDrive' | 'GitHub' (NOT a wire format). */
  label: string;
  getConfig(): TConfig | null;
  /** Exact error message returned (HTTP 500) by GET /auth-url when not configured — wire format. */
  notConfiguredError: string;
  /** Exact message thrown by makeRefresh when not configured (differs from notConfiguredError). */
  refreshNotConfiguredError?: string;
  /** Token endpoint used by makeRefresh — refresh-capable providers only. */
  refreshTokenUrl?(record: OAuthTokenRecord, config: TConfig): string;
  /** Builds the provider consent URL for GET /auth-url (scopes/endpoint/extras live here). */
  buildAuthUrl(req: express.Request, config: TConfig, state: string): string;
  /** Issues the HMAC-signed OAuth state. `req` lets onedrive read its consumer-flow flag. */
  generateState(
    username: string,
    agentId: string | null,
    boardId: string | null,
    req: express.Request
  ): string;
  /** Provider-specific identity field(s) merged into the /status JSON — preserves each wire format. */
  statusFields(
    token: OAuthTokenRecord | null,
    connected: boolean,
    username?: string
  ): Record<string, unknown>;
  /**
   * Connected predicate for /status. Defaults to hasOAuthToken, which treats
   * expired-but-refreshable tokens as connected (the access token only lasts
   * ~1h but resolveAccessToken refreshes transparently). github/slack override
   * with their stricter/looser predicates — the three are NOT interchangeable.
   */
  isConnected?(token: OAuthTokenRecord | null): boolean;
}

/**
 * One copy of the provider-token refresh flow. The subtle deletion policy:
 * only invalid_grant means the refresh token itself is revoked/expired —
 * transient failures (429, 5xx) must keep the token so the next call retries.
 */
export function makeRefresh<TConfig extends { clientId: string; clientSecret: string }>(
  spec: OAuthProviderSpec<TConfig>
): (record: OAuthTokenRecord) => Promise<string> {
  return async function refreshToken(record: OAuthTokenRecord): Promise<string> {
    const config = spec.getConfig();
    if (!config) throw new Error(spec.refreshNotConfiguredError);
    if (!record.refreshToken) throw new Error('No refresh token available');
    // `refreshTokenUrl` is declared optional because non-refresh-capable specs
    // omit it; every spec that reaches makeRefresh defines one.
    const refreshTokenUrl = spec.refreshTokenUrl;
    if (!refreshTokenUrl) throw new Error(`${spec.label}: token refresh is not supported`);

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(refreshTokenUrl(record, config), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      // Only invalid_grant means the refresh token itself is revoked/expired.
      // Transient failures (429, 5xx) must keep the token so the next call retries.
      if (data.error === 'invalid_grant') {
        await deleteOAuthToken(spec.provider, record.scopeType, record.scopeId);
      } else {
        console.warn(
          `⚠️ [${spec.label}] Token refresh failed (HTTP ${response.status}) for ${record.scopeType}:${record.scopeId} — keeping token for retry:`,
          data.error || 'no error body'
        );
      }
      throw new Error(
        data.error_description || data.error || `Token refresh failed (HTTP ${response.status})`
      );
    }

    await storeOAuthToken({
      provider: spec.provider,
      scopeType: record.scopeType,
      scopeId: record.scopeId,
      accessToken: data.access_token,
      refreshToken: data.refresh_token || record.refreshToken,
      expiresAt: Date.now() + (data.expires_in - 60) * 1000,
      meta: record.meta,
    });

    console.log(`🔄 [${spec.label}] Token refreshed for ${record.scopeType}:${record.scopeId}`);
    return data.access_token;
  };
}

/**
 * Authorize the caller-supplied token SCOPE.
 *
 * `resolveScope` turns (agentId, boardId, username) into the key an OAuth token
 * is stored under, so an unchecked agentId/boardId let any authenticated
 * account read the connection state of — and, on /disconnect, destroy — another
 * tenant's Google / Microsoft / GitHub / Slack tokens. The 'user' scope needs
 * no check: it is keyed on the caller's own username.
 *
 * Returns the caller's identity when the request may proceed, or null after
 * having already sent the 401/403 — so every call site is `if (!x) return;`.
 */
async function authorizeScope(
  req: express.Request,
  res: express.Response,
  agentId: string | null,
  boardId: string | null,
  level: AgentAccessLevel
): Promise<{ username: string } | null> {
  const user = sessionUser(req, res);
  if (!user) return null;
  if (agentId) {
    const access = await checkAgentIdAccess(agentId, user, level);
    if (!access.ok) {
      res.status(access.status || 403).json({ error: access.error });
      return null;
    }
  } else if (boardId) {
    // `else if` mirrors resolveScope's agent → board → user precedence: only
    // the id that actually becomes the scope is authorized.
    const access = await checkBoardIdAccess(boardId, user, level);
    if (!access.ok) {
      res.status(access.status || 403).json({ error: access.error });
      return null;
    }
  }
  return { username: user.username };
}

/** Reads a single-valued query param without widening to `string | string[]`. */
function queryValue(raw: unknown): string | null {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** The /status, /auth-url, and /disconnect handlers shared by every provider. */
export function oauthProviderRoutes<TConfig extends { clientId: string; clientSecret: string }>(
  spec: OAuthProviderSpec<TConfig>
): express.Router {
  const router = express.Router();

  router.get(
    '/status',
    asyncHandler(async (req, res) => {
      const config = spec.getConfig();
      const agentId = queryValue(req.query.agentId);
      const boardId = queryValue(req.query.boardId);
      const authorized = await authorizeScope(req, res, agentId, boardId, 'read');
      if (!authorized) return;
      const username = authorized.username;

      const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
      const token = getOAuthToken(spec.provider, scopeType, scopeId);
      const connected = spec.isConnected
        ? spec.isConnected(token)
        : hasOAuthToken(spec.provider, scopeType, scopeId);

      res.json({
        configured: !!config,
        connected,
        ...spec.statusFields(token, connected, username),
        agentId: agentId || null,
        boardId: boardId || null,
      });
    })
  );

  router.get(
    '/auth-url',
    asyncHandler(async (req, res) => {
      const config = spec.getConfig();
      if (!config) {
        res.status(500).json({ error: spec.notConfiguredError });
        return;
      }

      const agentId = queryValue(req.query.agentId);
      const boardId = queryValue(req.query.boardId);
      // 'edit': the signed state this mints is what binds the consent callback to
      // that scope, so issuing one writes a token there.
      const authorized = await authorizeScope(req, res, agentId, boardId, 'edit');
      if (!authorized) return;

      const state = spec.generateState(authorized.username || 'default', agentId, boardId, req);

      res.json({ authUrl: spec.buildAuthUrl(req, config, state) });
    })
  );

  router.post(
    '/disconnect',
    asyncHandler(async (req, res) => {
      const agentId = queryValue(req.body?.agentId);
      const boardId = queryValue(req.body?.boardId);
      // 'edit': deleting a provider token is destructive and irreversible from
      // here — the user has to walk the consent flow again.
      const authorized = await authorizeScope(req, res, agentId, boardId, 'edit');
      if (!authorized) return;
      const username = authorized.username || 'default';
      const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
      await deleteOAuthToken(spec.provider, scopeType, scopeId);
      console.log(`🔌 [${spec.label}] Disconnected ${scopeType}:${scopeId}`);
      res.json({ success: true });
    })
  );

  return router;
}
