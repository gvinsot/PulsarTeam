import express from 'express';
import {
  getRunnerConfig,
  saveRunnerConfig,
  deleteRunnerConfig,
  getPool,
} from '../services/database.js';

/**
 * Internal endpoint consumed by the runner service to persist/restore a CLI
 * runner's on-disk config files across (stateless) restarts.
 *
 * The hermes runner, for example, keeps its provider/model/key in
 * ~/.hermes/{config.yaml,.env}. Those are set up inside the terminal but live
 * in the ephemeral agent HOME, so they vanish on restart. The runner watches
 * them and PUTs them here on change; on the next spawn it GETs and restores
 * them. The blob is encrypted at rest (see runnerConfigs.ts).
 *
 * Auth: shared CODER_API_KEY (authenticateCoderApiKey in index.ts).
 */
const SCOPE_TYPE = 'agent';
// Allowlist the runners that use this so we don't store arbitrary blobs.
const ALLOWED_RUNNERS = new Set(['hermes']);

export function internalRunnerConfigsRoutes() {
  const router = express.Router();

  router.get('/:runner/agents/:agentId', async (req, res) => {
    const { runner, agentId } = req.params;
    if (!ALLOWED_RUNNERS.has(runner)) { res.status(400).json({ error: 'unsupported runner' }); return; }
    if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
    const rec = await getRunnerConfig(runner, SCOPE_TYPE, agentId);
    if (!rec || !rec.files || Object.keys(rec.files).length === 0) {
      // getRunnerConfig also returns null on DB errors; probe so a transient
      // outage surfaces as a 5xx instead of an indistinguishable 'no config'.
      const pool = getPool();
      if (pool) {
        try {
          await pool.query(
            'SELECT 1 FROM runner_configs WHERE runner = $1 AND scope_type = $2 AND scope_id = $3',
            [runner, SCOPE_TYPE, agentId],
          );
        } catch {
          res.status(500).json({ error: 'db error' });
          return;
        }
      }
      res.status(404).json({ error: 'no config' });
      return;
    }
    res.json({ files: rec.files });
  });

  router.put('/:runner/agents/:agentId', async (req, res) => {
    const { runner, agentId } = req.params;
    if (!ALLOWED_RUNNERS.has(runner)) { res.status(400).json({ error: 'unsupported runner' }); return; }
    if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
    const files = (req.body || {}).files;
    if (!files || typeof files !== 'object' || Array.isArray(files)) {
      res.status(400).json({ error: 'files object required' });
      return;
    }
    // Only keep string→string entries (filename → content).
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(files)) {
      if (typeof k === 'string' && typeof v === 'string') clean[k] = v;
    }
    if (Object.keys(clean).length === 0) { res.status(400).json({ error: 'no valid files' }); return; }
    // A 2xx here stops the runner's retry/backoff loop, so never fake success:
    // saveRunnerConfig swallows DB errors (and no-ops without a pool) — answer
    // 5xx unless a read-back confirms the write actually landed.
    const pool = getPool();
    if (!pool) { res.status(503).json({ error: 'database unavailable' }); return; }
    await saveRunnerConfig(runner, SCOPE_TYPE, agentId, clean);
    const saved = await getRunnerConfig(runner, SCOPE_TYPE, agentId);
    if (!saved || JSON.stringify(saved.files) !== JSON.stringify(clean)) {
      res.status(500).json({ error: 'failed to persist config' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/:runner/agents/:agentId', async (req, res) => {
    const { runner, agentId } = req.params;
    if (!ALLOWED_RUNNERS.has(runner)) { res.status(400).json({ error: 'unsupported runner' }); return; }
    if (!agentId) { res.status(400).json({ error: 'agentId required' }); return; }
    await deleteRunnerConfig(runner, SCOPE_TYPE, agentId);
    res.json({ ok: true });
  });

  return router;
}
