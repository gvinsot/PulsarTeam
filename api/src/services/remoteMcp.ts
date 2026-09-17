import { randomBytes } from 'node:crypto';
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import { MCPClient } from './mcpClient.js';
import { remoteMcpFetch, validateRemoteUrl } from './remoteMcpFetch.js';
import { getAgentById } from './database/agents.js';
import {
  readRemoteCredentials,
  writeRemoteCredentials,
  withRemoteLock,
  saveRemoteFlow,
  type RemoteScope,
  type RemoteCredentials,
} from './remoteMcpStore.js';

export const REMOTE_CALLBACK_PATH = '/api/remote-mcp/oauth/callback';
export const REMOTE_METADATA_PATH = '/api/remote-mcp/oauth/client-metadata';
export interface RemoteServer {
  id: string;
  url: string;
  remoteAuth?: 'oauth' | 'api_key';
}

export function remoteClientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: 'PulsarTeam',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export function makeRemoteOAuthProvider(
  credentials: RemoteCredentials,
  persist: () => Promise<void>,
  flow?: { state: string; redirect: (url: URL) => Promise<void> }
): OAuthClientProvider {
  if (!credentials.redirectUrl) throw new Error('OAuth redirect URL missing');
  return {
    redirectUrl: credentials.redirectUrl,
    clientMetadataUrl: new URL(REMOTE_METADATA_PATH, credentials.redirectUrl).href,
    clientMetadata: remoteClientMetadata(credentials.redirectUrl),
    state: () => flow?.state || '',
    clientInformation: () => credentials.clientInformation,
    saveClientInformation: async info => {
      credentials.clientInformation = info;
      await persist();
    },
    tokens: () => credentials.tokens,
    saveTokens: async tokens => {
      credentials.tokens = {
        ...tokens,
        refresh_token: tokens.refresh_token || credentials.tokens?.refresh_token,
      };
      credentials.expiresAt =
        tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 : undefined;
      await persist();
    },
    saveCodeVerifier: async verifier => {
      // A background refresh must never turn into a silent new consent flow.
      if (!flow)
        throw new UnauthorizedError('Reconnectez ce MCP dans les plugins de l’agent ou du board.');
      credentials.verifier = verifier;
    },
    codeVerifier: () => {
      if (!credentials.verifier) throw new Error('OAuth verifier missing');
      return credentials.verifier;
    },
    redirectToAuthorization: async url => {
      validateRemoteUrl(url);
      if (!flow) throw new UnauthorizedError('Reconnectez ce MCP dans les plugins.');
      await flow.redirect(url);
    },
    discoveryState: () => credentials.discovery,
    saveDiscoveryState: async discovery => {
      credentials.discovery = discovery;
      await persist();
    },
    invalidateCredentials: async scope => {
      if (scope === 'all' || scope === 'tokens') {
        delete credentials.tokens;
        delete credentials.expiresAt;
      }
      if (scope === 'all' || scope === 'client') delete credentials.clientInformation;
      if (scope === 'all' || scope === 'discovery') delete credentials.discovery;
      if (scope === 'all' || scope === 'verifier') delete credentials.verifier;
      await persist();
    },
  };
}

export function remoteKeyHeaders(credentials: RemoteCredentials): Record<string, string> {
  const name = credentials.headerName || 'Authorization';
  if (
    !/^[A-Za-z0-9-]+$/.test(name) ||
    /^(host|cookie|connection|content-length|transfer-encoding|proxy-.*|sec-.*)$/i.test(name)
  ) {
    throw new Error('Nom d’en-tête de clé API non autorisé');
  }
  if (
    !credentials.apiKey ||
    /[\r\n]/.test(credentials.apiKey) ||
    /[\r\n]/.test(credentials.prefix || '')
  ) {
    throw new Error('Clé API manquante ou invalide');
  }
  return { [name]: `${credentials.prefix || ''}${credentials.apiKey}` };
}

export async function beginRemoteOAuth(
  server: RemoteServer,
  scope: RemoteScope,
  userId: string,
  redirectUrl: string,
  clientId?: string,
  clientSecret?: string
) {
  validateRemoteUrl(server.url);
  const state = randomBytes(32).toString('base64url');
  const credentials: RemoteCredentials = { url: server.url, mode: 'oauth', redirectUrl };
  if (clientId)
    credentials.clientInformation = {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    };
  let authUrl = '';
  const provider = makeRemoteOAuthProvider(credentials, async () => {}, {
    state,
    redirect: async url => {
      await saveRemoteFlow(state, { serverId: server.id, scope, userId, credentials });
      authUrl = url.href;
    },
  });
  // Use the transport so WWW-Authenticate resource_metadata and scope are
  // honored, including servers publishing their metadata at a custom URL.
  const client = new MCPClient('PulsarTeam-Connect');
  try {
    await client.connect(server.url, { authProvider: provider, fetch: remoteMcpFetch });
  } catch (error) {
    if (!authUrl) throw error;
  } finally {
    await client.close().catch(() => {});
  }
  if (!authUrl)
    throw new Error('Ce serveur ne demande pas OAuth. Vérifiez son mode d’authentification.');
  return { authUrl };
}

export async function finishRemoteOAuth(credentials: RemoteCredentials, code: string) {
  const provider = makeRemoteOAuthProvider(credentials, async () => {});
  const result = await auth(provider, {
    serverUrl: credentials.url,
    authorizationCode: code,
    fetchFn: remoteMcpFetch,
  });
  if (result !== 'AUTHORIZED' || !credentials.tokens?.access_token)
    throw new Error('OAuth authorization failed');
  delete credentials.verifier;
}

export async function useRemoteClient<T>(
  server: RemoteServer,
  scope: RemoteScope,
  fn: (client: MCPClient) => Promise<T>
) {
  return withRemoteLock(server.id, scope, async () => {
    const credentials = await readRemoteCredentials(server.id, scope);
    if (!credentials || credentials.url !== server.url || credentials.mode !== server.remoteAuth) {
      throw new UnauthorizedError('Connectez ce MCP sur cet agent ou son board.');
    }
    const client = new MCPClient('PulsarTeam-Remote');
    try {
      const options: Parameters<MCPClient['connect']>[1] = { fetch: remoteMcpFetch };
      if (credentials.mode === 'oauth') {
        if (!credentials.tokens)
          throw new UnauthorizedError('Reconnectez ce MCP dans les plugins.');
        const provider = makeRemoteOAuthProvider(credentials, () =>
          writeRemoteCredentials(server.id, scope, credentials)
        );
        if (credentials.expiresAt && credentials.expiresAt <= Date.now() + 30_000) {
          await auth(provider, { serverUrl: server.url, fetchFn: remoteMcpFetch });
        }
        options.authProvider = provider;
      } else options.headers = remoteKeyHeaders(credentials);
      await client.connect(server.url, options);
      // No automatic replay of tool calls: a timeout may follow a side effect.
      return await fn(client);
    } finally {
      await client.close().catch(() => {});
    }
  });
}

export async function remoteScopeForAgent(
  serverId: string,
  agentId: string | null
): Promise<RemoteScope> {
  if (!agentId) throw new Error('Agent context required for remote MCP');
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error('Agent not found');
  const own: RemoteScope = { type: 'agent', id: agentId };
  if (await readRemoteCredentials(serverId, own)) return own;
  // The board comes from the persisted agent, never from a caller-supplied id.
  if (agent.boardId) {
    const board: RemoteScope = { type: 'board', id: agent.boardId };
    if (await readRemoteCredentials(serverId, board)) return board;
  }
  throw new UnauthorizedError('Connectez ce MCP sur cet agent ou son board.');
}
