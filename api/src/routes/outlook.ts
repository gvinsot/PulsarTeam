import { resolveAccessToken } from '../services/database.js';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import type { MicrosoftOAuthConfig } from '../services/microsoftOAuthConfig.js';
import { generateMicrosoftOAuthState } from './microsoftOAuth.js';
import { makeRefresh, oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';

/**
 * Outlook OAuth2 routes — unified token store.
 *
 * Reuses the Microsoft OAuth client (MICROSOFT_CLIENT_ID/SECRET/REDIRECT_URI)
 * and the shared dispatcher in routes/microsoftOAuth.ts. Tokens are stored in
 * the unified oauth_tokens table under provider='outlook' and scoped by:
 *   - agent:<agentId>  (per-agent)
 *   - board:<boardId>  (per-board, shared by all agents on that board)
 *   - user:<username>  (per-user fallback)
 *
 * Resolution order when an agent calls an Outlook MCP tool:
 *   agent tokens → board tokens → user tokens → error
 */

const outlookSpec: OAuthProviderSpec<MicrosoftOAuthConfig> = {
  provider: 'outlook',
  label: 'Outlook',
  getConfig: getMicrosoftOAuthConfig,
  notConfiguredError: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
  refreshNotConfiguredError: 'Outlook not configured',
  refreshTokenUrl: (_record, config) => `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
  generateState: (username, agentId, boardId) => generateMicrosoftOAuthState('outlook', username, agentId, boardId),
  buildAuthUrl: (req, config, state) => {
    // Microsoft Graph Mail scopes. offline_access is required for refresh tokens.
    const scopes = [
      'Mail.Read',
      'Mail.ReadWrite',
      'Mail.Send',
      'MailboxSettings.Read',
      'User.Read',
      'offline_access',
    ];
    const redirectUri = `${req.protocol}://${req.get('host')}${MICROSOFT_PLUGIN_REDIRECT_PATH}`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      response_mode: 'query',
      state,
    });
    return `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params}`;
  },
  statusFields: (token, connected) => ({ email: connected ? token?.meta?.email || null : null }),
};

const refreshOutlookToken = makeRefresh(outlookSpec);

export async function getOutlookAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('outlook', agentId, boardId, refreshOutlookToken);
}

export function outlookRoutes() {
  return oauthProviderRoutes(outlookSpec);
}
