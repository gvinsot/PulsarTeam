import { credentialConnectorRoutes, getProviderCredentials } from './lib/credentialConnector.js';

/**
 * Azure CLI plugin connector — a service principal (tenant + client id +
 * client secret, optional default subscription) stored per agent or board.
 *
 * Nothing here calls Azure on the agent's behalf: the runner pulls these
 * credentials at CLI spawn (GET /api/internal/runner-azure/agents/:id) and
 * logs the agent's own `az` into its HOME (runner-service
 * backends/runner_azure_config.py). /connect only probes the principal so a
 * typo is reported in the UI instead of at the agent's first `az` call.
 *
 * Only the public Azure cloud is supported (login.microsoftonline.com /
 * management.azure.com). Both hosts are fixed; the tenant is the only
 * user-supplied URL part and is restricted to a GUID or a domain name.
 */

export interface AzureCredentials {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  subscriptionId?: string;
  subscriptionName?: string;
}

const LOGIN_HOST = 'https://login.microsoftonline.com';
const ARM_HOST = 'https://management.azure.com';
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TENANT_DOMAIN_RE = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const PROBE_TIMEOUT_MS = 15_000;

export const isValidAzureTenant = (tenant: string): boolean =>
  GUID_RE.test(tenant) || TENANT_DOMAIN_RE.test(tenant);
export const isAzureGuid = (value: string): boolean => GUID_RE.test(value);

export const getAzureCredentialsForAgent = (
  agentId: string | null,
  boardId: string | null = null
): AzureCredentials | null => getProviderCredentials<AzureCredentials>('azure', agentId, boardId);

interface AzureSubscription {
  subscriptionId: string;
  displayName?: string;
  state?: string;
}

/** Client-credentials grant against Entra ID; throws with Azure's own message. */
async function fetchArmToken(tenantId: string, clientId: string, clientSecret: string) {
  const res = await fetch(`${LOGIN_HOST}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: `${ARM_HOST}/.default`,
    }),
    redirect: 'error',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    // error_description starts with an AADSTS code that identifies the cause
    // (bad secret, unknown app, unknown tenant); keep its first line only.
    const detail = (data.error_description || data.error || `HTTP ${res.status}`).split('\n')[0];
    throw new Error(detail);
  }
  return data.access_token;
}

async function listSubscriptions(accessToken: string): Promise<AzureSubscription[]> {
  const res = await fetch(`${ARM_HOST}/subscriptions?api-version=2022-12-01`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    redirect: 'error',
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`listing subscriptions failed (HTTP ${res.status})`);
  const data = (await res.json().catch(() => ({}))) as { value?: AzureSubscription[] };
  return Array.isArray(data.value) ? data.value : [];
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');

export function azureRoutes() {
  return credentialConnectorRoutes({
    provider: 'azure',
    label: 'Azure',
    statusFields: meta => ({
      tenantId: meta?.tenantId || null,
      clientId: meta?.clientId || null,
      subscriptionId: meta?.subscriptionId || null,
      subscriptionName: meta?.subscriptionName || null,
    }),
    connect: async body => {
      const tenantId = str(body.tenantId);
      const clientId = str(body.clientId);
      const clientSecret = typeof body.clientSecret === 'string' ? body.clientSecret : '';
      const wantedSubscription = str(body.subscriptionId);

      if (!tenantId || !clientId || !clientSecret) {
        return { error: 'tenantId, clientId and clientSecret are required', status: 400 };
      }
      if (!isValidAzureTenant(tenantId)) {
        return { error: 'tenantId must be a GUID or a domain (contoso.onmicrosoft.com)' };
      }
      if (!isAzureGuid(clientId)) return { error: 'clientId must be a GUID' };
      if (wantedSubscription && !isAzureGuid(wantedSubscription)) {
        return { error: 'subscriptionId must be a GUID' };
      }
      if (clientSecret.length > 1024) return { error: 'clientSecret is too long' };

      const token = await fetchArmToken(tenantId, clientId, clientSecret);
      const subscriptions = await listSubscriptions(token);

      let subscription: AzureSubscription | undefined;
      if (wantedSubscription) {
        subscription = subscriptions.find(
          s => s.subscriptionId.toLowerCase() === wantedSubscription.toLowerCase()
        );
        if (!subscription) {
          return {
            error: `The service principal has no access to subscription ${wantedSubscription}`,
          };
        }
      } else if (subscriptions.length === 1) {
        subscription = subscriptions[0];
      }

      return {
        accessToken: clientId,
        meta: {
          tenantId,
          clientId,
          clientSecret,
          ...(subscription
            ? {
                subscriptionId: subscription.subscriptionId,
                subscriptionName: subscription.displayName || '',
              }
            : {}),
        },
        extra: {
          subscriptionCount: subscriptions.length,
          subscriptionId: subscription?.subscriptionId || null,
          subscriptionName: subscription?.displayName || null,
        },
        logSuffix: `→ tenant ${tenantId} (${subscriptions.length} subscriptions)`,
      };
    },
    onError: err => ({ status: 400, message: `Azure connection failed: ${err.message}` }),
  });
}
