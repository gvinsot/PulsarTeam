import { z } from 'zod';
import { remoteMcpFetch, validateRemoteUrl } from './remoteMcpFetch.js';

const REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1';
const remoteSchema = z.object({
  type: z.string(),
  url: z.string(),
  headers: z
    .array(
      z.object({
        name: z.string(),
        isSecret: z.boolean().optional(),
        isRequired: z.boolean().optional(),
      })
    )
    .optional(),
});
const entrySchema = z.object({
  server: z.object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string(),
    version: z.string(),
    remotes: z.array(remoteSchema).optional(),
  }),
  _meta: z.record(z.string(), z.unknown()).optional(),
});
export interface RegistryServer {
  name: string;
  title: string;
  description: string;
  version: string;
  remotes: { url: string; headerNames: string[] }[];
}
export function normalizeRegistryEntry(raw: unknown): RegistryServer | null {
  const parsed = entrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const { server, _meta } = parsed.data;
  const official = _meta?.['io.modelcontextprotocol.registry/official'] as
    { status?: string } | undefined;
  if (official?.status && official.status !== 'active') return null;
  const remotes = (server.remotes || []).flatMap(remote => {
    if (remote.type !== 'streamable-http' || /[{}]/.test(remote.url)) return [];
    try {
      validateRemoteUrl(remote.url);
    } catch {
      return [];
    }
    // This first version configures one secret header. Servers requiring a
    // larger configuration are not advertised as ready to install.
    if ((remote.headers || []).filter(h => h.isRequired).length > 1) return [];
    return [{ url: remote.url, headerNames: (remote.headers || []).map(h => h.name) }];
  });
  return remotes.length
    ? {
        name: server.name,
        title: server.title || server.name,
        description: server.description,
        version: server.version,
        remotes,
      }
    : null;
}
const cache = new Map<string, { until: number; value: unknown }>();
async function registryJson(path: string): Promise<unknown> {
  const cached = cache.get(path);
  if (cached && cached.until > Date.now()) return cached.value;
  const response = await remoteMcpFetch(`${REGISTRY_URL}${path}`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Le registre MCP est indisponible (${response.status}).`);
  const value: unknown = await response.json();
  if (cache.size >= 100) cache.delete(cache.keys().next().value!);
  cache.set(path, { until: Date.now() + 5 * 60_000, value });
  return value;
}
export async function searchRegistry(search = '', cursor = '') {
  const query = new URLSearchParams({ limit: '100', version: 'latest' });
  if (search) query.set('search', search);
  if (cursor) query.set('cursor', cursor);
  const page = z
    .object({
      servers: z.array(z.unknown()),
      metadata: z.object({ nextCursor: z.string().optional() }).optional(),
    })
    .parse(await registryJson(`/servers?${query}`));
  return {
    servers: page.servers.map(normalizeRegistryEntry).filter(s => s !== null),
    nextCursor: page.metadata?.nextCursor || null,
  };
}
export async function getRegistryServer(name: string, version: string) {
  const raw = await registryJson(
    `/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`
  );
  const server = normalizeRegistryEntry(raw);
  if (!server || server.name !== name || server.version !== version)
    throw new Error('Serveur MCP distant non pris en charge.');
  return server;
}
