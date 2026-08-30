import express from 'express';
import type { AgentManager } from '../services/agentManager/index.js';

/**
 * Internal endpoint consumed by CLI runners to materialize the agent's base
 * instructions into the runner's native global instructions file (CLAUDE.md /
 * AGENTS.md) before spawning the CLI. Mirrors internalRunnerMcp.ts.
 *
 * Returns the "complet sans protocole chat" instructions built by
 * agentManager.buildRunnerInstructions() — identity, collaboration context,
 * reference docs, plugin instructions, credentials, relevant tasks and project
 * context, but NOT the in-house @-tool text protocol (CLI runners use their
 * own native tools + real MCP).
 *
 * Auth is handled by authenticateCoderApiKey in index.ts.
 */
export function internalRunnerInstructionsRoutes(agentManager: AgentManager) {
  const router = express.Router();

  router.get('/agents/:agentId', async (req, res) => {
    try {
      const agent = agentManager.getById(req.params.agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }

      const instructions = await agentManager.buildRunnerInstructions(req.params.agentId);
      res.json({
        configured: Boolean(instructions && instructions.trim()),
        instructions: instructions || '',
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  return router;
}
