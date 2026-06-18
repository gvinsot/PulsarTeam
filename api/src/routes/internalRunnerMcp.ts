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

      // CLI runners get exactly ONE MCP injected: the Pulsar Gateway. It always
      // carries task control (update_current_task, task_execution_complete) plus
      // list_mcps / call_mcp_tool, through which the agent discovers and invokes
      // every other MCP available to it or its board — even ones attached after
      // spawn. `exclusive` suppresses the old per-plugin static wiring so the
      // gateway is the single source of tools.
      const config = mcpManager.getClaudeMcpConfigForAgent(agent, skillManager, {
        forceServerIds: ['mcp-pulsar-gateway'],
        exclusive: true,
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
