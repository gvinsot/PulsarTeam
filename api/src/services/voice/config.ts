export const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2';
export const DEFAULT_REALTIME_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe';

const tool = (
  name: string,
  description: string,
  props: Record<string, { type: string; description: string; [k: string]: unknown }> = {},
  required = Object.keys(props)
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
  tool(
    'delegate',
    'Delegate a task to another agent in the swarm. Use this when the user asks you to assign work to a specific agent or when a task requires a specialist.',
    {
      agent_name: { type: 'string', description: 'Name of the target agent to delegate to' },
      task: { type: 'string', description: 'Detailed task description for the agent' },
    }
  ),
  tool(
    'ask',
    'Ask a quick question to another agent without creating a task. Use this for short questions that need a concise answer.',
    {
      agent_name: { type: 'string', description: 'Name of the agent to ask' },
      question: { type: 'string', description: 'The question to ask' },
    }
  ),
  tool(
    'assign_project',
    'Assign an agent to a project so they can use file and command tools on it.',
    {
      agent_name: { type: 'string', description: 'Name of the agent' },
      project_name: { type: 'string', description: 'Name of the project to assign' },
    }
  ),
  tool('get_project', 'Check which project an agent is currently assigned to.', {
    agent_name: { type: 'string', description: 'Name of the agent' },
  }),
  tool('list_agents', 'List all enabled agents with their current status, project, and role.'),
  tool(
    'agent_status',
    "Check a specific agent's status (busy/idle/error), project, pending tasks, and message count.",
    {
      agent_name: { type: 'string', description: 'Name of the agent to check' },
    }
  ),
  tool('get_available_agent', 'Get the first idle agent with the specified role.', {
    role: { type: 'string', description: 'Role to search for (e.g. "developer")' },
  }),
  tool('list_projects', 'List all available projects.'),
  tool(
    'clear_context',
    "Clear an agent's entire conversation history, giving them a fresh start.",
    {
      agent_name: { type: 'string', description: 'Name of the agent' },
    }
  ),
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
  model = DEFAULT_REALTIME_MODEL,
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
