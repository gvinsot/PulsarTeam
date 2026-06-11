import express from 'express';
import { recordTokenUsage, getPool } from '../services/database.js';

/**
 * Internal endpoint that the runner-service uses to report token usage
 * consumed by CLI runners (claudecode, opencode, codex, hermes, openclaw).
 *
 * The non-interactive paths (/v1/chat/completions) already return usage in
 * the HTTP response and the API records it directly. This endpoint covers
 * the interactive PTY path, where the CLI tool burns tokens against its
 * own LLM and the API otherwise has no visibility — without this hook the
 * budget screen reads zero for terminal-driven CLI agents.
 *
 * Auth is handled by authenticateCoderApiKey in index.ts.
 */
export function internalTokenUsageRoutes(agentManager) {
  const router = express.Router();

  router.post('/agents/:agentId', async (req, res) => {
    try {
      const agent = agentManager.getById(req.params.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      const body = req.body || {};
      const inputTokens = Math.max(0, Number(body.input_tokens) || 0);
      const outputTokens = Math.max(0, Number(body.output_tokens) || 0);
      const contextTokens = Math.max(0, Number(body.context_tokens) || 0);
      const costUsd = body.cost_usd != null ? Number(body.cost_usd) : 0;
      if (!inputTokens && !outputTokens && !costUsd) {
        return res.json({ recorded: false, reason: 'empty-usage' });
      }

      const provider = (body.provider || agent.provider || agent.runner || 'cli').toString();
      const model = (body.model || agent.model || 'unknown').toString();
      const userId = agent.ownerId || null;

      const recorded = await recordTokenUsage(
        agent.id,
        agent.name,
        provider,
        model,
        inputTokens,
        outputTokens,
        Number.isFinite(costUsd) ? costUsd : 0,
        userId,
        contextTokens,
      );

      // recordTokenUsage never throws; when a pool is configured but the
      // insert failed, answer 500 so the runner can retry instead of a
      // false {recorded:true} that silently drops the spend. Without a
      // pool (DB-less mode) recording is a no-op and still succeeds.
      if (!recorded && getPool()) {
        return res.status(500).json({ error: 'failed to record token usage' });
      }

      // Mirror onto the agent's running metrics so the dashboard reflects it
      // immediately, not just on the next budget cache refresh.
      try {
        agent.metrics = agent.metrics || {};
        agent.metrics.totalTokensIn = (agent.metrics.totalTokensIn || 0) + inputTokens;
        agent.metrics.totalTokensOut = (agent.metrics.totalTokensOut || 0) + outputTokens;
        agent.metrics.lastActiveAt = new Date().toISOString();
      } catch {
        // Metrics are best-effort; never fail the recording call.
      }

      res.json({ recorded: true, input_tokens: inputTokens, output_tokens: outputTokens, cost_usd: costUsd });
    } catch (err: any) {
      console.error('Failed to record CLI runner token usage:', err?.message);
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  return router;
}
