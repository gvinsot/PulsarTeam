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
  getAllProjects,
} from '../services/database.js';
import { getCostByProject } from '../services/database/analytics.js';
import { usageLabel } from '../services/llmVendor.js';
import { requireRole } from '../middleware/auth.js';
import { validateBody, z } from '../lib/validate.js';
import type { SessionClaims } from '../middleware/session.js';

const router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A daily + monthly spend limit pair. 0 means "no limit". */
const limitSchema = z.object({
  dailyBudget: z.coerce.number().min(0).default(0),
  monthlyBudget: z.coerce.number().min(0).default(0),
});

// /alerts does arithmetic + .toFixed() on these fields, so a malformed PUT
// would otherwise break every subsequent /alerts poll until re-PUT correctly.
const budgetConfigSchema = z
  .object({
    dailyBudget: z.coerce.number().min(0).default(0),
    // Rolling 30-day limit, matching the rolling 24h window of dailyBudget.
    monthlyBudget: z.coerce.number().min(0).default(0),
    alertThreshold: z.coerce.number().min(0).max(100).default(80),
    // Per-project overrides, keyed by project id.
    projectBudgets: z.record(z.string().regex(UUID_RE), limitSchema).default({}),
  })
  .passthrough();

export interface BudgetLimits {
  dailyBudget: number;
  monthlyBudget: number;
}

/**
 * The fields /alerts does arithmetic on. `getSetting` hands back `unknown` —
 * the settings table stores free-form JSON — so the value is normalised at the
 * point of use rather than trusted. `budgetConfigSchema` above is what keeps
 * the persisted object in this shape; configs saved before monthly/per-project
 * limits existed simply lack those keys and read as "no limit".
 */
export interface BudgetConfig extends BudgetLimits {
  alertThreshold: number;
  projectBudgets: Record<string, BudgetLimits>;
}

const finiteOr = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fallback;

export function normalizeBudgetConfig(value: unknown): BudgetConfig {
  const fallback: BudgetConfig = {
    dailyBudget: 10.0,
    monthlyBudget: 0,
    alertThreshold: 80,
    projectBudgets: {},
  };
  if (typeof value !== 'object' || value === null) return fallback;
  const v = value as Record<string, unknown>;
  const projectBudgets: Record<string, BudgetLimits> = {};
  if (typeof v.projectBudgets === 'object' && v.projectBudgets !== null) {
    for (const [id, limits] of Object.entries(v.projectBudgets as Record<string, unknown>)) {
      if (typeof limits !== 'object' || limits === null) continue;
      const l = limits as Record<string, unknown>;
      projectBudgets[id] = {
        dailyBudget: finiteOr(l.dailyBudget, 0),
        monthlyBudget: finiteOr(l.monthlyBudget, 0),
      };
    }
  }
  return {
    dailyBudget: finiteOr(v.dailyBudget, fallback.dailyBudget),
    monthlyBudget: finiteOr(v.monthlyBudget, 0),
    alertThreshold: finiteOr(v.alertThreshold, 80),
    projectBudgets,
  };
}

export interface BudgetAlert {
  level: 'critical' | 'warning';
  message: string;
  period: 'daily' | 'monthly';
  projectId?: string;
}

/**
 * Compare spend to one limit pair. `label` prefixes the message so a
 * project's alert is distinguishable from the global one.
 */
export function evaluateLimits(
  limits: BudgetLimits,
  spend: { daily: number; monthly: number },
  alertThreshold: number,
  label = '',
  projectId?: string
): BudgetAlert[] {
  const alerts: BudgetAlert[] = [];
  const periods: { period: 'daily' | 'monthly'; limit: number; cost: number; name: string }[] = [
    { period: 'daily', limit: limits.dailyBudget, cost: spend.daily, name: 'daily budget' },
    {
      period: 'monthly',
      limit: limits.monthlyBudget,
      cost: spend.monthly,
      name: '30-day budget',
    },
  ];
  for (const { period, limit, cost, name } of periods) {
    if (!(limit > 0)) continue;
    const pct = (cost / limit) * 100;
    const figures = `$${cost.toFixed(4)} / $${limit.toFixed(2)} (${pct.toFixed(0)}%)`;
    const base = { period, ...(projectId ? { projectId } : {}) };
    if (pct >= 100)
      alerts.push({
        ...base,
        level: 'critical',
        message: `${label}${cap(name)} exceeded: ${figures}`,
      });
    else if (pct >= alertThreshold)
      alerts.push({
        ...base,
        level: 'warning',
        message: `${label}Approaching ${name}: ${figures}`,
      });
  }
  return alerts;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/**
 * Resolve the optional `projectId` scope the web UI sends when a project is
 * selected in the header: every figure on the Budget view is then restricted to
 * the usage produced by that project's agents.
 *
 * Returns the validated id, `null` for "All Projects" (absent or empty -> no
 * narrowing), or `undefined` after having ALREADY sent a 400 for a malformed
 * value - the DAO casts the id to UUID, and a bad cast would otherwise surface
 * as a 500 on a routine 30s poll. Per-user scoping (budgetUserId) still applies
 * on top, so a project scope only ever narrows what the caller could see.
 */
function resolveProjectScope(
  req: express.Request,
  res: express.Response
): string | null | undefined {
  const raw = req.query.projectId;
  if (typeof raw !== 'string' || raw === '') return null;
  if (!UUID_RE.test(raw)) {
    res.status(400).json({ error: 'Invalid projectId' });
    return undefined;
  }
  return raw;
}

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 1;
    const uid = budgetUserId(req);
    const projectId = resolveProjectScope(req, res);
    if (projectId === undefined) return;
    const summary =
      uid || projectId
        ? await getTokenUsageSummaryAsync(days, uid, projectId)
        : getTokenUsageSummary(days);
    const budgetConfig = getSetting('budget_config') || { dailyBudget: 0, alertThreshold: 80 };
    res.json({ ...summary, budgetConfig });
  })
);

router.get(
  '/by-agent',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;
    const projectId = resolveProjectScope(req, res);
    if (projectId === undefined) return;
    const [rows, nameMap] = await Promise.all([
      getTokenUsageByAgent(days, budgetUserId(req), projectId),
      buildProviderNameMap(),
    ]);
    // `label` names the slice in "Cost by LLM": computed from the RAW provider
    // (runner id / provider type) so rows without a model still resolve to
    // their vendor (Anthropic, OpenAI, Copilot…) instead of "unknown".
    const enriched = enrichProviderNames(rows, nameMap).map((row, i) => ({
      ...row,
      label: usageLabel({
        provider: rows[i].provider,
        model: rows[i].model,
        displayName: row.provider,
      }),
    }));
    res.json(enriched);
  })
);

router.get(
  '/timeline',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 7;
    const groupBy = (req.query.groupBy as string) || 'day';
    const projectId = resolveProjectScope(req, res);
    if (projectId === undefined) return;
    res.json(await getTokenUsageTimeline(days, groupBy, budgetUserId(req), projectId));
  })
);

router.get(
  '/daily',
  asyncHandler(async (req, res) => {
    const days = parseInt(req.query.days as string) || 30;
    const projectId = resolveProjectScope(req, res);
    if (projectId === undefined) return;
    res.json(await getDailyTokenUsage(days, budgetUserId(req), projectId));
  })
);

router.get(
  '/config',
  asyncHandler((_req, res) => {
    const stored = getSetting('budget_config');
    const config =
      typeof stored === 'object' && stored !== null
        ? stored
        : { dailyBudget: 10.0, alertThreshold: 80 };
    // Configs saved before monthly / per-project limits existed lack those keys.
    res.json({ monthlyBudget: 0, projectBudgets: {}, ...config });
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
    const config = normalizeBudgetConfig(getSetting('budget_config'));
    const uid = budgetUserId(req);
    const projectId = resolveProjectScope(req, res);
    if (projectId === undefined) return;
    // Scoped to the selected project too: the alert compares spend to the
    // budget, and the dashboard shows it next to project-scoped figures.
    const summaryFor = (days: number) =>
      uid || projectId
        ? getTokenUsageSummaryAsync(days, uid, projectId)
        : Promise.resolve(getTokenUsageSummary(days));
    const [todaySummary, monthSummary] = await Promise.all([summaryFor(1), summaryFor(30)]);
    const todayCost = todaySummary?.total_cost || 0;
    const monthCost = monthSummary?.total_cost || 0;
    const spend = { daily: todayCost, monthly: monthCost };

    let alerts: BudgetAlert[];
    let limits: BudgetLimits = config;
    if (projectId) {
      // A project with its own limits is judged against them; otherwise the
      // global limits still apply to what is on screen.
      const own = config.projectBudgets[projectId];
      if (own && (own.dailyBudget > 0 || own.monthlyBudget > 0)) limits = own;
      alerts = evaluateLimits(limits, spend, config.alertThreshold, '', projectId);
    } else {
      alerts = evaluateLimits(config, spend, config.alertThreshold);
      // All-projects view: also surface every project over its own limits.
      const limited = Object.entries(config.projectBudgets).filter(
        ([, l]) => l.dailyBudget > 0 || l.monthlyBudget > 0
      );
      if (limited.length > 0) {
        const [daily, monthly, projects] = await Promise.all([
          getCostByProject(1, uid),
          getCostByProject(30, uid),
          getAllProjects().catch(() => []),
        ]);
        const names = new Map(projects.map(p => [p.id, p.name]));
        for (const [pid, l] of limited) {
          // Skip deleted projects: their limits are orphaned config.
          if (!names.has(pid)) continue;
          alerts.push(
            ...evaluateLimits(
              l,
              { daily: daily.get(pid) || 0, monthly: monthly.get(pid) || 0 },
              config.alertThreshold,
              `[${names.get(pid)}] `,
              pid
            )
          );
        }
      }
    }
    const byAgent = await getTokenUsageByAgent(1, uid, projectId);
    res.json({
      alerts,
      todayCost,
      monthCost,
      dailyBudget: limits.dailyBudget,
      monthlyBudget: limits.monthlyBudget,
      byAgent,
    });
  })
);

export default router;
