import express from 'express';

export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

const DELEGATE_TOOL = {
  type: 'function',
  name: 'delegate',
  description:
    'Delegate a task to another agent in the swarm. Use this when the user asks you to assign work to a specific agent or when a task requires a specialist.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the target agent to delegate to' },
      task: { type: 'string', description: 'Detailed task description for the agent' },
    },
    required: ['agent_name', 'task'],
  },
};

const ASK_TOOL = {
  type: 'function',
  name: 'ask',
  description:
    'Ask a quick question to another agent without creating a task. Use this for short questions that need a concise answer.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent to ask' },
      question: { type: 'string', description: 'The question to ask' },
    },
    required: ['agent_name', 'question'],
  },
};

const ASSIGN_PROJECT_TOOL = {
  type: 'function',
  name: 'assign_project',
  description: 'Assign an agent to a project so they can use file and command tools on it.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent' },
      project_name: { type: 'string', description: 'Name of the project to assign' },
    },
    required: ['agent_name', 'project_name'],
  },
};

const GET_PROJECT_TOOL = {
  type: 'function',
  name: 'get_project',
  description: 'Check which project an agent is currently assigned to.',
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent' },
    },
    required: ['agent_name'],
  },
};

const LIST_AGENTS_TOOL = {
  type: 'function',
  name: 'list_agents',
  description: 'List all enabled agents with their current status, project, and role.',
  parameters: { type: 'object', properties: {} },
};

const AGENT_STATUS_TOOL = {
  type: 'function',
  name: 'agent_status',
  description: "Check a specific agent's status (busy/idle/error), project, pending tasks, and message count.",
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent to check' },
    },
    required: ['agent_name'],
  },
};

const GET_AVAILABLE_AGENT_TOOL = {
  type: 'function',
  name: 'get_available_agent',
  description: 'Get the first idle agent with the specified role.',
  parameters: {
    type: 'object',
    properties: {
      role: { type: 'string', description: 'Role to search for (e.g. "developer")' },
    },
    required: ['role'],
  },
};

const LIST_PROJECTS_TOOL = {
  type: 'function',
  name: 'list_projects',
  description: 'List all available projects.',
  parameters: { type: 'object', properties: {} },
};

const CLEAR_CONTEXT_TOOL = {
  type: 'function',
  name: 'clear_context',
  description: "Clear an agent's entire conversation history, giving them a fresh start.",
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent' },
    },
    required: ['agent_name'],
  },
};

const ROLLBACK_TOOL = {
  type: 'function',
  name: 'rollback',
  description: "Remove the last X messages from an agent's conversation history.",
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent' },
      count: { type: 'integer', description: 'Number of messages to remove' },
    },
    required: ['agent_name', 'count'],
  },
};

const STOP_AGENT_TOOL = {
  type: 'function',
  name: 'stop_agent',
  description: "Stop an agent's current task immediately.",
  parameters: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Name of the agent to stop' },
    },
    required: ['agent_name'],
  },
};

const CLEAR_ALL_CHATS_TOOL = {
  type: 'function',
  name: 'clear_all_chats',
  description: "Clear ALL agents' conversation histories at once.",
  parameters: { type: 'object', properties: {} },
};

const CLEAR_ALL_ACTION_LOGS_TOOL = {
  type: 'function',
  name: 'clear_all_action_logs',
  description: "Clear ALL agents' action logs at once.",
  parameters: { type: 'object', properties: {} },
};

export const VOICE_TOOLS = [
  DELEGATE_TOOL,
  ASK_TOOL,
  ASSIGN_PROJECT_TOOL,
  GET_PROJECT_TOOL,
  LIST_AGENTS_TOOL,
  AGENT_STATUS_TOOL,
  GET_AVAILABLE_AGENT_TOOL,
  LIST_PROJECTS_TOOL,
  CLEAR_CONTEXT_TOOL,
  ROLLBACK_TOOL,
  STOP_AGENT_TOOL,
  CLEAR_ALL_CHATS_TOOL,
  CLEAR_ALL_ACTION_LOGS_TOOL,
];

export function buildRealtimeSessionConfig({
  instructions,
  voice = 'alloy',
  model = 'gpt-realtime-1.5',
  transcriptionModel = DEFAULT_REALTIME_TRANSCRIPTION_MODEL,
} = {}) {
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

    // Resolve API key and model from LLM config (llmConfigId) when available,
    // falling back to agent-level fields and environment variables.
    const llmConfig = agentManager.resolveLlmConfig(agent);
    const apiKey = llmConfig.apiKey || agent.apiKey || process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({
        error: 'No OpenAI API key configured. Set OPENAI_API_KEY in .env or in agent settings.',
      });
    }

    try {
      const instructions = agentManager.buildVoiceInstructions(agentId);
      const voice = agent.voice || process.env.OPENAI_REALTIME_VOICE || 'alloy';
      const model = process.env.OPENAI_REALTIME_MODEL || llmConfig.model || agent.model || 'gpt-realtime-1.5';
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