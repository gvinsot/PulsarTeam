import express from 'express';
import { getLlmConfig, getAllLlmConfigs } from '../services/database.js';
import { getSettings } from '../services/configManager.js';

// Providers treated as "local" self-hosted models that multi-provider CLI
// runners (opencode/hermes/openclaw/aider) inject into their on-disk config so
// they're reachable — and, for opencode, switchable — inside the terminal.
const LOCAL_PROVIDERS = new Set(['vllm', 'ollama']);

/**
 * Internal endpoints consumed by the runner service:
 *
 *   GET /claude-fallback
 *     Resolve the "fallback LLM" used when the Claude paid-plan interactive
 *     driver hits a Y/N or list prompt it has no hardcoded answer for.
 *
 *   GET /agents/:agentId
 *     Resolve the agent's selected provider/model/apiKey/endpoint so a CLI
 *     runner can re-hydrate it after a restart. The per-agent LLM config is
 *     normally pushed via the X-LLM-Config header, but that only lives in the
 *     runner's in-memory cache — lost on restart. This lets the runner rebuild
 *     it (see runner-service runner_llm_config.py), resolving the agent's
 *     named llmConfigId via resolveLlmConfig.
 *
 * The runner authenticates with the shared CODER_API_KEY.
 *
 * Response (200):
 *   { configured: true, endpoint, apiKey, model, provider }
 * Response when nothing is selected:
 *   { configured: false }
 */
export function internalRunnerLlmRoutes(agentManager) {
  const router = express.Router();

  router.get('/local-models', async (_req, res) => {
    try {
      const all = await getAllLlmConfigs();
      const models = (all || [])
        .filter((c: any) => LOCAL_PROVIDERS.has((c.provider || '').toLowerCase()))
        .map((c: any) => ({
          id: c.id,
          name: c.name || '',
          provider: (c.provider || '').toLowerCase(),
          model: c.model || '',
          endpoint: c.endpoint || '',
          apiKey: c.apiKey || '',
        }))
        .filter((c: any) => c.model);
      res.json({ models });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  router.get('/agents/:agentId', (req, res) => {
    try {
      const agent = agentManager.getById(req.params.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const cfg = agentManager.resolveLlmConfig(agent) || {};
      const model = (cfg.model || '').toString().trim();
      // No model resolved (no named config) → let the runner keep its
      // RUNNER_MODEL default instead of pinning an empty model.
      if (!model) return res.json({ configured: false });

      res.json({
        configured: true,
        provider: cfg.provider || '',
        model,
        apiKey: cfg.apiKey || '',
        endpoint: cfg.endpoint || '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  router.get('/claude-fallback', async (_req, res) => {
    try {
      const settings = await getSettings();
      const id = (settings.claudeFallbackLlmConfigId || '').toString().trim();
      if (!id) return res.json({ configured: false });

      const cfg = await getLlmConfig(id);
      if (!cfg) {
        return res.json({ configured: false, error: 'configured-id-missing' });
      }

      res.json({
        configured: true,
        endpoint: cfg.endpoint || '',
        apiKey: cfg.apiKey || '',
        model: cfg.model || '',
        provider: cfg.provider || '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  return router;
}
