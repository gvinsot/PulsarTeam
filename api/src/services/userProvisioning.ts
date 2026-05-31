import { createBoard } from './database.js';
import { AGENT_TEMPLATES } from '../data/templates.js';

const DEFAULT_USER_WORKFLOW = {
  columns: [
    { id: 'todo', label: 'Todo', color: '#6b7280' },
    { id: 'in_progress', label: 'In Progress', color: '#3b82f6' },
    { id: 'done', label: 'Done', color: '#22c55e' },
  ],
  transitions: [
    {
      from: 'in_progress',
      trigger: 'on_enter',
      conditions: [],
      actions: [
        { type: 'run_agent', mode: 'decide', role: 'developer', instructions: 'Execute the task fully, and when you are finished, update the task to next state.' },
        { type: 'change_status', target: '__next__' },
      ],
    },
  ],
  version: 1,
};

let _agentManager: any = null;

export function setAgentManager(am: any) {
  _agentManager = am;
}

function findQwenLlmConfigId(agentManager: any): string | null {
  if (!agentManager?.llmConfigs) return null;
  for (const [id, config] of agentManager.llmConfigs) {
    if (config.name && config.name.toUpperCase().startsWith('QWEN')) {
      return id;
    }
  }
  return null;
}

export async function provisionNewUser(userId: string): Promise<void> {
  try {
    const board = await createBoard(userId, 'My Board', DEFAULT_USER_WORKFLOW, {});
    console.log(`✅ Created default board for user ${userId}: ${board.id}`);

    if (_agentManager) {
      const devTemplate = AGENT_TEMPLATES.find(t => t.id === 'developer');
      if (devTemplate) {
        const qwenConfigId = findQwenLlmConfigId(_agentManager);
        await _agentManager.create({
          name: devTemplate.name,
          role: devTemplate.role,
          description: devTemplate.description,
          instructions: devTemplate.instructions,
          icon: devTemplate.icon,
          color: devTemplate.color,
          temperature: devTemplate.temperature,
          maxTokens: devTemplate.maxTokens,
          template: devTemplate.id,
          ownerId: userId,
          boardId: board.id,
          runner: 'sandbox',
          ...(qwenConfigId ? { llmConfigId: qwenConfigId } : {}),
        });
        console.log(`✅ Created default developer agent for user ${userId} (runner=sandbox, llmConfig=${qwenConfigId || 'none'})`);
      }
    }
  } catch (err) {
    console.error(`Failed to provision new user ${userId}:`, err.message);
  }
}
