import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken,
} from '../services/database.js';
import type { OAuthProvider, OAuthTokenRecord } from '../services/database.js';
import { resolveScope } from './oauthHelper.js';

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
  generateState(username: string, agentId: string | null, boardId: string | null, req: express.Request): string;
  /** Provider-specific identity field(s) merged into the /status JSON — preserves each wire format. */
  statusFields(token: OAuthTokenRecord | null, connected: boolean, username?: string): Record<string, unknown>;
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
  spec: OAuthProviderSpec<TConfig>,
): (record: OAuthTokenRecord) => Promise<string> {
  return async function refreshToken(record: OAuthTokenRecord): Promise<string> {
    const config = spec.getConfig();
    if (!config) throw new Error(spec.refreshNotConfiguredError);
    if (!record.refreshToken) throw new Error('No refresh token available');

    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: record.refreshToken,
      grant_type: 'refresh_token',
    });

    const response = await fetch(spec.refreshTokenUrl(record, config), {
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
        console.warn(`⚠️ [${spec.label}] Token refresh failed (HTTP ${response.status}) for ${record.scopeType}:${record.scopeId} — keeping token for retry:`, data.error || 'no error body');
      }
      throw new Error(data.error_description || data.error || `Token refresh failed (HTTP ${response.status})`);
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

/** The /status, /auth-url, and /disconnect handlers shared by every provider. */
export function oauthProviderRoutes<TConfig extends { clientId: string; clientSecret: string }>(
  spec: OAuthProviderSpec<TConfig>,
): express.Router {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const config = spec.getConfig();
    const agentId = (req.query.agentId as string | undefined) || null;
    const boardId = (req.query.boardId as string | undefined) || null;
    const username = req.user?.username;

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
  });

  router.get('/auth-url', (req, res) => {
    const config = spec.getConfig();
    if (!config) {
      return res.status(500).json({ error: spec.notConfiguredError });
    }

    const agentId = (req.query.agentId as string | undefined) || null;
    const boardId = (req.query.boardId as string | undefined) || null;

    const state = spec.generateState(req.user?.username || 'default', agentId, boardId, req);

    res.json({ authUrl: spec.buildAuthUrl(req, config, state) });
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    const username = req.user?.username || 'default';
    const { scopeType, scopeId } = resolveScope(agentId, boardId, username);
    await deleteOAuthToken(spec.provider, scopeType, scopeId);
    console.log(`🔌 [${spec.label}] Disconnected ${scopeType}:${scopeId}`);
    res.json({ success: true });
  });

  return router;
}
