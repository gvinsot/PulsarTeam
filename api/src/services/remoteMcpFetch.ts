import { lookup } from 'node:dns/promises';
import { isIP, BlockList } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

// Untrusted catalog endpoints and OAuth metadata must never reach the Swarm,
// loopback, link-local metadata endpoints, or other private networks.
const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['192.0.0.0', 24],
  ['198.18.0.0', 15],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  blocked.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['64:ff9b::', 96],
  ['2002::', 16],
  ['2001::', 32],
] as const)
  blocked.addSubnet(address, prefix, 'ipv6');

export function isPublicAddress(address: string): boolean {
  if (address.toLowerCase().startsWith('::ffff:')) return false;
  const family = isIP(address);
  return !!family && !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

export function validateRemoteUrl(value: string | URL): URL {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    (isIP(host) && !isPublicAddress(host))
  ) {
    throw new Error('Un MCP distant doit utiliser une URL HTTPS publique sans identifiants.');
  }
  return url;
}

const dispatcher = new Agent({
  connect: {
    // Validate and pin the actual socket lookup, preventing DNS rebinding.
    lookup(hostname, options, callback) {
      lookup(hostname, { all: true })
        .then(addresses => {
          if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) {
            callback(new Error('Private MCP/OAuth destination blocked'), '', 4);
            return;
          }
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        })
        .catch(error => callback(error, '', 4));
    },
  },
  headersTimeout: 30_000,
  bodyTimeout: 60_000,
});

export const remoteMcpFetch: typeof globalThis.fetch = async (input, init) => {
  const url = validateRemoteUrl(input instanceof Request ? input.url : String(input));
  // Refuse redirects instead of forwarding credentials to a different endpoint.
  const response = await undiciFetch(url, {
    ...init,
    redirect: 'manual',
    dispatcher,
    signal: init?.signal || AbortSignal.timeout(60_000),
  } as Parameters<typeof undiciFetch>[1]);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new Error('Redirection MCP/OAuth refusée. Utilisez l’URL HTTPS finale.');
  }
  return response as unknown as Response;
};
