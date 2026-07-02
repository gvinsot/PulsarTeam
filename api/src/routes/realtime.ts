import express from 'express';

export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

const tool = (
  name: string,
  description: string,
  props: Record<string, { type: string; description: string; [k: string]: unknown }> = {},
  required = Object.keys(props),
) => ({
  type: 'function',
  name,
  description,
  parameters: {
    type: 'object',
    properties: props,
    ...(required.length ? { required } : {}),
  },
});

export const VOICE_TOOLS = [
  tool('delegate', 'Delegate a task to another agent in the swarm. Use this when the user asks you to assign work to a specific agent or when a task requires a specialist.', {
    agent_name: { type: 'string', description: 'Name of the target agent to delegate to' },
    task: { type: 'string', description: 'Detailed task description for the agent' },
  }),
  tool('ask', 'Ask a quick question to another agent without creating a task. Use this for short questions that need a concise answer.', {
    agent_name: { type: 'string', description: 'Name of the agent to ask' },
    question: { type: 'string', description: 'The question to ask' },
  }),
  tool('assign_project', 'Assign an agent to a project so they can use file and command tools on it.', {
    agent_name: { type: 'string', description: 'Name of the agent' },
    project_name: { type: 'string', description: 'Name of the project to assign' },
  }),
  tool('get_project', 'Check which project an agent is currently assigned to.', {
    agent_name: { type: 'string', description: 'Name of the agent' },
  }),
  tool('list_agents', 'List all enabled agents with their current status, project, and role.'),
  tool('agent_status', "Check a specific agent's status (busy/idle/error), project, pending tasks, and message count.", {
    agent_name: { type: 'string', description: 'Name of the agent to check' },
  }),
  tool('get_available_agent', 'Get the first idle agent with the specified role.', {
    role: { type: 'string', description: 'Role to search for (e.g. "developer")' },
  }),
  tool('list_projects', 'List all available projects.'),
  tool('clear_context', "Clear an agent's entire conversation history, giving them a fresh start.", {
    agent_name: { type: 'string', description: 'Name of the agent' },
  }),
  tool('rollback', "Remove the last X messages from an agent's conversation history.", {
    agent_name: { type: 'string', description: 'Name of the agent' },
    count: { type: 'integer', description: 'Number of messages to remove' },
  }),
  tool('stop_agent', "Stop an agent's current task immediately.", {
    agent_name: { type: 'string', description: 'Name of the agent to stop' },
  }),
  tool('clear_all_chats', "Clear ALL agents' conversation histories at once."),
  tool('clear_all_action_logs', "Clear ALL agents' action logs at once."),
];

export function buildRealtimeSessionConfig({
  instructions,
  voice = 'alloy',
  model = 'gpt-realtime-1.5',
  transcriptionModel = DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
}: { instructions?: string; voice?: string; model?: string; transcriptionModel?: string } = {}) {
  return {
    type: 'realtime',
    model,
    instructions,
    audio: {
      input: {
        turn_detection: {
          type: 'semantic_vad',
          create_response: true,
          interrupt_response: true,
        },
        transcription: {
          model: transcriptionModel,
        },
      },
      output: { voice },
    },
    tools: VOICE_TOOLS,
  };
}

export function realtimeRoutes(agentManager) {
  const router = express.Router();

  router.post('/token', async (req, res) => {
    const { agentId } = req.body || {};
    if (!agentId) {
      return res.status(400).json({ error: 'agentId required' });
    }

    const agent = agentManager.agents.get(agentId);
    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }
    if (!agent.isVoice) {
      return res.status(400).json({ error: 'Agent is not a voice agent' });
    }

    // Resolve API key from the agent's LLM config.
    const llmConfig = agentManager.resolveLlmConfig(agent);
    const apiKey = llmConfig.apiKey;
    if (!apiKey) {
      return res.status(500).json({
        error: 'No OpenAI API key configured. Set an API key in the LLM Configuration assigned to this voice agent.',
      });
    }

    try {
      const instructions = await agentManager.buildVoiceInstructions(agentId);
      const voice = agent.voice || process.env.OPENAI_REALTIME_VOICE || 'alloy';
      const DEFAULT_REALTIME_MODEL = 'gpt-realtime-1.5';
      const candidateModel = process.env.OPENAI_REALTIME_MODEL || llmConfig.model || '';
      const model = candidateModel.includes('realtime') ? candidateModel : DEFAULT_REALTIME_MODEL;
      const transcriptionModel =
        process.env.OPENAI_REALTIME_TRANSCRIBE_MODEL || DEFAULT_REALTIME_TRANSCRIPTION_MODEL;

      const session = buildRealtimeSessionConfig({
        instructions,
        voice,
        model,
        transcriptionModel,
      });

      const response = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ session }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('OpenAI Realtime token error:', errorText);
        return res.status(response.status).json({ error: `OpenAI API error: ${errorText}` });
      }

      const data = await response.json();
      return res.json({
        token: data.client_secret?.value || data.value,
        expiresAt: data.client_secret?.expires_at || data.expires_at,
        session,
        voice,
        model,
        transcriptionModel,
      });
    } catch (err) {
      console.error('Failed to create realtime token:', err);
      return res.status(500).json({ error: err.message || 'Failed to create realtime token' });
    }
  });

  return router;
}