import { readSecret } from '../secrets.js';

/**
 * Resolves Google OAuth client credentials shared between Gmail and Drive.
 *
 * Google issues one OAuth client per Cloud Console project; the same
 * client_id / client_secret pair works for every Google API as long as the
 * relevant scopes are enabled and each redirect URI is registered. So users
 * should not have to configure GMAIL_* and GDRIVE_* twice.
 *
 * Resolution order:
 *   1. service-specific env (GMAIL_CLIENT_ID / GDRIVE_CLIENT_ID)
 *   2. the other service's env (so configuring Gmail also enables Drive)
 *   3. shared GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
 *
 * For redirect URIs the path differs per service, so we either use the
 * service-specific value if provided, or derive it from the other service's
 * value by swapping the path segment (e.g. `/api/gmail/oauth-redirect` ↔
 * `/api/gdrive/oauth-redirect`).
 */

export type GoogleService = 'gmail' | 'gdrive';

// Each service supports two redirect-URI shapes — the frontend callback page
// (the common case shown in .env.example) and the direct API route. When
// deriving one service's URI from the other we try both patterns in order.
const REDIRECT_PATH_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['/gmail-callback.html', '/gdrive-callback.html'],
  ['/api/gmail/oauth-redirect', '/api/gdrive/oauth-redirect'],
];

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const v of values) if (v) return v;
  return undefined;
}

function deriveRedirectUri(otherUri: string | undefined, service: GoogleService): string | undefined {
  if (!otherUri) return undefined;
  for (const [gmailPath, gdrivePath] of REDIRECT_PATH_PAIRS) {
    const [from, to] = service === 'gdrive' ? [gmailPath, gdrivePath] : [gdrivePath, gmailPath];
    if (otherUri.includes(from)) return otherUri.replace(from, to);
  }
  return undefined;
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function getGoogleOAuthConfig(service: GoogleService): GoogleOAuthConfig | null {
  const gmailRedirect = process.env.GMAIL_REDIRECT_URI;
  const gdriveRedirect = process.env.GDRIVE_REDIRECT_URI;

  const clientId = firstNonEmpty(
    service === 'gmail' ? process.env.GMAIL_CLIENT_ID : process.env.GDRIVE_CLIENT_ID,
    service === 'gmail' ? process.env.GDRIVE_CLIENT_ID : process.env.GMAIL_CLIENT_ID,
    process.env.GOOGLE_CLIENT_ID,
  );

  const clientSecret = firstNonEmpty(
    service === 'gmail' ? readSecret('GMAIL_CLIENT_SECRET') : readSecret('GDRIVE_CLIENT_SECRET'),
    service === 'gmail' ? readSecret('GDRIVE_CLIENT_SECRET') : readSecret('GMAIL_CLIENT_SECRET'),
    readSecret('GOOGLE_CLIENT_SECRET'),
  );

  const explicit = service === 'gmail' ? gmailRedirect : gdriveRedirect;
  const derived = service === 'gmail'
    ? deriveRedirectUri(gdriveRedirect, 'gmail')
    : deriveRedirectUri(gmailRedirect, 'gdrive');
  const redirectUri = firstNonEmpty(explicit, derived);

  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri };
}
