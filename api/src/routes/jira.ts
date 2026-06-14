import {
  credentialConnectorRoutes,
  getProviderCredentials,
} from './lib/credentialConnector.js';

/**
 * Jira per-agent/board authentication routes — unified token store.
 * Uses API token + Basic Auth (not OAuth2), but stored in the same unified table.
 * Resolution: agent → board → error
 */

export interface JiraCredentials {
  domain: string;
  email: string;
  apiToken: string;
}

export const getJiraCredentialsForAgent = (
  agentId: string | null,
  boardId: string | null = null,
): JiraCredentials | null => getProviderCredentials<JiraCredentials>('jira', agentId, boardId);

export function jiraRoutes() {
  return credentialConnectorRoutes({
    provider: 'jira',
    label: 'Jira',
    statusFields: (meta) => ({
      domain: meta?.domain || null,
      email: meta?.email || null,
    }),
    connect: async ({ agentId, boardId, domain, email, apiToken }) => {
      if ((!agentId && !boardId) || !domain || !email || !apiToken) {
        return { error: 'agentId or boardId, domain, email, and apiToken are required', status: 400 };
      }

      const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
      const baseUrl = `https://${cleanDomain}`;
      const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');

      const testRes = await fetch(`${baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${encoded}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!testRes.ok) {
        const body = await testRes.text().catch(() => '');
        return { error: `Jira authentication failed (${testRes.status}): ${body.slice(0, 200)}`, status: 400 };
      }

      const myself = await testRes.json();
      // Store the Jira credentials: accessToken is the encoded Basic auth, meta has the original creds
      return {
        accessToken: encoded,
        meta: { domain: cleanDomain, email, apiToken },
        extra: { displayName: myself.displayName, domain: cleanDomain },
        logSuffix: `→ ${cleanDomain} (${myself.displayName || email})`,
      };
    },
    onError: (err) => ({ status: 500, message: `Connection failed: ${err.message}` }),
  });
}
