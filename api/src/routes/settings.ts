import express from 'express';
import { errorMessage } from '../lib/errors.js';
import { getSettings, updateSettings, getReminderConfig } from '../services/configManager.js';
import type { Settings } from '../services/configManager.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../lib/asyncHandler.js';

/**
 * Settings keys whose value is a credential and must not leave the server in
 * the clear for a non-admin caller.
 *
 * The general settings table is readable by every authenticated user on
 * purpose — `currency`, `jiraEnabled`, `ideasAgent` and the reminder values
 * drive the normal UI — but the same table also holds provider credentials
 * (today `sttApiKey` / `ttsApiKey`). The match is on the key NAME rather than
 * an explicit allow-list so a secret added by a later release is masked by
 * default instead of leaking until somebody remembers to extend this file.
 * `getSettings()` copies every row of the table into its result, including
 * keys that predate DEFAULTS, so name-matching is the only rule that covers
 * them all.
 */
const SECRET_SETTING_KEY = /(api[-_]?key|secret|token|password|passwd|credential)/i;

/** Same placeholder the LLM-config and plugin routes use for masked secrets. */
const MASK = '********';

/**
 * Return a copy of `settings` with every credential-shaped value replaced by
 * the mask for a non-admin caller. Admins get the real values — the admin
 * Settings tab reads them back to pre-fill its inputs and to run the STT/TTS
 * connection test.
 *
 * A masked key keeps the "is it configured at all?" signal (mask vs empty
 * string) without disclosing the value.
 */
function maskSecretSettings(settings: Settings, isAdmin: boolean): Settings {
  if (isAdmin) return settings;
  const masked: Settings = { ...settings };
  for (const key of Object.keys(masked)) {
    if (!SECRET_SETTING_KEY.test(key)) continue;
    const value = masked[key];
    masked[key] = typeof value === 'string' && value !== '' ? MASK : '';
  }
  return masked;
}

export function settingsRoutes() {
  const router = express.Router();

  // ── General settings ──────────────────────────────────────────────
  // Mounted with `authenticateToken` only (index.ts), so any authenticated
  // user of any tenant reaches this. Non-admins get the settings with the
  // credential-shaped values masked.
  router.get(
    '/',
    asyncHandler(async (req, res) => {
      try {
        const settings = await getSettings();
        res.json(maskSecretSettings(settings, req.user?.role === 'admin'));
      } catch {
        res.status(500).json({ error: 'Internal server error' });
      }
    })
  );

  router.put(
    '/',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      try {
        // Never let the mask itself be written back over a real credential: a
        // client that round-trips a masked read would otherwise wipe the key.
        // Dropping the entry means "leave this setting unchanged".
        const patch: Record<string, unknown> = { ...(req.body || {}) };
        for (const key of Object.keys(patch)) {
          if (SECRET_SETTING_KEY.test(key) && patch[key] === MASK) delete patch[key];
        }
        const settings = await updateSettings(patch);
        res.json(settings);
      } catch (err) {
        res.status(500).json({ error: errorMessage(err) });
      }
    })
  );

  // ── Reminder configuration ──────────────────────────────────────
  router.get(
    '/reminders',
    asyncHandler(async (_req, res) => {
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
    })
  );

  router.put(
    '/reminders',
    requireRole('admin'),
    asyncHandler(async (req, res) => {
      try {
        const patch: Record<string, string> = {};
        const { intervalMinutes, maxReminders, cooldownMinutes } = req.body || {};
        if (intervalMinutes !== undefined)
          patch.taskReminderIntervalMinutes = String(
            Math.max(1, parseInt(intervalMinutes, 10) || 10)
          );
        if (maxReminders !== undefined)
          patch.taskReminderMaxCount = String(Math.max(1, parseInt(maxReminders, 10) || 12));
        if (cooldownMinutes !== undefined)
          patch.taskReminderCooldownMinutes = String(
            Math.max(0, parseInt(cooldownMinutes, 10) || 0)
          );
        await updateSettings(patch);
        const config = await getReminderConfig();
        res.json({
          intervalMinutes: config.intervalMinutes,
          maxReminders: config.maxReminders,
          cooldownMinutes: config.cooldownMinutes,
          envOverride: !!process.env.TASK_REMINDER_INTERVAL_MINUTES,
        });
      } catch (err) {
        res.status(500).json({ error: errorMessage(err) });
      }
    })
  );

  return router;
}
