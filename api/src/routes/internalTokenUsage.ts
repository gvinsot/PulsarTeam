import express from 'express';
import { recordTokenUsage, getPool } from '../services/database.js';
import type { AgentManager } from '../services/agentManager/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';

/**
 * Internal endpoint that the runner-service uses to report token usage
 * consumed by CLI runners (claudecode, opencode, codex, hermes, openclaw).
 *
 * /v1/chat/completions — the only runner route this API calls for a chat turn
 * — returns usage in its HTTP response and is recorded by the provider
 * pipeline in agentManager.chat. The runner must NOT report those turns here
 * as well; doing so billed every CLI-runner turn twice.
 *
 * What this endpoint covers is the interactive PTY path (a task injected into
 * the agent's shared terminal, which produces no HTTP usage block at all —
 * the runner tails the CLI's own session transcripts, see usage_watcher.py)
 * plus the runner routes nothing on this side accounts for (/execute,
 * /stream, /v1/completions). Without it the budget screen reads zero for
 * terminal-driven CLI agents.
 *
 * Auth is handled by authenticateCoderApiKey in index.ts.
 */
export function internalTokenUsageRoutes(agentManager: AgentManager) {
  const router = express.Router();

  router.post(
    '/agents/:agentId',
    asyncHandler(async (req, res) => {
      try {
        const agent = agentManager.getById(req.params.agentId);
        if (!agent) {
          res.status(404).json({ error: 'Agent not found' });
          return;
        }

        const body = req.body || {};
        const inputTokens = Math.max(0, Number(body.input_tokens) || 0);
        const outputTokens = Math.max(0, Number(body.output_tokens) || 0);
        const contextTokens = Math.max(0, Number(body.context_tokens) || 0);
        const costUsd = body.cost_usd != null ? Number(body.cost_usd) : 0;
        if (!inputTokens && !outputTokens && !costUsd) {
          res.json({ recorded: false, reason: 'empty-usage' });
          return;
        }

        const provider = (body.provider || agent.runner || 'cli').toString();
        const model = (body.model || 'unknown').toString();
        const userId = agent.ownerId || null;
        const idempotencyKey = (body.idempotency_key || '').toString().trim() || null;

        // CLI runners report raw token counts: the CLI bills against a
        // subscription and never tells us a price. Falling back to the stored
        // 0 would make every terminal-driven turn free on the budget screen,
        // so price it from the agent's LLM config like the chat path does.
        const price =
          Number.isFinite(costUsd) && costUsd > 0
            ? costUsd
            : agentManager._resolveUsageCost(agent, inputTokens, outputTokens);

        const recorded = await recordTokenUsage(
          agent.id,
          agent.name,
          provider,
          model,
          inputTokens,
          outputTokens,
          price,
          userId,
          contextTokens,
          idempotencyKey
        );

        // recordTokenUsage never throws; when a pool is configured but the
        // insert failed, answer 500 so the runner can retry instead of a
        // false {recorded:true} that silently drops the spend. Without a
        // pool (DB-less mode) recording is a no-op and still succeeds.
        if (!recorded && getPool()) {
          res.status(500).json({ error: 'failed to record token usage' });
          return;
        }

        // Mirror onto the agent's running metrics so the dashboard reflects it
        // immediately, not just on the next budget cache refresh.
        try {
          agent.metrics = agent.metrics || {};
          agent.metrics.totalTokensIn = (agent.metrics.totalTokensIn || 0) + inputTokens;
          agent.metrics.totalTokensOut = (agent.metrics.totalTokensOut || 0) + outputTokens;
          agent.metrics.lastActiveAt = new Date().toISOString();
          // Push a refreshed snapshot to the agents view so CLI-runner token
          // counts update live. The emit re-enriches from token_usage_log (this
          // record is already persisted above), keeping the card in sync with
          // the budget dashboard.
          agentManager.wsEmitter?.agentUpdated?.(agent.id);
        } catch {
          // Metrics are best-effort; never fail the recording call.
        }

        res.json({
          recorded: true,
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cost_usd: price,
        });
      } catch (err: any) {
        console.error('Failed to record CLI runner token usage:', err?.message);
        res.status(500).json({ error: err?.message || 'internal error' });
      }
    })
  );

  return router;
}
