import { resolveAccessToken } from '../services/database.js';
import { getGoogleOAuthConfig, GOOGLE_PLUGIN_REDIRECT_PATH } from '../services/googleOAuthConfig.js';
import type { GoogleOAuthConfig } from '../services/googleOAuthConfig.js';
import { generateGoogleOAuthState } from './googleOAuth.js';
import { makeRefresh, oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';

/**
 * Gmail OAuth2 routes.
 *
 * Tokens are stored in the unified oauth_tokens table, scoped by:
 *   - agent:<agentId>  (per-agent)
 *   - board:<boardId>  (per-board, shared by all agents on that board)
 *   - user:<username>  (per-user fallback)
 *
 * Resolution order when an agent calls a Gmail MCP tool:
 *   agent tokens → board tokens → user tokens → error
 *
 * The OAuth state lifecycle and redirect callback are shared with Google
 * Drive — see api/src/routes/googleOAuth.ts. Only Gmail-specific auth-url,
 * status, and disconnect endpoints live here.
 */

const gmailSpec: OAuthProviderSpec<GoogleOAuthConfig> = {
  provider: 'gmail',
  label: 'Gmail',
  getConfig: getGoogleOAuthConfig,
  notConfiguredError: 'Google OAuth not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.',
  refreshNotConfiguredError: 'Gmail not configured',
  refreshTokenUrl: () => 'https://oauth2.googleapis.com/token',
  generateState: (username, agentId, boardId) => generateGoogleOAuthState('gmail', username, agentId, boardId),
  buildAuthUrl: (req, config, state) => {
    const scopes = [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.compose',
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

const refreshGmailToken = makeRefresh(gmailSpec);

export async function getGmailAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('gmail', agentId, boardId, refreshGmailToken);
}

export function gmailRoutes() {
  return oauthProviderRoutes(gmailSpec);
}
