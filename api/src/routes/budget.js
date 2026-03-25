import express from 'express';
import {
  recordTokenUsage, getTokenUsageByAgent, getTokenUsageTimeline,
  getTokenUsageSummary, getDailyTokenUsage, getSetting, setSetting
} from '../services/database.js';

const router = express.Router();

router.get('/summary', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 1;
    const summary = getTokenUsageSummary(days);
    const budgetConfig = getSetting('budget_config') || { dailyBudget: 0, alertThreshold: 80, tokenCosts: {} };
    res.json({ ...summary, budgetConfig });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/by-agent', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    res.json(getTokenUsageByAgent(days));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/timeline', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const groupBy = req.query.groupBy || 'day';
    res.json(getTokenUsageTimeline(days, groupBy));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/daily', (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    res.json(getDailyTokenUsage(days));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/config', (req, res) => {
  try {
    const config = getSetting('budget_config') || {
      dailyBudget: 10.00, alertThreshold: 80,
      tokenCosts: {
        'anthropic': { input: 3.0, output: 15.0 },
        'openai': { input: 2.5, output: 10.0 },
        'google': { input: 1.25, output: 5.0 },
        'default': { input: 2.0, output: 10.0 }
      }
    };
    res.json(config);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/config', (req, res) => {
  try {
    setSetting('budget_config', req.body);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/alerts', (req, res) => {
  try {
    const config = getSetting('budget_config') || { dailyBudget: 10.00, alertThreshold: 80 };
    const todaySummary = getTokenUsageSummary(1);
    const todayCost = todaySummary?.total_cost || 0;
    const alerts = [];
    if (config.dailyBudget > 0) {
      const pct = (todayCost / config.dailyBudget) * 100;
      if (pct >= 100) alerts.push({ level: 'critical', message: `Daily budget exceeded: $${todayCost.toFixed(4)} / $${config.dailyBudget.toFixed(2)} (${pct.toFixed(0)}%)` });
      else if (pct >= config.alertThreshold) alerts.push({ level: 'warning', message: `Approaching daily budget: $${todayCost.toFixed(4)} / $${config.dailyBudget.toFixed(2)} (${pct.toFixed(0)}%)` });
    }
    const byAgent = getTokenUsageByAgent(1);
    res.json({ alerts, todayCost, dailyBudget: config.dailyBudget, byAgent });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

export default router;