import { readSecret } from '../secrets.js';

/**
 * Shared Google OAuth client config for Gmail, Drive, login, and any future
 * Google API (Calendar, Contacts, …).
 *
 * Google issues one OAuth client per Cloud Console project; the same
 * client_id / client_secret pair works for every Google API. The originating
 * service is encoded in the OAuth `state` parameter, so a single dispatcher
 * (api/src/routes/googleOAuth.ts) routes tokens to the right provider.
 *
 * Env vars (both required):
 *   GOOGLE_CLIENT_ID
 *   GOOGLE_CLIENT_SECRET
 *
 * The redirect URI is NOT configurable here — it's derived from each request
 * (req.protocol + host + fixed path) so login lands on /auth/google/callback
 * and the plugin dispatcher lands on /api/google/oauth-redirect without
 * sharing or colliding. Register BOTH paths in the Google Cloud Console under
 * "Authorized redirect URIs".
 */

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function getGoogleOAuthConfig(): GoogleOAuthConfig | null {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = readSecret('GOOGLE_CLIENT_SECRET');

  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/**
 * Path under which the unified Google OAuth plugin dispatcher is mounted —
 * see api/src/routes/googleOAuth.ts. Used by both the auth-URL builders
 * (Gmail/Drive plugins) and the dispatcher itself when it exchanges the
 * code with Google: the two MUST send Google the exact same redirect_uri.
 */
export const GOOGLE_PLUGIN_REDIRECT_PATH = '/api/google/oauth-redirect';
