import { Router, json } from 'express';
import { authenticateAuthBrowserWorker } from '../middleware/authBrowserWorker.js';
import { browserSessionSnapshot, browserSessionDelete } from '../schemas/authBrowserSessions.js';
import {
  loadBrowserSessions,
  saveBrowserSession,
  deleteBrowserSession,
  loadBrowserCredentials,
} from '../services/database/authBrowserSessions.js';
import { asyncHandler } from '../lib/asyncHandler.js';

export function authBrowserSessionRoutes() {
  const router = Router();
  router.use(authenticateAuthBrowserWorker, json({ limit: '5mb' }));
  // Never infer this namespace from a caller-controlled hostname. Fail closed
  // on installations that have not explicitly pinned their deployment.
  router.use((_req, res, next) => {
    if (!process.env.APP_ENVIRONMENT?.trim()) {
      res.status(503).json({ error: 'Browser persistence environment is not configured' });
      return;
    }
    next();
  });
  const environment = () => (process.env.APP_ENVIRONMENT || '').trim().toLowerCase();
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      try {
        res.json({ sessions: await loadBrowserSessions(environment()) });
      } catch {
        res.status(503).json({ error: 'Browser session storage unavailable' });
      }
    })
  );
  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = browserSessionSnapshot.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid browser session snapshot' });
        return;
      }
      try {
        await saveBrowserSession(environment(), parsed.data);
        res.sendStatus(204);
      } catch {
        res.status(503).json({ error: 'Browser session storage unavailable' });
      }
    })
  );
  router.delete(
    '/',
    asyncHandler(async (req, res) => {
      const parsed = browserSessionDelete.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid browser session key' });
        return;
      }
      try {
        await deleteBrowserSession(environment(), parsed.data.key);
        res.sendStatus(204);
      } catch {
        res.status(503).json({ error: 'Browser session storage unavailable' });
      }
    })
  );
  // Sign-in credentials of one session, for the worker's automatic re-login
  // only. POST so the key never sits in a URL or access log.
  router.post(
    '/credentials',
    asyncHandler(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      const parsed = browserSessionDelete.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid browser session key' });
        return;
      }
      try {
        res.json({ credentials: await loadBrowserCredentials(environment(), parsed.data.key) });
      } catch {
        res.status(503).json({ error: 'Browser credential storage unavailable' });
      }
    })
  );
  return router;
}
