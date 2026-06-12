import express from 'express';
import { getSettings, updateSettings, getReminderConfig } from '../services/configManager.js';
import { requireRole } from '../middleware/auth.js';

export function settingsRoutes() {
  const router = express.Router();

  // ── General settings ──────────────────────────────────────────────
  router.get('/', async (req, res) => {
    try {
      const settings = await getSettings();
      res.json(settings);
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/', requireRole('admin'), async (req, res) => {
    try {
      const settings = await updateSettings(req.body || {});
      res.json(settings);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Reminder configuration ──────────────────────────────────────
  router.get('/reminders', async (req, res) => {
    try {
      const config = await getReminderConfig();
      res.json({
        intervalMinutes: config.intervalMinutes,
        maxReminders: config.maxReminders,
        cooldownMinutes: config.cooldownMinutes,
        envOverride: !!process.env.TASK_REMINDER_INTERVAL_MINUTES,
      });
    } catch {
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.put('/reminders', requireRole('admin'), async (req, res) => {
    try {
      const patch: Record<string, string> = {};
      const { intervalMinutes, maxReminders, cooldownMinutes } = req.body || {};
      if (intervalMinutes !== undefined) patch.taskReminderIntervalMinutes = String(Math.max(1, parseInt(intervalMinutes, 10) || 10));
      if (maxReminders !== undefined) patch.taskReminderMaxCount = String(Math.max(1, parseInt(maxReminders, 10) || 12));
      if (cooldownMinutes !== undefined) patch.taskReminderCooldownMinutes = String(Math.max(0, parseInt(cooldownMinutes, 10) || 0));
      await updateSettings(patch);
      const config = await getReminderConfig();
      res.json({
        intervalMinutes: config.intervalMinutes,
        maxReminders: config.maxReminders,
        cooldownMinutes: config.cooldownMinutes,
        envOverride: !!process.env.TASK_REMINDER_INTERVAL_MINUTES,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
