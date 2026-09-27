import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getUserBoardIdSet } from '../lib/boardAccess.js';
import {
  getBoardUsageStats,
  getTaskActivityTimeline,
  getTaskMixStats,
  getErrorStats,
  type AnalyticsScope,
} from '../services/database/analytics.js';
import type { SessionClaims } from '../middleware/session.js';

/**
 * /api/analytics — the non-budget half of the Analytics view: board usage,
 * the project's task mix and error analysis. (Spend lives under /api/budget.)
 *
 * Scoping mirrors the tasks routes: admins see every board, everyone else only
 * the boards they own or that are shared with them. The optional `projectId`
 * (the header's project chip) narrows further, never widens.
 */
const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Window in days, clamped to [1, 365]; defaults to 30. */
export function parseDays(raw: unknown, fallback = 30) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 365);
}

/**
 * Resolve the caller's scope, or `undefined` after having already sent a 400
 * for a malformed projectId (a bad UUID cast would otherwise be a 500).
 */
async function resolveScope(
  req: express.Request & { user: SessionClaims },
  res: express.Response
): Promise<AnalyticsScope | undefined> {
  const raw = req.query.projectId;
  let projectId: string | null = null;
  if (typeof raw === 'string' && raw !== '') {
    if (!UUID_RE.test(raw)) {
      res.status(400).json({ error: 'Invalid projectId' });
      return undefined;
    }
    projectId = raw;
  }
  const boardIds =
    req.user.role === 'admin' ? null : [...(await getUserBoardIdSet(req.user.userId))];
  return { boardIds, projectId };
}

router.get(
  '/boards',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const days = parseDays(req.query.days);
    const [boards, activity] = await Promise.all([
      getBoardUsageStats(days, scope),
      getTaskActivityTimeline(days, scope),
    ]);
    res.json({ days, boards, activity });
  })
);

router.get(
  '/tasks',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const days = parseDays(req.query.days);
    res.json({ days, ...(await getTaskMixStats(days, scope)) });
  })
);

router.get(
  '/errors',
  asyncHandler(async (req, res) => {
    const scope = await resolveScope(req, res);
    if (!scope) return;
    const days = parseDays(req.query.days);
    res.json({ days, ...(await getErrorStats(days, scope)) });
  })
);

export default router;
