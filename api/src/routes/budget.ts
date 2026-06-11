import express from 'express';
import {
  recordTokenUsage, getTokenUsageByAgent, getTokenUsageTimeline,
  getTokenUsageSummary, getTokenUsageSummaryAsync, getDailyTokenUsage, getSetting, setSetting,
  getAllLlmConfigs, getPool
} from '../services/database.js';
import { requireRole } from '../middleware/auth.js';
import { validateBody, z } from '../lib/validate.js';

const router = express.Router();

// /alerts does arithmetic + .toFixed() on these fields, so a malformed PUT
// would otherwise break every subsequent /alerts poll until re-PUT correctly.
const budgetConfigSchema = z.object({
  dailyBudget: z.coerce.number().min(0).default(0),
  alertThreshold: z.coerce.number().min(0).max(100).default(80),
}).passthrough();

/**
 * Build a map from raw (provider, model) pairs to human-friendly config names.
 * This fixes historical records that stored the raw provider type ("vllm", "mistral", "")
 * instead of the LLM config display name.
 */
async function buildProviderNameMap() {
  try {
    const configs = await getAllLlmConfigs();
    const map = new Map();
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
    return new Map();
  }
}

/** Enrich budget rows: replace raw provider types with config display names */
function enrichProviderNames(rows, nameMap) {
  return rows.map(row => {
    const key = `${row.provider || ''}::${row.model || ''}`;
    const keyProviderOnly = `${row.provider || ''}::`;
    const displayName = nameMap.get(key) || nameMap.get(keyProviderOnly);
    return displayName ? { ...row, provider: displayName } : row;
  });
}

/** Return userId for per-user filtering, or null for admins (see all) */
function budgetUserId(req) {
  return req.user.role === 'admin' ? null : req.user.userId;
}

router.get('/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 1;
    const uid = budgetUserId(req);
    const summary = uid ? await getTokenUsageSummaryAsync(days, uid) : getTokenUsageSummary(days);
    const budgetConfig = getSetting('budget_config') || { dailyBudget: 0, alertThreshold: 80 };
    res.json({ ...summary, budgetConfig });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/by-agent', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    const [rows, nameMap] = await Promise.all([
      getTokenUsageByAgent(days, budgetUserId(req)),
      buildProviderNameMap()
    ]);
    res.json(enrichProviderNames(rows, nameMap));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/timeline', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 7;
    const groupBy = (req.query.groupBy as string) || 'day';
    res.json(await getTokenUsageTimeline(days, groupBy, budgetUserId(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days as string) || 30;
    res.json(await getDailyTokenUsage(days, budgetUserId(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/config', (req, res) => {
  try {
    const config = getSetting('budget_config') || { dailyBudget: 10.00, alertThreshold: 80 };
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/config', requireRole('admin'), validateBody(budgetConfigSchema), async (req, res) => {
  try {
    await setSetting('budget_config', req.body);
    // setSetting swallows DB errors and only updates its cache after a
    // successful write, so a stale read-back means nothing was persisted.
    if (getPool() && getSetting('budget_config') !== req.body) {
      return res.status(500).json({ error: 'Failed to persist budget config' });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/alerts', async (req, res) => {
  try {
    const config = getSetting('budget_config') || { dailyBudget: 10.00, alertThreshold: 80 };
    const uid = budgetUserId(req);
    const todaySummary = uid ? await getTokenUsageSummaryAsync(1, uid) : getTokenUsageSummary(1);
    const todayCost = todaySummary?.total_cost || 0;
    const alerts = [];
    if (config.dailyBudget > 0) {
      const pct = (todayCost / config.dailyBudget) * 100;
      if (pct >= 100) alerts.push({ level: 'critical', message: `Daily budget exceeded: $${todayCost.toFixed(4)} / $${config.dailyBudget.toFixed(2)} (${pct.toFixed(0)}%)` });
      else if (pct >= config.alertThreshold) alerts.push({ level: 'warning', message: `Approaching daily budget: $${todayCost.toFixed(4)} / $${config.dailyBudget.toFixed(2)} (${pct.toFixed(0)}%)` });
    }
    const byAgent = await getTokenUsageByAgent(1, uid);
    res.json({ alerts, todayCost, dailyBudget: config.dailyBudget, byAgent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;