import {
  credentialConnectorRoutes,
  getProviderCredentials,
} from './lib/credentialConnector.js';

/**
 * WordPress per-agent/board authentication routes.
 *
 * Auth model: WordPress REST API + Application Password (Basic Auth).
 * The user supplies:
 *   - siteUrl: e.g. "https://blog.example.com" (with or without https://)
 *   - username: WordPress login
 *   - applicationPassword: created at /wp-admin/profile.php "Application Passwords"
 *
 * Credentials are stored in the unified oauth_tokens table under provider='wordpress'.
 * Resolution: agent → board.
 */

export interface WordPressCredentials {
  siteUrl: string;          // normalised, with scheme and no trailing slash
  username: string;
  applicationPassword: string;
}

function normaliseSiteUrl(input: string): string {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

export const getWordPressCredentialsForAgent = (
  agentId: string | null,
  boardId: string | null = null,
): WordPressCredentials | null => getProviderCredentials<WordPressCredentials>('wordpress', agentId, boardId);

export function wordpressRoutes() {
  return credentialConnectorRoutes({
    provider: 'wordpress',
    label: 'WordPress',
    statusFields: (meta) => ({
      siteUrl: meta?.siteUrl || null,
      username: meta?.username || null,
    }),
    connect: async ({ agentId, boardId, siteUrl, username, applicationPassword }) => {
      if ((!agentId && !boardId) || !siteUrl || !username || !applicationPassword) {
        return { error: 'agentId or boardId, siteUrl, username, and applicationPassword are required', status: 400 };
      }

      const cleanUrl = normaliseSiteUrl(siteUrl);
      // Application passwords in WordPress come with embedded spaces; strip them
      // because the user often copy-pastes them as shown in the UI.
      const cleanPassword = String(applicationPassword).replace(/\s+/g, '');
      const encoded = Buffer.from(`${username}:${cleanPassword}`).toString('base64');

      const testRes = await fetch(`${cleanUrl}/wp-json/wp/v2/users/me?context=edit`, {
        headers: { Authorization: `Basic ${encoded}`, Accept: 'application/json' },
        // Bound the probe — the URL is user-supplied and a blackholed host
        // would otherwise pin this handler for undici's 300s default.
        signal: AbortSignal.timeout(15_000),
      });

      if (!testRes.ok) {
        const body = await testRes.text().catch(() => '');
        return { error: `WordPress authentication failed (${testRes.status}): ${body.slice(0, 200)}`, status: 400 };
      }

      const me = await testRes.json();
      return {
        accessToken: encoded,
        meta: { siteUrl: cleanUrl, username, applicationPassword: cleanPassword },
        extra: { displayName: me.name, siteUrl: cleanUrl },
        logSuffix: `→ ${cleanUrl} (${me.name || username})`,
      };
    },
    onError: (err) => {
      if (err?.name === 'TimeoutError') {
        return { status: 504, message: 'WordPress site did not respond within 15s — check the site URL' };
      }
      return { status: 500, message: `Connection failed: ${err.message}` };
    },
  });
}
