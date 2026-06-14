import { resolveAccessToken } from '../services/database.js';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../services/googleOAuthConfig.js';
import type { GoogleOAuthConfig } from '../services/googleOAuthConfig.js';
import { generateGoogleOAuthState } from './googleOAuth.js';
import { makeRefresh, oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';

/**
 * Google Drive OAuth2 routes.
 *
 * Tokens are stored in the unified oauth_tokens table under provider="gdrive",
 * scoped by:
 *   - agent:<agentId>  (per-agent)
 *   - board:<boardId>  (per-board, shared by all agents on that board)
 *   - user:<username>  (per-user fallback)
 *
 * Resolution order when an agent calls a Google Drive MCP tool:
 *   agent tokens → board tokens → user tokens → error
 *
 * Drive shares the same OAuth client, redirect URI, state store, and
 * callback handler as Gmail — see api/src/routes/googleOAuth.ts. Only
 * Drive-specific auth-url, status, and disconnect endpoints live here.
 */

const gdriveSpec: OAuthProviderSpec<GoogleOAuthConfig> = {
  provider: 'gdrive',
  label: 'Gdrive',
  getConfig: getGoogleOAuthConfig,
  notConfiguredError: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET — the same OAuth client is reused for Gmail, Drive, and Google login.',
  refreshNotConfiguredError: 'Google Drive not configured',
  refreshTokenUrl: () => 'https://oauth2.googleapis.com/token',
  generateState: (username, agentId, boardId) => generateGoogleOAuthState('gdrive', username, agentId, boardId),
  buildAuthUrl: (req, config, state) => {
    const scopes = [
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/userinfo.email',
    ];
    const redirectUri = `${req.protocol}://${req.get('host')}${GOOGLE_PLUGIN_REDIRECT_PATH}`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      state,
    });
    return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
  },
  statusFields: (token, connected) => ({ email: connected ? token?.meta?.email || null : null }),
};

const refreshGdriveToken = makeRefresh(gdriveSpec);

export async function getGdriveAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('gdrive', agentId, boardId, refreshGdriveToken);
}

export function gdriveRoutes() {
  return oauthProviderRoutes(gdriveSpec);
}
