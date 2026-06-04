import express from 'express';

/**
 * Internal endpoint consumed by CLI runners to materialize the agent's plugin
 * MCP wiring into the runner's native CLI config before spawning.
 *
 * Auth is handled by authenticateCoderApiKey in index.ts.
 */
export function internalRunnerMcpRoutes(agentManager, skillManager, mcpManager) {
  const router = express.Router();

  router.get('/agents/:agentId', async (req, res) => {
    try {
      const agent = agentManager.getById(req.params.agentId);
      if (!agent) return res.status(404).json({ error: 'Agent not found' });

      // CLI runners always get the Swarm API MCP injected automatically — it
      // carries task_execution_complete (how a CLI agent signals it is done) and
      // the swarm-inspection tools — even when no plugin/MCP is explicitly
      // assigned to the agent.
      const config = mcpManager.getClaudeMcpConfigForAgent(agent, skillManager, {
        forceServerIds: ['mcp-swarm-api'],
      });
      res.json({
        configured: Object.keys(config.mcpServers || {}).length > 0,
        ...config,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'internal error' });
    }
  });

  return router;
}
