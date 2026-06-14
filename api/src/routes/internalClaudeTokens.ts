import { internalTokenRoutes } from './internalTokenStore.js';

/**
 * Internal Claude Code token store (/api/internal/claude-tokens).
 * GET returns accessToken/refreshToken/expiresAt; the runner consumes these
 * field names (runner-service/src/backends/claude_token_store.py).
 */
export const internalClaudeTokenRoutes = () => internalTokenRoutes('claude_code', {
  serialize: (record) => ({
    accessToken: record.accessToken,
    refreshToken: record.refreshToken || null,
    expiresAt: record.expiresAt || null,
  }),
  parse: (body) => {
    const { accessToken, refreshToken, expiresIn, expiresAt } = body;
    if (!accessToken || typeof accessToken !== 'string') return null;

    // expiresAt (epoch ms) wins over expiresIn (seconds-from-now math).
    let expiresAtMs: number | null = null;
    if (typeof expiresAt === 'number') {
      expiresAtMs = expiresAt;
    } else if (typeof expiresIn === 'number') {
      expiresAtMs = Date.now() + expiresIn * 1000;
    }

    return {
      accessToken,
      refreshToken: typeof refreshToken === 'string' && refreshToken ? refreshToken : null,
      expiresAt: expiresAtMs,
    };
  },
});
