import { PULSAR_TEAM_MCP_SERVERS } from '../data/pulsarTeamMcp.js';
import { remoteMcpFetch } from './remoteMcpFetch.js';

/** Only these builtins may reach loopback; catalog/user URLs retain the SSRF guard. */
export function scopedMcpFetch(server: {
  id: string;
  url: string;
  remoteAuth?: 'oauth' | 'api_key';
}): typeof fetch {
  const builtin = PULSAR_TEAM_MCP_SERVERS.find(s => s.id === server.id);
  if (!builtin || server.url !== builtin.url || server.remoteAuth !== 'api_key') {
    return remoteMcpFetch;
  }
  const endpoint = builtin.url;
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== endpoint) throw new Error('Unexpected PulsarTeam MCP destination');
    // Use the scoped API key supplied by useRemoteClient, never an internal JWT.
    const response = await fetch(input, {
      ...init,
      redirect: 'manual',
      signal: init?.signal || AbortSignal.timeout(60_000),
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error('PulsarTeam MCP redirects are not allowed');
    }
    return response;
  };
}
