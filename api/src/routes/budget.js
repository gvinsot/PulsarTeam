import express from 'express';
import {
  recordTokenUsage, getTokenUsageByAgent, getTokenUsageTimeline,
  getTokenUsageSummary, getTokenUsageSummaryAsync, getDailyTokenUsage, getSetting, setSetting
} from '../services/database.js';

const router = express.Router();

/** Return userId for per-user filtering, or null for admins (see all) */
function budgetUserId(req) {
  return req.user.role === 'admin' ? null : req.user.userId;
}

router.get('/summary', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 1;
    const uid = budgetUserId(req);
    const summary = uid ? await getTokenUsageSummaryAsync(days, uid) : getTokenUsageSummary(days);
    const budgetConfig = getSetting('budget_config') || { dailyBudget: 0, alertThreshold: 80 };
    res.json({ ...summary, budgetConfig });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/by-agent', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    res.json(await getTokenUsageByAgent(days, budgetUserId(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/timeline', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const groupBy = req.query.groupBy || 'day';
    res.json(await getTokenUsageTimeline(days, groupBy, budgetUserId(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/daily', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    res.json(await getDailyTokenUsage(days, budgetUserId(req)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/config', (req, res) => {
  try {
    const config = getSetting('budget_config') || { dailyBudget: 10.00, alertThreshold: 80 };
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/config', (req, res) => {
  try {
    setSetting('budget_config', req.body);
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