import { internalTokenRoutes } from './internalTokenStore.js';

/**
 * Internal Codex token store (/api/internal/codex-tokens).
 * GET returns accessToken/expiresAt/meta; the runner consumes these field
 * names (runner-service/src/backends/codex_token_store.py).
 */
export const internalCodexTokenRoutes = () => internalTokenRoutes('codex', {
  serialize: (record) => ({
    accessToken: record.accessToken,
    expiresAt: record.expiresAt || null,
    meta: record.meta || {},
  }),
  parse: (body) => {
    const { accessToken, expiresAt, meta } = body;
    if (!accessToken || typeof accessToken !== 'string') return null;
    return {
      accessToken,
      expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
      meta: meta && typeof meta === 'object' ? meta : undefined,
    };
  },
});
