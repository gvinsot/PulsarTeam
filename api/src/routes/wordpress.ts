import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken,
} from '../services/database.js';
import type { ScopeType } from '../services/database.js';

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

function resolveScope(agentId: string | null, boardId: string | null): { scopeType: ScopeType; scopeId: string } | null {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return null;
}

function normaliseSiteUrl(input: string): string {
  let url = String(input || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

export function hasWordPressCredentialsForAgent(agentId: string): boolean {
  if (!agentId) return false;
  return hasOAuthToken('wordpress', 'agent', agentId);
}

export function hasWordPressCredentialsForBoard(boardId: string): boolean {
  if (!boardId) return false;
  return hasOAuthToken('wordpress', 'board', boardId);
}

export function getWordPressCredentialsForAgent(
  agentId: string | null,
  boardId: string | null = null,
): WordPressCredentials | null {
  if (agentId) {
    const token = getOAuthToken('wordpress', 'agent', agentId);
    if (token) return token.meta as WordPressCredentials;
  }
  if (boardId) {
    const token = getOAuthToken('wordpress', 'board', boardId);
    if (token) return token.meta as WordPressCredentials;
  }
  return null;
}

export function wordpressRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const agentId = (req.query.agentId as string) || null;
    const boardId = (req.query.boardId as string) || null;
    if (!agentId && !boardId) {
      return res.json({ connected: false, agentId: null, boardId: null });
    }
    const scope = resolveScope(agentId, boardId);
    if (!scope) return res.json({ connected: false });
    const token = getOAuthToken('wordpress', scope.scopeType, scope.scopeId);
    res.json({
      connected: !!token,
      siteUrl: token?.meta?.siteUrl || null,
      username: token?.meta?.username || null,
      agentId,
      boardId,
    });
  });

  router.post('/connect', async (req, res) => {
    const { agentId, boardId, siteUrl, username, applicationPassword } = req.body || {};
    if ((!agentId && !boardId) || !siteUrl || !username || !applicationPassword) {
      return res.status(400).json({ error: 'agentId or boardId, siteUrl, username, and applicationPassword are required' });
    }

    const cleanUrl = normaliseSiteUrl(siteUrl);
    // Application passwords in WordPress come with embedded spaces; strip them
    // because the user often copy-pastes them as shown in the UI.
    const cleanPassword = String(applicationPassword).replace(/\s+/g, '');
    const encoded = Buffer.from(`${username}:${cleanPassword}`).toString('base64');

    try {
      const testRes = await fetch(`${cleanUrl}/wp-json/wp/v2/users/me?context=edit`, {
        headers: { Authorization: `Basic ${encoded}`, Accept: 'application/json' },
        // Bound the probe — the URL is user-supplied and a blackholed host
        // would otherwise pin this handler for undici's 300s default.
        signal: AbortSignal.timeout(15_000),
      });

      if (!testRes.ok) {
        const body = await testRes.text().catch(() => '');
        return res.status(400).json({ error: `WordPress authentication failed (${testRes.status}): ${body.slice(0, 200)}` });
      }

      const me = await testRes.json();
      const scope = resolveScope(agentId, boardId)!;

      await storeOAuthToken({
        provider: 'wordpress',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        accessToken: encoded,
        meta: { siteUrl: cleanUrl, username, applicationPassword: cleanPassword },
      }, { throwOnPersistError: true });

      const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
      console.log(`✅ [WordPress] Credentials stored for ${target} → ${cleanUrl} (${me.name || username})`);
      res.json({ success: true, agentId, boardId, displayName: me.name, siteUrl: cleanUrl });
    } catch (err: any) {
      console.error('[WordPress] Connection test failed:', err);
      if (err?.name === 'TimeoutError') {
        return res.status(504).json({ error: 'WordPress site did not respond within 15s — check the site URL' });
      }
      res.status(500).json({ error: `Connection failed: ${err.message}` });
    }
  });

  router.post('/disconnect', async (req, res) => {
    const agentId = req.body?.agentId || null;
    const boardId = req.body?.boardId || null;
    if (!agentId && !boardId) {
      return res.status(400).json({ error: 'agentId or boardId is required' });
    }
    const scope = resolveScope(agentId, boardId)!;
    await deleteOAuthToken('wordpress', scope.scopeType, scope.scopeId);
    const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
    console.log(`🔌 [WordPress] Disconnected ${target}`);
    res.json({ success: true });
  });

  return router;
}
