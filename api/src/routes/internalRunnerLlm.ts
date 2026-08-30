import express from 'express';
import { getLlmConfig, getAllLlmConfigs } from '../services/database.js';
import { getSettings } from '../services/configManager.js';
import { errorMessage } from '../lib/errors.js';
import type { Agent } from '../services/database/agents.js';
import type { AgentManager } from '../services/agentManager/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';

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
export function internalRunnerLlmRoutes(agentManager: AgentManager) {
  const router = express.Router();

  /**
   * The agent this request is being made on behalf of, if the caller names one
   * (`?agentId=` or `X-Agent-Id:`). CODER_API_KEY is a single shared secret
   * held by every runner container, so this is a scoping hint, not proof of
   * identity — it is only ever used to NARROW what is returned.
   */
  function requestedAgentId(req: express.Request): string {
    const header = req.headers['x-agent-id'];
    if (typeof header === 'string' && header.trim()) return header.trim();
    const query = req.query.agentId;
    if (typeof query === 'string' && query.trim()) return query.trim();
    return '';
  }

  /**
   * The operator's local (vLLM/Ollama) models, for the multi-provider CLI
   * runners that inject them into their on-disk config.
   *
   * Credentials are scoped to the caller: an `apiKey` is returned ONLY for the
   * config the named agent is actually configured to use — the same secret the
   * runner already receives for that agent through the X-LLM-Config header and
   * `/agents/:agentId` below, so this discloses nothing new. Every other entry
   * comes back with an empty `apiKey`, and a caller that names no agent gets
   * the catalog with no credentials at all.
   *
   * Before this scoping the route handed EVERY local config's key to any
   * holder of CODER_API_KEY — which, since the shared key is readable from
   * inside a runner container, meant one tenant's coding agent could harvest
   * every tenant's self-hosted model credentials.
   *
   * `llm_configs` rows carry neither a board nor an owner, so there is no
   * per-tenant ownership to filter the catalog itself on (see the report).
   */
  router.get(
    '/local-models',
    asyncHandler(async (req, res) => {
      try {
        const agentId = requestedAgentId(req);
        let entitledConfigId = '';
        if (agentId) {
          const agent: Agent | null = agentManager.getById(agentId);
          if (!agent) {
            res.status(404).json({ error: 'Agent not found' });
            return;
          }
          entitledConfigId = agent.llmConfigId || '';
        }

        const all = await getAllLlmConfigs();
        const models = (all || [])
          .filter(c => LOCAL_PROVIDERS.has((c.provider || '').toLowerCase()))
          .map(c => ({
            id: c.id,
            name: c.name || '',
            provider: (c.provider || '').toLowerCase(),
            model: c.model || '',
            endpoint: c.endpoint || '',
            apiKey: entitledConfigId !== '' && c.id === entitledConfigId ? c.apiKey || '' : '',
          }))
          .filter(c => c.model);
        res.json({ models });
      } catch (err) {
        res.status(500).json({ error: errorMessage(err) });
      }
    })
  );

  router.get('/agents/:agentId', (req, res) => {
    try {
      const agent = agentManager.getById(req.params.agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const cfg = agentManager.resolveLlmConfig(agent) || {};
      const model = (cfg.model || '').toString().trim();
      // No model resolved (no named config) → let the runner keep its
      // RUNNER_MODEL default instead of pinning an empty model.
      if (!model) {
        res.json({ configured: false });
        return;
      }

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

  router.get(
    '/claude-fallback',
    asyncHandler(async (_req, res) => {
      try {
        const settings = await getSettings();
        const id = (settings.claudeFallbackLlmConfigId || '').toString().trim();
        if (!id) {
          res.json({ configured: false });
          return;
        }

        const cfg = await getLlmConfig(id);
        if (!cfg) {
          res.json({ configured: false, error: 'configured-id-missing' });
          return;
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
    })
  );

  return router;
}
