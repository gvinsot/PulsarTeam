import { readSecret } from '../secrets.js';

/**
 * Shared Microsoft OAuth client config for OneDrive, Outlook, Microsoft login,
 * and any future Microsoft Graph plugin (Teams, SharePoint, …).
 *
 * One Azure App registration covers every scope; a single dispatcher
 * (api/src/routes/microsoftOAuth.ts) routes the callback to the right
 * provider via the OAuth `state` parameter — mirrors the Google setup.
 *
 * Env vars:
 *   MICROSOFT_CLIENT_ID
 *   MICROSOFT_CLIENT_SECRET
 *   MICROSOFT_TENANT_ID (optional — defaults to "common" for personal + work)
 *
 * The redirect URI is NOT configurable here — it's derived from each request
 * so login lands on /auth/microsoft/callback and the plugin dispatcher lands
 * on /api/microsoft/oauth-redirect without colliding. Register BOTH paths in
 * the Azure App registration under "Redirect URIs".
 */

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  tenantId: string;
}

export function getMicrosoftOAuthConfig(): MicrosoftOAuthConfig | null {
  const clientId = process.env.MICROSOFT_CLIENT_ID;
  const clientSecret = readSecret('MICROSOFT_CLIENT_SECRET');
  const tenantId = process.env.MICROSOFT_TENANT_ID || 'common';

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, tenantId };
}

/** See GOOGLE_PLUGIN_REDIRECT_PATH — same idea for Microsoft Graph plugins. */
export const MICROSOFT_PLUGIN_REDIRECT_PATH = '/api/microsoft/oauth-redirect';
