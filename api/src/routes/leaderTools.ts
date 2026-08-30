import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  statusesHandler,
  swarmStatusHandler,
  byProjectHandler,
  projectSummaryHandler,
} from './lib/agentStatusHandlers.js';
import type { AgentManager } from '../services/agentManager/index.js';
import type { SessionClaims } from '../middleware/session.js';
import { getUserBoardIdSet } from '../lib/boardAccess.js';

// A `req.query` value is `string | string[] | ParsedQs | ParsedQs[]`: express
// hands back an array as soon as a param is repeated (`?agentId=a&agentId=b`)
// and an object for a bracketed one (`?agentId[x]=1`). The two helpers below
// reproduce, at the boundary, exactly what the receiving getter already did
// with such a value — they are coercions made visible, not new policy.

/**
 * An id used as an `agents` Map key. Only a plain string can ever be a key, so
 * every other form becomes '' — which misses the Map exactly as the raw array
 * or object did, and lands on the same 404.
 */
function queryId(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * A name compared case-insensitively against agent names. The getters stringify
 * it themselves (`String(agentName).toLowerCase()`), so stringifying here is
 * the identity — including for the array form, which keeps matching.
 */
function queryName(value: unknown): string {
  return String(value);
}

/**
 * Resolve an agent the CALLER is allowed to see, by id or by name.
 *
 * This router is mounted with `authenticateToken` alone (index.ts) — it has no
 * role gate of its own — so every lookup here has to carry its own visibility
 * check or it is an IDOR. Both lookups go through `getAllForUser`, which
 * applies the same board rule as the rest of the API: an admin passes no board
 * set and keeps the whole-swarm view these routes are for, anyone else is
 * scoped to the boards they own or were shared, plus the board-less agents that
 * are visible to everyone.
 *
 * Returns null when the agent does not exist OR is not visible to the caller —
 * deliberately the same answer, so the 404 does not become an oracle for which
 * agent ids exist.
 */
async function resolveVisibleAgent(
  agentManager: AgentManager,
  user: SessionClaims,
  agentId: unknown,
  agentName: unknown
): Promise<{ id: string; name?: string } | null> {
  const boardIds = user.role === 'admin' ? undefined : await getUserBoardIdSet(user.userId);
  const visible = agentManager.getAllForUser(user.userId, user.role, boardIds);
  if (agentId) {
    const id = queryId(agentId);
    return visible.find((a: { id: string }) => a.id === id) || null;
  }
  const wanted = queryName(agentName).toLowerCase();
  return visible.find((a: { name?: string }) => (a.name || '').toLowerCase() === wanted) || null;
}

export function leaderToolsRoutes(agentManager: AgentManager) {
  const router = express.Router();

  // Swarm Leader tool: read last message(s) from a specified agent
  // Query params:
  // - agentId: exact agent id
  // - agentName: exact agent name (case-insensitive)
  // - limit: number of last messages to return (1..50, default 1)
  router.get(
    '/last-messages',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { agentId, agentName, limit } = req.query;

      if (!agentId && !agentName) {
        return res.status(400).json({ error: 'agentId or agentName is required' });
      }
      if (!req.user) return res.status(401).json({ error: 'Authentication required' });

      // Resolve through the caller's visible set before reading anything. Both
      // branches used to hit the agent map directly — by id via getLastMessages,
      // by name via getLastMessagesByName, which scans EVERY agent — so any
      // authenticated account could read another tenant's conversation history.
      const target = await resolveVisibleAgent(agentManager, req.user, agentId, agentName);
      if (!target) return res.status(404).json({ error: 'Agent not found' });

      // `Number(limit ?? 1)` is what the getter's own `Number(limit)` computed
      // for the raw value; it still clamps NaN to 1 internally.
      const result = agentManager.getLastMessages(target.id, Number(limit ?? 1));
      if (!result) {
        return res.status(404).json({ error: 'Agent not found' });
      }

      return res.json(result);
    })
  );

  // Swarm Leader tool: get detailed status for a specific agent by name
  // Query params:
  // - agentName: agent name (case-insensitive)
  // - agentId: agent id (alternative to agentName)
  router.get(
    '/agent-status',
    asyncHandler(async (req: express.Request, res: express.Response) => {
      const { agentId, agentName } = req.query;

      if (!agentId && !agentName) {
        return res.status(400).json({ error: 'agentId or agentName is required' });
      }

      if (!req.user) return res.status(401).json({ error: 'Authentication required' });

      // Both branches resolve through the caller's visible set. The id branch
      // previously went straight to getAgentStatus with no check at all; that
      // was masked while the missing `await` made this route answer `{}`, and
      // adding the await would have turned it into a live IDOR.
      const target = await resolveVisibleAgent(agentManager, req.user, agentId, agentName);
      if (!target) return res.status(404).json({ error: 'Agent not found' });

      const status = await agentManager.getAgentStatus(target.id);
      if (!status) return res.status(404).json({ error: 'Agent not found' });
      return res.json(status);
    })
  );

  // Swarm Leader tools below mount the UNSCOPED status handlers (scoped=false):
  // a leader deliberately sees the whole swarm, not just the caller's boards
  // (see routes/lib/agentStatusHandlers.ts + docs/API_REFERENCE.md).

  // Swarm Leader tool: get lightweight status for ALL enabled agents
  // Returns an array of agent status objects (each includes project, currentTask, tasks, etc.)
  // Much lighter than GET /agents which returns full agent data with conversation history
  // Optional query param: ?project=ProjectName to filter by project
  router.get('/all-statuses', asyncHandler(statusesHandler(agentManager, false)));

  // Swarm Leader tool: get swarm-wide status with project assignments
  router.get('/swarm-status', asyncHandler(swarmStatusHandler(agentManager, false)));

  // Swarm Leader tool: get agents working on a specific project
  router.get('/by-project/:project', asyncHandler(byProjectHandler(agentManager, false)));

  // Swarm Leader tool: get project summary — all projects with their agent distribution
  router.get('/project-summary', asyncHandler(projectSummaryHandler(agentManager, false)));

  return router;
}
