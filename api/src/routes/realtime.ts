import express from 'express';
import { errorMessage } from '../lib/errors.js';
import { sessionUser } from '../middleware/auth.js';
import { checkAgentAccess } from '../lib/agentAccess.js';
import type { AgentManager } from '../services/agentManager/index.js';
import { asyncHandler } from '../lib/asyncHandler.js';

import { createVoiceSession } from '../services/voice/providers.js';
export {
  buildRealtimeSessionConfig,
  DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
  VOICE_TOOLS,
} from '../services/voice/config.js';

export function realtimeRoutes(agentManager: AgentManager) {
  const router = express.Router();

  router.post(
    '/token',
    asyncHandler(async (req, res) => {
      const { agentId } = req.body || {};
      if (!agentId) {
        return res.status(400).json({ error: 'agentId required' });
      }

      const agent = agentManager.agents.get(agentId);
      if (!agent) {
        return res.status(404).json({ error: 'Agent not found' });
      }
      // The agent id arrives in the request body. Minting a token for it spends
      // the agent's OpenAI key, ships its system instructions and swarm context
      // to the caller's browser, and hands over VOICE_TOOLS — delegate,
      // stop_agent, clear_all_chats — so this is 'edit', not 'read'.
      const user = sessionUser(req, res);
      if (!user) return;
      const access = await checkAgentAccess(agent, user, 'edit');
      if (!access.ok) {
        return res.status(access.status || 403).json({ error: access.error });
      }
      if (!agent.isVoice) {
        return res.status(400).json({ error: 'Agent is not a voice agent' });
      }

      // Resolve API key from the agent's LLM config.
      const llmConfig = agentManager.resolveLlmConfig(agent);
      const apiKey = llmConfig.apiKey;
      if (!apiKey) {
        return res.status(500).json({
          error:
            'No API key configured. Set an API key in the LLM Configuration assigned to this voice agent.',
        });
      }

      try {
        const instructions = await agentManager.buildVoiceInstructions(agentId);
        const session = await createVoiceSession({
          provider: llmConfig.provider,
          model: llmConfig.model,
          apiKey,
          voice: agent.voice || undefined,
          instructions,
        });
        res.setHeader('Cache-Control', 'no-store');
        return res.json(session);
      } catch (err) {
        console.error('Failed to create realtime token:', err);
        return res
          .status(500)
          .json({ error: errorMessage(err) || 'Failed to create realtime token' });
      }
    })
  );

  return router;
}
