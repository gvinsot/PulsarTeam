import express from 'express';
import { resolveAccessToken } from '../services/database.js';
import { getMicrosoftOAuthConfig, MICROSOFT_PLUGIN_REDIRECT_PATH } from '../services/microsoftOAuthConfig.js';
import type { MicrosoftOAuthConfig } from '../services/microsoftOAuthConfig.js';
import { generateMicrosoftOAuthState } from './microsoftOAuth.js';
import { makeRefresh, oauthProviderRoutes } from './oauthProviderRoutes.js';
import type { OAuthProviderSpec } from './oauthProviderRoutes.js';

/**
 * OneDrive OAuth2 routes — unified token store.
 * Resolution: agent → board → user → error
 *
 * The OAuth client credentials, redirect URI, and callback dispatcher are
 * shared across all Microsoft plugins (OneDrive, Outlook, …) via
 * services/microsoftOAuthConfig.ts and routes/microsoftOAuth.ts.
 */

function isConsumerFlow(req: express.Request): boolean {
  return req.query.consumer === '1' || req.query.consumer === 'true';
}

const onedriveSpec: OAuthProviderSpec<MicrosoftOAuthConfig> = {
  provider: 'onedrive',
  label: 'OneDrive',
  getConfig: getMicrosoftOAuthConfig,
  notConfiguredError: 'Microsoft OAuth not configured. Set MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET.',
  refreshNotConfiguredError: 'OneDrive not configured',
  refreshTokenUrl: (record, config) => {
    // Si le token vient du flow consumer (cf. /auth-url?consumer=1), le refresh
    // doit aussi taper /consumers/ — sinon AADSTS70000121 quand MICROSOFT_TENANT_ID
    // pointe vers un tenant Entra ID spécifique.
    const refreshTenant = record.meta?.consumerFlow ? 'consumers' : config.tenantId;
    return `https://login.microsoftonline.com/${refreshTenant}/oauth2/v2.0/token`;
  },
  generateState: (username, agentId, boardId, req) =>
    generateMicrosoftOAuthState('onedrive', username, agentId, boardId, isConsumerFlow(req)),
  buildAuthUrl: (req, config, state) => {
    const consumerFlow = isConsumerFlow(req);

    // Scopes compatibles à la fois comptes pro (work/school) et perso (hotmail/outlook.com/live).
    // Les variantes `.All` (Files.Read.All, Files.ReadWrite.All, Sites.Read.All) n'existent
    // pas dans le directory consumer — les inclure produit un token "amputé" qui échoue
    // sur /me/drive pour les comptes perso (accessDenied).
    const scopes = ['Files.Read', 'Files.ReadWrite', 'User.Read', 'offline_access'];

    // Le flow consumer force le endpoint `consumers` + login_hint pour épingler
    // une identité personnelle. MICROSOFT_CONSUMER_LOGIN_HINT permet de configurer
    // l'adresse pré-remplie — utile quand elle existe aussi comme guest B2B dans le
    // tenant Entra ID, auquel cas le endpoint `common` routerait vers le tenant work
    // (où l'utilisateur n'a pas de OneDrive) au lieu du tenant consumer.
    const tenantId = consumerFlow ? 'consumers' : config.tenantId;

    const redirectUri = `${req.protocol}://${req.get('host')}${MICROSOFT_PLUGIN_REDIRECT_PATH}`;
    const params = new URLSearchParams({
      client_id: config.clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes.join(' '),
      response_mode: 'query',
      state,
    });
    if (consumerFlow) {
      const consumerLoginHint = process.env.MICROSOFT_CONSUMER_LOGIN_HINT || 'gvinsot@hotmail.com';
      params.set('login_hint', consumerLoginHint);
      params.set('prompt', 'select_account');
    }

    return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params}`;
  },
  statusFields: (token, connected, username) => ({ username: connected ? username : null }),
};

const refreshOnedriveToken = makeRefresh(onedriveSpec);

export async function getOnedriveAccessTokenForAgent(agentId, boardId = null) {
  return resolveAccessToken('onedrive', agentId, boardId, refreshOnedriveToken);
}

export function onedriveRoutes() {
  return oauthProviderRoutes(onedriveSpec);
}
