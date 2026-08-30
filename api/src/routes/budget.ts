import express from 'express';
import { asyncHandler } from '../lib/asyncHandler.js';
import {
  getTokenUsageByAgent,
  getTokenUsageTimeline,
  getTokenUsageSummary,
  getTokenUsageSummaryAsync,
  getDailyTokenUsage,
  getSetting,
  setSetting,
  getAllLlmConfigs,
  getPool,
} from '../services/database.js';
import { requireRole } from '../middleware/auth.js';
import { validateBody, z } from '../lib/validate.js';
import type { SessionClaims } from '../middleware/session.js';

const router = express.Router();

// /alerts does arithmetic + .toFixed() on these fields, so a malformed PUT
// would otherwise break every subsequent /alerts poll until re-PUT correctly.
const budgetConfigSchema = z
  .object({
    dailyBudget: z.coerce.number().min(0).default(0),
    alertThreshold: z.coerce.number().min(0).max(100).default(80),
  })
  .passthrough();

/**
 * The two numeric fields /alerts does arithmetic on. `getSetting` hands back
 * `unknown` — the settings table stores free-form JSON — so the value is
 * narrowed at the point of use rather than trusted. `budgetConfigSchema` above
 * is what keeps the persisted object in this shape.
 */
interface BudgetConfig {
  dailyBudget: number;
  alertThreshold: number;
}

function isBudgetConfig(value: unknown): value is BudgetConfig {
  if (typeof value !== 'object' || value === null) return false;
  if (!('dailyBudget' in value) || !('alertThreshold' in value)) return false;
  return typeof value.dailyBudget === 'number' && typeof value.alertThreshold === 'number';
}

/**
 * Build a map from raw (provider, model) pairs to human-friendly config names.
 * This fixes historical records that stored the raw provider type ("vllm", "mistral", "")
 * instead of the LLM config display name.
 */
async function buildProviderNameMap() {
  try {
    const configs = await getAllLlmConfigs();
    const map = new Map<string, string>();
    for (const cfg of configs) {
      if (cfg.name && cfg.provider) {
        // Key: raw provider + model → display name
        map.set(`${cfg.provider}::${cfg.model || ''}`, cfg.name);
        // Also key by provider alone (for records where model may differ)
        if (!map.has(`${cfg.provider}::`)) {
          map.set(`${cfg.provider}::`, cfg.name);
        }
      }
    }
    return map;
  } catch {
    return new Map<string, string>();
  }
}

/** Enrich budget rows: replace raw provider types with config display names */
function enrichProviderNames<T extends { provider?: string | null; model?: string | null }>(
  rows: T[],
  nameMap: Map<string, string>
) {
  return rows.map(row => {
    const key = `${row.provider || ''}::${row.model || ''}`;
    const keyProviderOnly = `${row.provider || ''}::`;
    const displayName = nameMap.get(key) || nameMap.get(keyProviderOnly);
    return displayName ? { ...row, provider: displayName } : row;
  });
}

/** Return userId for per-user filtering, or null for admins (see all) */
// Only the session claims are read; every route in this router is mounted
// behind authenticateToken (index.ts), which is what puts them there.
function budgetUserId(req: { user: SessionClaims }) {
  return req.user.role === 'admin' ? null : req.user.userId;
}

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 1;
    const uid = budgetUserId(req);
    const summary = uid ? await getTokenUsageSummaryAsync(days, uid) : getTokenUsageSummary(days);
    const budgetConfig = getSetting('budget_config') || { dailyBudget: 0, alertThreshold: 80 };
    res.json({ ...summary, budgetConfig });
  })
);

router.get(
  '/by-agent',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;
    const [rows, nameMap] = await Promise.all([
      getTokenUsageByAgent(days, budgetUserId(req)),
      buildProviderNameMap(),
    ]);
    res.json(enrichProviderNames(rows, nameMap));
  })
);

router.get(
  '/timeline',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 7;
    const groupBy = (req.query.groupBy as string) || 'day';
    res.json(await getTokenUsageTimeline(days, groupBy, budgetUserId(req)));
  })
);

router.get(
  '/daily',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;
    res.json(await getDailyTokenUsage(days, budgetUserId(req)));
  })
);

router.get(
  '/config',
  asyncHandler((_req, res) => {
    const config = getSetting('budget_config') || { dailyBudget: 10.0, alertThreshold: 80 };
    res.json(config);
  })
);

router.put(
  '/config',
  requireRole('admin'),
  validateBody(budgetConfigSchema),
  asyncHandler(async (req, res) => {
    await setSetting('budget_config', req.body);
    // setSetting swallows DB errors and only updates its cache after a
    // successful write, so a stale read-back means nothing was persisted.
    if (getPool() && getSetting('budget_config') !== req.body) {
      return res.status(500).json({ error: 'Failed to persist budget config' });
    }
    res.json({ success: true });
  })
);

router.get(
  '/alerts',
  asyncHandler(async (req, res) => {
    const storedConfig = getSetting('budget_config');
    const config: BudgetConfig = isBudgetConfig(storedConfig)
      ? storedConfig
      : { dailyBudget: 10.0, alertThreshold: 80 };
    const uid = budgetUserId(req);
    const todaySummary = uid ? await getTokenUsageSummaryAsync(1, uid) : getTokenUsageSummary(1);
    const todayCost = todaySummary?.total_cost || 0;
    const alerts: { level: string; message: string }[] = [];
    if (config.dailyBudget > 0) {
      const pct = (todayCost / config.dailyBudget) * 100;
      if (pct >= 100)
        alerts.push({
          level: 'critical',
          message: `Daily budget exceeded: $${todayCost.toFixed(4)} / $${config.dailyBudget.toFixed(2)} (${pct.toFixed(0)}%)`,
        });
      else if (pct >= config.alertThreshold)
        alerts.push({
          level: 'warning',
          message: `Approaching daily budget: $${todayCost.toFixed(4)} / $${config.dailyBudget.toFixed(2)} (${pct.toFixed(0)}%)`,
        });
    }
    const byAgent = await getTokenUsageByAgent(1, uid);
    res.json({ alerts, todayCost, dailyBudget: config.dailyBudget, byAgent });
  })
);

export default router;
