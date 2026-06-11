import express from 'express';
import {
  storeOAuthToken, getOAuthToken, hasOAuthToken, deleteOAuthToken, resolveAccessToken,
} from '../services/database.js';
import type { ScopeType } from '../services/database.js';

/**
 * Jira per-agent/board authentication routes — unified token store.
 * Uses API token + Basic Auth (not OAuth2), but stored in the same unified table.
 * Resolution: agent → board → error
 */

function resolveScope(agentId, boardId): { scopeType: ScopeType; scopeId: string } | null {
  if (agentId) return { scopeType: 'agent', scopeId: agentId };
  if (boardId) return { scopeType: 'board', scopeId: boardId };
  return null;
}

export function hasJiraCredentialsForAgent(agentId: string): boolean {
  if (!agentId) return false;
  return hasOAuthToken('jira', 'agent', agentId);
}

export function hasJiraCredentialsForBoard(boardId: string): boolean {
  if (!boardId) return false;
  return hasOAuthToken('jira', 'board', boardId);
}

export function getJiraCredentialsForAgent(agentId: string | null, boardId: string | null = null) {
  // Try agent first, then board
  if (agentId) {
    const token = getOAuthToken('jira', 'agent', agentId);
    if (token) return token.meta as { domain: string; email: string; apiToken: string } | null;
  }
  if (boardId) {
    const token = getOAuthToken('jira', 'board', boardId);
    if (token) return token.meta as { domain: string; email: string; apiToken: string } | null;
  }
  return null;
}

export function jiraRoutes() {
  const router = express.Router();

  router.get('/status', (req, res) => {
    const agentId = (req.query.agentId as string) || null;
    const boardId = (req.query.boardId as string) || null;
    if (!agentId && !boardId) {
      return res.json({ connected: false, agentId: null, boardId: null });
    }
    const scope = resolveScope(agentId, boardId);
    if (!scope) return res.json({ connected: false });
    const token = getOAuthToken('jira', scope.scopeType, scope.scopeId);
    res.json({
      connected: !!token,
      domain: token?.meta?.domain || null,
      email: token?.meta?.email || null,
      agentId,
      boardId,
    });
  });

  router.post('/connect', async (req, res) => {
    const { agentId, boardId, domain, email, apiToken } = req.body;
    if ((!agentId && !boardId) || !domain || !email || !apiToken) {
      return res.status(400).json({ error: 'agentId or boardId, domain, email, and apiToken are required' });
    }

    const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const baseUrl = `https://${cleanDomain}`;
    const encoded = Buffer.from(`${email}:${apiToken}`).toString('base64');

    try {
      const testRes = await fetch(`${baseUrl}/rest/api/3/myself`, {
        headers: { Authorization: `Basic ${encoded}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });

      if (!testRes.ok) {
        const body = await testRes.text().catch(() => '');
        return res.status(400).json({ error: `Jira authentication failed (${testRes.status}): ${body.slice(0, 200)}` });
      }

      const myself = await testRes.json();
      const scope = resolveScope(agentId, boardId)!;

      // Store the Jira credentials: accessToken is the encoded Basic auth, meta has the original creds
      await storeOAuthToken({
        provider: 'jira',
        scopeType: scope.scopeType,
        scopeId: scope.scopeId,
        accessToken: encoded,
        meta: { domain: cleanDomain, email, apiToken },
      }, { throwOnPersistError: true });

      const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
      console.log(`✅ [Jira] Credentials stored for ${target} → ${cleanDomain} (${myself.displayName || email})`);
      res.json({ success: true, agentId, boardId, displayName: myself.displayName, domain: cleanDomain });
    } catch (err) {
      console.error('[Jira] Connection test failed:', err);
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
    await deleteOAuthToken('jira', scope.scopeType, scope.scopeId);
    const target = agentId ? `agent "${agentId.slice(0, 8)}"` : `board "${boardId?.slice(0, 8)}"`;
    console.log(`🔌 [Jira] Disconnected ${target}`);
    res.json({ success: true });
  });

  return router;
}
