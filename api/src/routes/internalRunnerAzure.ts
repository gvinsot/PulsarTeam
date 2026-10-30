import express from 'express';
import type { AgentManager } from '../services/agentManager/index.js';
import { getBoardById } from '../services/database.js';
import { asyncHandler } from '../lib/asyncHandler.js';
import { getAzureCredentialsForAgent } from './azure.js';

/**
 * Internal endpoint consumed by CLI runners before each spawn to log the
 * agent's `az` CLI in with the service principal connected on the Azure CLI
 * plugin (runner-service backends/runner_azure_config.py). Mirrors
 * internalRunnerMcp.ts / internalRunnerInstructions.ts.
 *
 * Credentials are only released while the plugin is attached to the agent or
 * to its board: detaching the plugin logs the agent out on the next spawn,
 * even though the stored connection is kept for a later re-attach.
 *
 * Auth is handled by authenticateCoderApiKey in index.ts.
 */

export const AZURE_CLI_PLUGIN_ID = 'skill-azure-cli';

export function internalRunnerAzureRoutes(agentManager: AgentManager) {
  const router = express.Router();

  router.get(
    '/agents/:agentId',
    asyncHandler(async (req, res) => {
      const agent = agentManager.getById(req.params.agentId);
      if (!agent) {
        res.status(404).json({ error: 'Agent not found' });
        return;
      }
      const boardId: string | null = agent.boardId || null;
      const board = boardId ? await getBoardById(boardId) : null;
      const agentSkills: unknown[] = Array.isArray(agent.skills) ? agent.skills : [];
      const boardPlugins: unknown[] = Array.isArray(board?.plugins) ? board.plugins : [];
      const attached =
        agentSkills.includes(AZURE_CLI_PLUGIN_ID) || boardPlugins.includes(AZURE_CLI_PLUGIN_ID);

      const creds = attached ? getAzureCredentialsForAgent(agent.id, boardId) : null;
      if (!creds?.tenantId || !creds.clientId || !creds.clientSecret) {
        res.json({ configured: false });
        return;
      }
      res.json({
        configured: true,
        tenantId: creds.tenantId,
        clientId: creds.clientId,
        clientSecret: creds.clientSecret,
        subscriptionId: creds.subscriptionId || null,
      });
    })
  );

  return router;
}
