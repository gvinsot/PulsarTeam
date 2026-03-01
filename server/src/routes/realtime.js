import express from 'express';

const DELEGATE_TOOL = {
  type: 'function',
  name: 'delegate',
  description: 'Delegate a task to another agent in the swarm. Use this when the user asks you to assign work to a specific agent or when a task requires a specialist.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the target agent to delegate to' },
      task: { type: 'string', description: 'Detailed task description for the agent' }
    },
    required: ['agent_name', 'task']
  }
};

export function realtimeRoutes(agentManager) {
  const router = express.Router();

  // Create an ephemeral token for WebRTC connection to OpenAI Realtime API
  router.post('/token', async (req, res) => {
    const { agentId } = req.body;
    if (!agentId) return res.status(400).json({ error: 'agentId required' });

    const agent = agentManager.agents.get(agentId);
    if (!agent) return res.status(404).json({ error: 'Agent not found' });
    if (!agent.isVoice) return res.status(400).json({ error: 'Agent is not a voice agent' });

    // Use agent-level API key or fall back to server env
    const apiKey = agent.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'No OpenAI API key configured. Set OPENAI_API_KEY in .env or in agent settings.' });
    }

    try {
      // Build the voice instructions (system prompt with RAG, skills, agents, etc.)
      const instructions = agentManager.buildVoiceInstructions(agentId);
      const voice = agent.voice || 'alloy';
      const model = agent.model || 'gpt-realtime-1.5';

      // Request an ephemeral client secret from OpenAI
      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model,
            instructions,
            audio: {
              input: {
                turn_detection: { type: 'semantic_vad' }
              },
              output: { voice }
            },
            tools: [DELEGATE_TOOL]
          }
        })
      });

      if (!response.ok) {
        const error = await response.text();
        console.error('OpenAI Realtime token error:', error);
        return res.status(response.status).json({ error: `OpenAI API error: ${error}` });
      }

      const data = await response.json();
      res.json({
        token: data.client_secret?.value || data.value,
        expiresAt: data.client_secret?.expires_at || data.expires_at,
        voice,
        model
      });
    } catch (err) {
      console.error('Failed to create realtime token:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
